import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadAgentEvalCases, scoreAgentTranscript } from "./agent-eval.js";
import { TelemetryStore } from "./telemetry-store.js";

const HARNESS_RUN_FILE = "harness-run.json";
const DEFAULT_HARNESS_TIMEOUT_MS = 10 * 60 * 1000;

export async function runHarnessEval(options = {}) {
  const harness = normaliseHarnessName(options.harness);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const prepare = await prepareHarnessEval({
    ...options,
    harness
  });
  const runs = [];

  for (const runCase of prepare.cases) {
    runs.push(await runHarnessCase(harness, runCase, options));
  }

  const score = options.noScore
    ? undefined
    : await scoreHarnessEval({
        runPath: prepare.runFile,
        source: options.scoreSource ?? "auto",
        telemetryLimit: options.telemetryLimit
      });

  return {
    type: "harness-run",
    harness,
    dryRun: options.dryRun === true,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    runFile: prepare.runFile,
    outDir: prepare.outDir,
    caseCount: prepare.caseCount,
    summary: {
      total: runs.length,
      passedProcess: runs.filter((result) => result.exitCode === 0).length,
      failedProcess: runs.filter((result) => result.exitCode !== 0).length,
      scoredSuccess: score?.summary?.scoredSuccess,
      strictSuccess: score?.summary?.strictSuccess
    },
    runs,
    score
  };
}

export async function prepareHarnessEval(options = {}) {
  const cases = await loadAgentEvalCases(options.caseFiles ?? []);
  const outDir = path.resolve(options.outDir ?? path.join("reports", "harness-run"));
  const harness = options.harness ?? "generic";
  const createdAt = new Date().toISOString();
  const run = {
    type: "harness",
    version: 1,
    harness,
    createdAt,
    outDir,
    caseCount: cases.length,
    cases: []
  };

  await fs.mkdir(outDir, { recursive: true });

  for (const testCase of cases) {
    const caseDir = path.join(outDir, safeFileName(testCase.id));
    const registryDb = path.resolve(options.registryDb ?? path.join(caseDir, "registry.sqlite"));
    const telemetryDb = path.resolve(options.telemetryDb ?? path.join(caseDir, "telemetry.sqlite"));
    const logFile = path.resolve(options.logFile ?? path.join(caseDir, "relay.jsonl"));
    const transcriptFile = path.resolve(path.join(caseDir, "transcript.json"));
    const promptFile = path.resolve(path.join(caseDir, "prompt.md"));
    const mcpConfigFile = path.resolve(path.join(caseDir, "mcp-config.json"));
    const caseJsonFile = path.resolve(path.join(caseDir, "case.json"));
    const relayConfig = relayMcpConfig({
      ...options,
      registryDb,
      telemetryDb,
      logFile
    });

    await fs.mkdir(caseDir, { recursive: true });
    await fs.writeFile(caseJsonFile, `${JSON.stringify(testCase, null, 2)}\n`, "utf8");
    await fs.writeFile(mcpConfigFile, `${JSON.stringify(relayConfig, null, 2)}\n`, "utf8");
    await fs.writeFile(
      promptFile,
      harnessPrompt({
        testCase,
        harness,
        transcriptFile
      }),
      "utf8"
    );

    run.cases.push({
      id: testCase.id,
      goal: testCase.goal,
      siteUrl: testCase.siteUrl,
      seedSites: testCase.seedSites ?? [],
      resetUrl: testCase.resetUrl,
      successCriteria: testCase.successCriteria,
      caseDir,
      caseJsonFile,
      promptFile,
      mcpConfigFile,
      transcriptFile,
      registryDb,
      telemetryDb,
      logFile
    });
  }

  const runFile = path.join(outDir, HARNESS_RUN_FILE);
  await fs.writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(outDir, "README.md"), harnessReadme(run), "utf8");

  return {
    ...run,
    runFile
  };
}

export async function scoreHarnessEval(options = {}) {
  const run = await loadHarnessRun(options.runPath);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = [];

  for (const runCase of run.cases) {
    const testCase = await loadCase(runCase);
    results.push(await scoreHarnessCase(testCase, runCase, options));
  }

  return {
    type: "harness-score",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    harness: run.harness,
    runFile: run.runFile ?? resolveRunFile(options.runPath),
    caseCount: results.length,
    summary: summarizeHarnessResults(results),
    results
  };
}

async function runHarnessCase(harness, runCase, options) {
  const invocation = await harnessInvocation(harness, runCase, options);
  await fs.writeFile(
    path.join(runCase.caseDir, "runner-command.sh"),
    `${shellCommand(invocation)}\n`,
    "utf8"
  );

  if (options.dryRun) {
    return {
      id: runCase.id,
      status: "dry_run",
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      commandLine: shellCommand(invocation),
      stdoutFile: invocation.stdoutFile,
      stderrFile: invocation.stderrFile,
      exitCode: 0
    };
  }

  return runProcess(invocation, {
    timeoutMs: options.harnessTimeoutMs ?? DEFAULT_HARNESS_TIMEOUT_MS
  });
}

async function harnessInvocation(harness, runCase, options) {
  const prompt = await fs.readFile(runCase.promptFile, "utf8");
  const relayConfig = JSON.parse(await fs.readFile(runCase.mcpConfigFile, "utf8"));
  const stdoutFile = path.join(runCase.caseDir, `${harness}-stdout.txt`);
  const stderrFile = path.join(runCase.caseDir, `${harness}-stderr.txt`);

  switch (harness) {
    case "codex":
      return codexInvocation(runCase, relayConfig, options, prompt, stdoutFile, stderrFile);
    case "claude":
      return claudeInvocation(runCase, options, prompt, stdoutFile, stderrFile);
    case "gemini":
      await writeGeminiSettings(runCase, relayConfig);
      return geminiInvocation(runCase, options, prompt, stdoutFile, stderrFile);
    default:
      throw new Error(`Unsupported harness runner: ${harness}`);
  }
}

function codexInvocation(runCase, relayConfig, options, prompt, stdoutFile, stderrFile) {
  const server = relayConfig.mcpServers["webmcp-relay"];
  const command = options.runnerCommand ?? "npx";
  const args = [
    ...npxPrefix(command, options.runnerPackage ?? "@openai/codex@latest"),
    "exec",
    "-C",
    process.cwd(),
    "--sandbox",
    options.sandbox ?? "danger-full-access",
    "--ask-for-approval",
    options.approvalPolicy ?? "never",
    "-c",
    `mcp_servers.webmcp-relay.command=${tomlString(server.command)}`,
    "-c",
    `mcp_servers.webmcp-relay.args=${tomlStringArray(server.args)}`
  ];

  if (options.model) args.push("--model", options.model);
  if (options.codexJson) args.push("--json");
  args.push("-");

  return {
    harness: "codex",
    caseId: runCase.id,
    command,
    args,
    cwd: runCase.caseDir,
    input: prompt,
    stdoutFile,
    stderrFile
  };
}

function claudeInvocation(runCase, options, prompt, stdoutFile, stderrFile) {
  const args = [
    "--mcp-config",
    runCase.mcpConfigFile,
    "--strict-mcp-config",
    "--permission-mode",
    options.permissionMode ?? "bypassPermissions",
    "--output-format",
    options.outputFormat ?? "json",
    "--print",
    prompt
  ];

  if (options.model) args.unshift("--model", options.model);

  return {
    harness: "claude",
    caseId: runCase.id,
    command: options.runnerCommand ?? "claude",
    args,
    cwd: runCase.caseDir,
    stdoutFile,
    stderrFile
  };
}

function geminiInvocation(runCase, options, prompt, stdoutFile, stderrFile) {
  const command = options.runnerCommand ?? "npx";
  const args = [
    ...npxPrefix(command, options.runnerPackage ?? "@google/gemini-cli@latest"),
    "--prompt",
    prompt,
    "--skip-trust",
    "--approval-mode",
    options.approvalMode ?? "yolo",
    "--allowed-mcp-server-names",
    "webmcp-relay",
    "--output-format",
    options.outputFormat ?? "json"
  ];

  if (options.model) args.push("--model", options.model);

  return {
    harness: "gemini",
    caseId: runCase.id,
    command,
    args,
    cwd: runCase.caseDir,
    stdoutFile,
    stderrFile
  };
}

function npxPrefix(command, packageName) {
  return path.basename(command) === "npx" ? ["-y", packageName] : [];
}

async function writeGeminiSettings(runCase, relayConfig) {
  const geminiDir = path.join(runCase.caseDir, ".gemini");
  await fs.mkdir(geminiDir, { recursive: true });
  await fs.writeFile(
    path.join(geminiDir, "settings.json"),
    `${JSON.stringify(relayConfig, null, 2)}\n`,
    "utf8"
  );
}

async function runProcess(invocation, { timeoutMs }) {
  await fs.writeFile(invocation.stdoutFile, "", "utf8");
  await fs.writeFile(invocation.stderrFile, "", "utf8");

  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: {
        ...process.env,
        ...(invocation.env ?? {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    if (invocation.input) {
      child.stdin.end(invocation.input);
    } else {
      child.stdin.end();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      await fs.writeFile(invocation.stdoutFile, stdout, "utf8");
      await fs.writeFile(invocation.stderrFile, stderr, "utf8");
      resolve({
        id: invocation.caseId,
        harness: invocation.harness,
        status: timedOut ? "timeout" : code === 0 ? "passed" : "failed",
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        commandLine: shellCommand(invocation),
        stdoutFile: invocation.stdoutFile,
        stderrFile: invocation.stderrFile,
        exitCode: code,
        signal,
        timedOut,
        durationMs: performance.now() - started
      });
    });
  });
}

async function scoreHarnessCase(testCase, runCase, options) {
  const transcriptPath = path.resolve(
    options.transcriptDir
      ? path.join(options.transcriptDir, `${runCase.id}.json`)
      : runCase.transcriptFile
  );
  const telemetryDb = path.resolve(options.telemetryDb ?? runCase.telemetryDb);
  const source = options.source ?? "auto";
  const transcriptExists = await exists(transcriptPath);

  if ((source === "auto" || source === "transcript") && transcriptExists) {
    const transcript = normaliseHarnessTranscript(
      JSON.parse(await fs.readFile(transcriptPath, "utf8"))
    );
    const score = scoreAgentTranscript(testCase, transcript);
    return {
      id: testCase.id,
      goal: testCase.goal,
      source: "transcript",
      success: score.success,
      strictSuccess: score.success,
      scoredSuccess: score.success,
      unscoredCriteria: [],
      transcriptPath,
      telemetryDb,
      score
    };
  }

  if (source === "transcript") {
    return missingTranscriptResult(testCase, transcriptPath, telemetryDb);
  }

  const transcript = await transcriptFromTelemetry(telemetryDb, options.telemetryLimit);
  const { scoreCase, unscoredCriteria } = telemetryScoreCase(testCase);
  const score = scoreAgentTranscript(scoreCase, transcript);
  const strictSuccess = score.success && unscoredCriteria.length === 0;

  return {
    id: testCase.id,
    goal: testCase.goal,
    source: "telemetry",
    success: strictSuccess,
    strictSuccess,
    scoredSuccess: score.success,
    unscoredCriteria,
    transcriptPath,
    telemetryDb,
    score
  };
}

function relayMcpConfig(options) {
  return {
    mcpServers: {
      "webmcp-relay": {
        command: "node",
        args: relayArgs(options)
      }
    }
  };
}

function relayArgs(options) {
  const args = [
    path.resolve("src", "webmcp-relay.js"),
    "--dynamic",
    "--registry-db",
    options.registryDb,
    "--telemetry-db",
    options.telemetryDb,
    "--log-level",
    options.logLevel ?? "info",
    "--log-file",
    options.logFile
  ];

  if (options.headless) args.push("--headless");
  if (options.browserUrl) args.push("--browser-url", options.browserUrl);
  if (options.channel) args.push("--channel", options.channel);
  if (options.command) args.push("--command", options.command);
  if (options.mcpPackage) args.push("--mcp-package", options.mcpPackage);
  if (options.navigationTimeout) args.push("--timeout", String(options.navigationTimeout));
  if (options.pageIdx !== undefined) args.push("--page-idx", String(options.pageIdx));
  if (options.chromeFeatures) args.push("--chrome-features", options.chromeFeatures);
  if (options.isolated === false) args.push("--no-isolated");
  for (const extraArg of options.extraServerArgs ?? []) {
    args.push("--server-arg", extraArg);
  }

  return args;
}

function harnessPrompt({ testCase, harness, transcriptFile }) {
  const lines = [
    `# WebMCP Relay Harness Eval: ${testCase.id}`,
    "",
    `Harness target: ${harness}`,
    "",
    "Use the configured `webmcp-relay` MCP server to complete this task. Do not only describe what you would do; call the available MCP tools.",
    "",
    "## Goal",
    "",
    testCase.goal,
    ""
  ];

  if (testCase.seedSites?.length > 0) {
    lines.push("## Seed The Registry", "");
    for (const url of testCase.seedSites) {
      lines.push(`- First call \`open_page\` for ${url}`);
    }
    lines.push("");
  }

  if (testCase.resetUrl) {
    lines.push("## Reset Page", "", `After seeding, call \`open_page\` for ${testCase.resetUrl}.`, "");
  }

  if (testCase.siteUrl) {
    lines.push("## Start URL", "", `Call \`open_page\` for ${testCase.siteUrl}.`, "");
  }

  lines.push(
    "## Expected Success Criteria",
    "",
    "```json",
    JSON.stringify(testCase.successCriteria ?? {}, null, 2),
    "```",
    "",
    "## Tool Use Guidance",
    "",
    "- Use `open_page` for ordinary navigation.",
    "- After opening a page, use discovered dynamic tools such as `webmcp_tool_*` when available.",
    "- If dynamic tools are not visible, use `webmcp_list_tools` and `webmcp_call_tool`.",
    "- For tasks that refer to previously discovered tools, use `webmcp_search_registry` and `webmcp_execute_registry_tool`.",
    "",
    "## Optional Transcript",
    "",
    "If this harness can write files, write a transcript JSON here:",
    "",
    `\`${transcriptFile}\``,
    "",
    "Use this shape:",
    "",
    "```json",
    JSON.stringify({
      id: testCase.id,
      finished: true,
      answer: "Short final answer",
      toolCalls: [
        {
          name: "open_page",
          arguments: {
            url: testCase.siteUrl ?? testCase.seedSites?.[0] ?? "https://example.com"
          },
          originalToolName: null,
          isError: false,
          resultText: "Important tool output"
        }
      ]
    }, null, 2),
    "```",
    "",
    "A transcript gives strict scoring, including output text and finish state. Without it, the scorer can still use relay telemetry for tool-call scoring, but output criteria cannot be validated."
  );

  return `${lines.join("\n")}\n`;
}

function harnessReadme(run) {
  const lines = [
    "# WebMCP Relay Agent Harness Run",
    "",
    "This directory contains isolated eval cases for an external agent harness such as Codex, Claude, or any MCP-capable agent.",
    "",
    "Each case has:",
    "",
    "- `mcp-config.json`: MCP server config for that case",
    "- `prompt.md`: the exact task prompt to give the harness",
    "- `case.json`: the original eval case",
    "- `registry.sqlite`: local registry DB for the case",
    "- `telemetry.sqlite`: local telemetry DB for scoring tool calls",
    "- `relay.jsonl`: relay operator logs",
    "- `transcript.json`: optional strict scoring transcript written by the harness",
    "",
    "Recommended flow:",
    "",
    "1. Configure the harness with the case `mcp-config.json`.",
    "2. Start a fresh harness session.",
    "3. Paste the case `prompt.md` as the user task.",
    "4. Let the agent call MCP tools until it finishes.",
    "5. If the harness can write files, have it write `transcript.json`.",
    "6. Score the run with:",
    "",
    "```sh",
    `node ./src/webmcp-relay.js eval harness score ${run.outDir}`,
    "```",
    "",
    "Cases:",
    ""
  ];

  for (const runCase of run.cases) {
    lines.push(`- ${runCase.id}: ${runCase.promptFile}`);
  }

  return `${lines.join("\n")}\n`;
}

async function loadHarnessRun(runPath) {
  const runFile = resolveRunFile(runPath);
  const run = JSON.parse(await fs.readFile(runFile, "utf8"));
  return {
    ...run,
    runFile
  };
}

function resolveRunFile(runPath = path.join("reports", "harness-run")) {
  const resolved = path.resolve(runPath);
  return path.extname(resolved) === ".json" ? resolved : path.join(resolved, HARNESS_RUN_FILE);
}

async function loadCase(runCase) {
  if (runCase.caseJsonFile && await exists(runCase.caseJsonFile)) {
    return JSON.parse(await fs.readFile(runCase.caseJsonFile, "utf8"));
  }
  return {
    id: runCase.id,
    goal: runCase.goal,
    siteUrl: runCase.siteUrl,
    seedSites: runCase.seedSites,
    resetUrl: runCase.resetUrl,
    successCriteria: runCase.successCriteria
  };
}

function normaliseHarnessTranscript(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (Array.isArray(raw.transcript)) {
    return raw.transcript;
  }

  const transcript = [];
  for (const call of raw.toolCalls ?? raw.calls ?? []) {
    const name = call.name ?? call.toolName;
    const args = call.arguments ?? call.args ?? {};
    transcript.push({
      type: "call_tool",
      name,
      arguments: args,
      originalToolName: call.originalToolName ?? originalToolNameForCall(name, args),
      isError: call.isError === true,
      resultText: call.resultText ?? call.outputText ?? stringifyOutput(call.result)
    });
  }

  if (raw.finished !== false || raw.answer) {
    transcript.push({
      type: "llm_decision",
      decision: {
        action: "finish",
        answer: raw.answer ?? ""
      }
    });
  }

  return transcript;
}

async function transcriptFromTelemetry(telemetryDb, limit = 1000) {
  if (!await exists(telemetryDb)) {
    return [];
  }

  const telemetry = new TelemetryStore({
    path: telemetryDb,
    enabled: true
  });

  try {
    const events = (await telemetry.recent(limit)).reverse();
    return events
      .map(telemetryEventToTranscriptEntry)
      .filter(Boolean);
  } finally {
    telemetry.close();
  }
}

function telemetryEventToTranscriptEntry(event) {
  switch (event.eventType) {
    case "open_site":
      return {
        type: "call_tool",
        name: "open_page",
        arguments: {
          url: event.url
        },
        isError: event.isError,
        resultText: event.errorText
      };
    case "search_registry":
      return {
        type: "call_tool",
        name: "webmcp_search_registry",
        arguments: {
          query: event.query
        },
        isError: event.isError,
        resultText: event.errorText
      };
    case "execute_registry_tool":
      return {
        type: "call_tool",
        name: "webmcp_execute_registry_tool",
        arguments: {
          id: event.registryId
        },
        isError: event.isError,
        resultText: event.errorText
      };
    case "call_site_tool":
      return {
        type: "call_tool",
        name: "webmcp_call_tool",
        arguments: {
          name: event.toolName
        },
        originalToolName: event.toolName,
        isError: event.isError,
        resultText: event.errorText
      };
    case "call_dynamic_tool":
      return {
        type: "call_tool",
        name: event.metadata?.dynamicName ?? dynamicNameForOriginal(event.toolName),
        arguments: {},
        originalToolName: event.toolName,
        isError: event.isError,
        resultText: event.errorText
      };
    default:
      return undefined;
  }
}

function telemetryScoreCase(testCase) {
  const criteria = testCase.successCriteria ?? {};
  const unscoredCriteria = [];
  const scoreCriteria = {
    ...criteria,
    mustFinish: false
  };

  if (criteria.mustFinish !== false) {
    unscoredCriteria.push("mustFinish");
  }

  if (criteria.mustIncludeOutputs || criteria.expectedOutputIncludes) {
    unscoredCriteria.push("mustIncludeOutputs");
    delete scoreCriteria.mustIncludeOutputs;
    delete scoreCriteria.expectedOutputIncludes;
  }

  return {
    scoreCase: {
      ...testCase,
      successCriteria: scoreCriteria
    },
    unscoredCriteria
  };
}

function missingTranscriptResult(testCase, transcriptPath, telemetryDb) {
  return {
    id: testCase.id,
    goal: testCase.goal,
    source: "transcript",
    success: false,
    strictSuccess: false,
    scoredSuccess: false,
    unscoredCriteria: [],
    transcriptPath,
    telemetryDb,
    error: `Transcript not found: ${transcriptPath}`,
    score: {
      success: false
    }
  };
}

function summarizeHarnessResults(results) {
  const total = results.length;
  const strictSuccess = results.filter((result) => result.strictSuccess === true).length;
  const scoredSuccess = results.filter((result) => result.scoredSuccess === true).length;
  const telemetryOnly = results.filter((result) => result.source === "telemetry").length;
  const transcript = results.filter((result) => result.source === "transcript").length;

  return {
    total,
    strictSuccess,
    strictSuccessRate: ratio(strictSuccess, total),
    scoredSuccess,
    scoredSuccessRate: ratio(scoredSuccess, total),
    telemetryOnly,
    transcript
  };
}

function originalToolNameForCall(name, args) {
  if (name === "webmcp_call_tool") {
    return args?.name ?? args?.toolName;
  }
  if (typeof name === "string" && name.startsWith("webmcp_tool_")) {
    return name.slice("webmcp_tool_".length);
  }
  return undefined;
}

function dynamicNameForOriginal(name) {
  if (!name) {
    return undefined;
  }
  return `webmcp_tool_${String(name).replace(/[^A-Za-z0-9_-]+/g, "_")}`;
}

function stringifyOutput(value) {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normaliseHarnessName(value) {
  const name = String(value ?? "").trim().toLowerCase();
  switch (name) {
    case "codex":
    case "openai":
      return "codex";
    case "claude":
    case "claude-code":
    case "claudecode":
      return "claude";
    case "gemini":
    case "gemini-cli":
    case "geminicli":
      return "gemini";
    default:
      throw new Error("Harness runner must be codex, claude, or gemini.");
  }
}

function shellCommand(invocation) {
  const env = invocation.env
    ? Object.entries(invocation.env).map(([key, value]) => `${key}=${shellQuote(value)}`)
    : [];
  const command = [
    ...env,
    invocation.command,
    ...invocation.args
  ].map(shellQuote).join(" ");

  if (invocation.input) {
    return `${command} < ${shellQuote(path.join(invocation.cwd, "prompt.md"))}`;
  }
  return command;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlStringArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function safeFileName(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "case";
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}
