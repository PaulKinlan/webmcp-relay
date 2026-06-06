import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCommonArgs, readValue, splitOption } from "./cli.js";
import { runAgentEval } from "./agent-eval.js";
import { DevtoolsWebmcpClient } from "./devtools-webmcp-client.js";
import { prepareHarnessEval, runHarnessEval, scoreHarnessEval } from "./harness-eval.js";
import { runSearchEval } from "./search-eval.js";
import { TelemetryStore } from "./telemetry-store.js";
import { ToolRegistry } from "./tool-registry.js";
import { WebmcpRelay } from "./webmcp-relay-core.js";

export async function runEvalCli(args) {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return;
  }

  if (!["run", "agent", "search", "harness"].includes(command)) {
    throw new Error(`Unsupported eval command: ${command}`);
  }

  const options = command === "agent"
    ? parseEvalAgentArgs(rest)
    : command === "search"
      ? parseEvalSearchArgs(rest)
      : command === "harness"
        ? parseEvalHarnessArgs(rest)
      : parseEvalRunArgs(rest);
  if (options.help) {
    process.stdout.write(
      command === "agent"
        ? agentHelpText()
        : command === "search"
          ? searchHelpText()
          : command === "harness"
            ? harnessHelpText()
          : helpText()
    );
    return;
  }

  const report = command === "agent"
    ? await runAgentEval(options)
    : command === "search"
      ? await runSearchEval(options)
      : command === "harness"
        ? options.harnessCommand === "prepare"
          ? await prepareHarnessEval(options)
          : options.harnessCommand === "run"
            ? await runHarnessEval(options)
            : await scoreHarnessEval(options)
      : await runEval(options);
  await writeReport(report, options);
}

export async function runEval(options) {
  const cases = await loadEvalCases(options.caseFiles);
  const registryPath = options.registryDb ?? tempSqlitePath("registry");
  const telemetryPath = options.telemetryDb ?? tempSqlitePath("telemetry");
  const startedAt = new Date().toISOString();
  const started = performance.now();

  const bridge = new DevtoolsWebmcpClient(options);
  const registry = new ToolRegistry({
    path: registryPath,
    enabled: true
  });
  const telemetry = new TelemetryStore({
    path: telemetryPath,
    enabled: options.telemetryEnabled !== false
  });
  const relay = new WebmcpRelay({
    bridge,
    mode: "dynamic",
    registry,
    telemetry
  });

  const results = [];

  try {
    for (const testCase of cases) {
      results.push(await runEvalCase(relay, telemetry, testCase, options));
    }
  } finally {
    await relay.close();
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    gitSha: await gitSha(),
    nodeVersion: process.version,
    registryPath,
    telemetryPath,
    caseCount: cases.length,
    summary: summarizeResults(results),
    results
  };
}

async function runEvalCase(relay, telemetry, testCase, options) {
  const started = performance.now();
  const result = {
    id: testCase.id,
    intent: testCase.intent,
    siteUrl: testCase.siteUrl,
    expectedToolNames: testCase.expectedToolNames ?? [],
    phases: {}
  };

  try {
    const openResult = await relay.openSite({
      url: testCase.siteUrl,
      waitForText: testCase.waitForText,
      timeout: options.navigationTimeout
    }, { notify: false });

    const discoveredTools = openResult.structuredContent?.tools ?? [];
    const discoveredToolNames = discoveredTools.map((tool) => tool.name);
    const expectedToolNames = testCase.expectedToolNames ?? [];
    const missingTools = expectedToolNames.filter((name) => !discoveredToolNames.includes(name));
    result.phases.discovery = {
      success: missingTools.length === 0,
      discoveredToolNames,
      missingTools
    };

    const lookupStarted = performance.now();
    const lookupResult = await relay.searchRegistry({
      query: testCase.intent,
      limit: testCase.limit ?? 10
    });
    const matches = lookupResult.structuredContent?.matches ?? [];
    const expectedUrlIncludes = normaliseExpectedList(testCase.expectedUrlIncludes);
    const expectedRegistryIds = normaliseExpectedList(testCase.expectedRegistryIds);
    const expectedMatchIndex = matches.findIndex((match) =>
      matchesExpectedRegistryEntry(match, {
        expectedToolNames,
        expectedUrlIncludes,
        expectedRegistryIds
      })
    );
    const selectedMatch =
      expectedMatchIndex >= 0 ? matches[expectedMatchIndex] : matches[0];

    result.phases.lookup = {
      success: expectedMatchIndex >= 0,
      rank: expectedMatchIndex >= 0 ? expectedMatchIndex + 1 : null,
      topToolName: matches[0]?.toolName,
      topRegistryId: matches[0]?.id,
      expectedUrlIncludes,
      selectedRegistryId: selectedMatch?.id,
      selectedUrl: selectedMatch?.url,
      latencyMs: performance.now() - lookupStarted,
      matches: matches.map((match) => ({
        id: match.id,
        toolName: match.toolName,
        url: match.url,
        rank: match.rank,
        score: match.score
      }))
    };

    if (testCase.input !== undefined && selectedMatch) {
      const executionStarted = performance.now();
      const executionResult = await relay.executeRegistryTool({
        id: selectedMatch.id,
        input: testCase.input,
        waitForText: testCase.waitForText,
        timeout: options.navigationTimeout
      });
      const outputText = resultText(executionResult);
      const expectedOutput = normaliseExpectedOutput(testCase.expectedOutputIncludes);
      const outputMatched = expectedOutput.every((text) => outputText.includes(text));

      result.phases.execution = {
        success: executionResult.isError !== true && outputMatched,
        isError: executionResult.isError === true,
        latencyMs: performance.now() - executionStarted,
        expectedOutputIncludes: expectedOutput,
        outputMatched,
        outputText
      };
    }

    result.success = phaseSuccess(result.phases.discovery) &&
      phaseSuccess(result.phases.lookup) &&
      phaseSuccess(result.phases.execution);
  } catch (error) {
    result.success = false;
    result.error = error.message;
  }

  result.durationMs = performance.now() - started;
  await telemetry.log({
    eventType: "eval_case",
    url: testCase.siteUrl,
    query: testCase.intent,
    latencyMs: result.durationMs,
    isError: !result.success,
    errorText: result.error,
    metadata: result
  });
  return result;
}

function parseEvalRunArgs(args) {
  const commonArgs = [];
  const caseFiles = [];
  const extra = {
    headless: true,
    telemetryEnabled: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        extra.help = true;
        break;
      case "--report":
        extra.report = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--registry-db":
        extra.registryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--telemetry-db":
        extra.telemetryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--no-telemetry":
        extra.telemetryEnabled = false;
        break;
      default:
        if (COMMON_VALUE_OPTIONS.has(key)) {
          commonArgs.push(arg);
          if (inlineValue === undefined) {
            commonArgs.push(readValue(arg, inlineValue, args, ++index));
          }
        } else if (COMMON_BOOLEAN_OPTIONS.has(key)) {
          commonArgs.push(arg);
        } else if (arg.startsWith("--")) {
          throw new Error(`Unknown eval option: ${arg}`);
        } else {
          caseFiles.push(arg);
        }
        break;
    }
  }

  if (!extra.help && caseFiles.length === 0) {
    throw new Error("eval run requires at least one eval case JSON file.");
  }

  return {
    ...parseCommonArgs(commonArgs, {
      headless: extra.headless
    }),
    ...extra,
    caseFiles
  };
}

function parseEvalAgentArgs(args) {
  const commonArgs = [];
  const caseFiles = [];
  const extra = {
    headless: true,
    telemetryEnabled: true,
    provider: "openai-compatible",
    responseFormat: true,
    maxSteps: 8
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        extra.help = true;
        break;
      case "--report":
        extra.report = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--registry-db":
        extra.registryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--telemetry-db":
        extra.telemetryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--no-telemetry":
        extra.telemetryEnabled = false;
        break;
      case "--provider":
        extra.provider = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--model":
        extra.model = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--base-url":
        extra.baseUrl = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--api-key-env":
        extra.apiKeyEnv = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--max-steps":
        extra.maxSteps = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--max-result-chars":
        extra.maxResultChars = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--temperature":
        extra.temperature = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--no-response-format":
        extra.responseFormat = false;
        break;
      default:
        if (COMMON_VALUE_OPTIONS.has(key)) {
          commonArgs.push(arg);
          if (inlineValue === undefined) {
            commonArgs.push(readValue(arg, inlineValue, args, ++index));
          }
        } else if (COMMON_BOOLEAN_OPTIONS.has(key)) {
          commonArgs.push(arg);
        } else if (arg.startsWith("--")) {
          throw new Error(`Unknown agent eval option: ${arg}`);
        } else {
          caseFiles.push(arg);
        }
        break;
    }
  }

  if (!["openai-compatible", "scripted"].includes(extra.provider)) {
    throw new Error(`Unsupported agent eval provider: ${extra.provider}`);
  }
  if (!extra.help && caseFiles.length === 0) {
    throw new Error("eval agent requires at least one agent eval case JSON file.");
  }
  if (!Number.isFinite(extra.maxSteps) || extra.maxSteps < 1) {
    throw new Error("--max-steps must be a positive number.");
  }

  return {
    ...parseCommonArgs(commonArgs, {
      headless: extra.headless
    }),
    ...extra,
    caseFiles
  };
}

function parseEvalSearchArgs(args) {
  const caseFiles = [];
  const extra = {
    limit: 10
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        extra.help = true;
        break;
      case "--report":
        extra.report = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--registry-db":
        extra.registryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--limit":
        extra.limit = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown search eval option: ${arg}`);
        }
        caseFiles.push(arg);
        break;
    }
  }

  if (!extra.help && caseFiles.length === 0) {
    throw new Error("eval search requires at least one search eval JSON file.");
  }
  if (!Number.isFinite(extra.limit) || extra.limit < 1) {
    throw new Error("--limit must be a positive number.");
  }

  return {
    ...extra,
    caseFiles
  };
}

function parseEvalHarnessArgs(args) {
  const [harnessCommand, ...rest] = args;

  if (!harnessCommand || harnessCommand === "--help" || harnessCommand === "-h") {
    return {
      harnessCommand: "prepare",
      help: true
    };
  }

  if (harnessCommand === "prepare") {
    return parseEvalHarnessPrepareArgs(rest);
  }
  if (harnessCommand === "run") {
    return parseEvalHarnessRunArgs(rest);
  }
  if (harnessCommand === "score") {
    return parseEvalHarnessScoreArgs(rest);
  }

  throw new Error(`Unsupported harness eval command: ${harnessCommand}`);
}

function parseEvalHarnessRunArgs(args) {
  const [harness, ...rest] = args;
  const commonArgs = [];
  const caseFiles = [];
  const extra = {
    harnessCommand: "run",
    harness,
    outDir: harness ? `reports/${harness}-harness-run` : undefined,
    scoreSource: "auto"
  };

  if (!harness || harness === "--help" || harness === "-h") {
    return {
      harnessCommand: "run",
      help: true
    };
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        extra.help = true;
        break;
      case "--out":
        extra.outDir = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--report":
        extra.report = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--registry-db":
        extra.registryDb = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--telemetry-db":
        extra.telemetryDb = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--log-level":
        extra.logLevel = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--log-file":
        extra.logFile = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--model":
        extra.model = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--runner-command":
        extra.runnerCommand = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--runner-package":
        extra.runnerPackage = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--timeout-ms":
        extra.harnessTimeoutMs = Number(readValue(arg, inlineValue, rest, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--score-source":
        extra.scoreSource = readValue(arg, inlineValue, rest, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--dry-run":
        extra.dryRun = true;
        break;
      case "--no-score":
        extra.noScore = true;
        break;
      default:
        if (COMMON_VALUE_OPTIONS.has(key)) {
          commonArgs.push(arg);
          if (inlineValue === undefined) {
            commonArgs.push(readValue(arg, inlineValue, rest, ++index));
          }
        } else if (COMMON_BOOLEAN_OPTIONS.has(key)) {
          commonArgs.push(arg);
        } else if (arg.startsWith("--")) {
          throw new Error(`Unknown harness run option: ${arg}`);
        } else {
          caseFiles.push(arg);
        }
        break;
    }
  }

  if (!extra.help && caseFiles.length === 0) {
    caseFiles.push("evals/agent/pizza-maker.json");
  }
  if (!["auto", "transcript", "telemetry"].includes(extra.scoreSource)) {
    throw new Error("--score-source must be auto, transcript, or telemetry.");
  }
  if (extra.harnessTimeoutMs !== undefined && (!Number.isFinite(extra.harnessTimeoutMs) || extra.harnessTimeoutMs < 1)) {
    throw new Error("--timeout-ms must be a positive number.");
  }

  return {
    ...parseCommonArgs(commonArgs),
    ...extra,
    caseFiles
  };
}

function parseEvalHarnessPrepareArgs(args) {
  const commonArgs = [];
  const caseFiles = [];
  const extra = {
    harnessCommand: "prepare",
    harness: "generic"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        extra.help = true;
        break;
      case "--out":
        extra.outDir = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--harness":
        extra.harness = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--report":
        extra.report = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--registry-db":
        extra.registryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--telemetry-db":
        extra.telemetryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--log-level":
        extra.logLevel = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--log-file":
        extra.logFile = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      default:
        if (COMMON_VALUE_OPTIONS.has(key)) {
          commonArgs.push(arg);
          if (inlineValue === undefined) {
            commonArgs.push(readValue(arg, inlineValue, args, ++index));
          }
        } else if (COMMON_BOOLEAN_OPTIONS.has(key)) {
          commonArgs.push(arg);
        } else if (arg.startsWith("--")) {
          throw new Error(`Unknown harness prepare option: ${arg}`);
        } else {
          caseFiles.push(arg);
        }
        break;
    }
  }

  if (!extra.help && caseFiles.length === 0) {
    throw new Error("eval harness prepare requires at least one agent eval case JSON file.");
  }

  return {
    ...parseCommonArgs(commonArgs),
    ...extra,
    caseFiles
  };
}

function parseEvalHarnessScoreArgs(args) {
  const extra = {
    harnessCommand: "score",
    source: "auto"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        extra.help = true;
        break;
      case "--report":
        extra.report = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--transcript-dir":
        extra.transcriptDir = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--telemetry-db":
        extra.telemetryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--source":
        extra.source = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--limit":
        extra.telemetryLimit = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown harness score option: ${arg}`);
        }
        extra.runPath = arg;
        break;
    }
  }

  if (!["auto", "transcript", "telemetry"].includes(extra.source)) {
    throw new Error("--source must be auto, transcript, or telemetry.");
  }
  if (!extra.help && !extra.runPath) {
    throw new Error("eval harness score requires a harness run directory or harness-run.json.");
  }
  if (extra.telemetryLimit !== undefined && (!Number.isFinite(extra.telemetryLimit) || extra.telemetryLimit < 1)) {
    throw new Error("--limit must be a positive number.");
  }

  return extra;
}

async function writeReport(report, options) {
  const text = JSON.stringify(report, null, 2);

  if (options.report) {
    await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
    await fs.writeFile(options.report, `${text}\n`, "utf8");
  }

  process.stdout.write(`${text}\n`);
}

const COMMON_VALUE_OPTIONS = new Set([
  "--url",
  "--wait-for-text",
  "--browser-url",
  "--channel",
  "--command",
  "--mcp-package",
  "--timeout",
  "--page-idx",
  "--chrome-features",
  "--server-arg"
]);

const COMMON_BOOLEAN_OPTIONS = new Set([
  "--headless",
  "--no-isolated",
  "--json",
  "--raw",
  "--verbose"
]);

async function loadEvalCases(files) {
  const cases = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text);
    const fileCases = Array.isArray(parsed) ? parsed : parsed.cases ?? [parsed];
    cases.push(...fileCases.map((testCase) => validateEvalCase(testCase, file)));
  }

  return cases;
}

function validateEvalCase(testCase, file) {
  if (!testCase.id || typeof testCase.id !== "string") {
    throw new Error(`Eval case in ${file} is missing string id.`);
  }
  if (!testCase.intent || typeof testCase.intent !== "string") {
    throw new Error(`Eval case ${testCase.id} is missing string intent.`);
  }
  if (!testCase.siteUrl || typeof testCase.siteUrl !== "string") {
    throw new Error(`Eval case ${testCase.id} is missing string siteUrl.`);
  }

  return testCase;
}

function summarizeResults(results) {
  const total = results.length;
  const discoveryPass = countPhase(results, "discovery");
  const lookupPass = countPhase(results, "lookup");
  const lookupTop1 = results.filter((result) => result.phases.lookup?.rank === 1).length;
  const executionCases = results.filter((result) => result.phases.execution);
  const executionPass = countPhase(results, "execution");
  const success = results.filter((result) => result.success).length;

  return {
    total,
    success,
    successRate: ratio(success, total),
    discoveryPass,
    discoveryPassRate: ratio(discoveryPass, total),
    lookupPass,
    lookupPassRate: ratio(lookupPass, total),
    lookupTop1,
    lookupTop1Rate: ratio(lookupTop1, total),
    executionPass,
    executionPassRate: ratio(executionPass, executionCases.length),
    averageDurationMs: average(results.map((result) => result.durationMs))
  };
}

function countPhase(results, phase) {
  return results.filter((result) => result.phases[phase]?.success === true).length;
}

function phaseSuccess(phase) {
  return !phase || phase.success === true;
}

function resultText(result) {
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  if (text) {
    return text;
  }

  const fallback = {
    structuredContent: result.structuredContent,
    _meta: result._meta
  };
  return JSON.stringify(fallback);
}

function normaliseExpectedOutput(value) {
  return normaliseExpectedList(value);
}

function normaliseExpectedList(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function matchesExpectedRegistryEntry(
  match,
  { expectedToolNames, expectedUrlIncludes, expectedRegistryIds }
) {
  if (!match) {
    return false;
  }

  if (expectedRegistryIds.includes(match.id)) {
    return true;
  }

  const hasExpectedToolNames = expectedToolNames.length > 0;
  const hasExpectedUrls = expectedUrlIncludes.length > 0;

  if (!hasExpectedToolNames && !hasExpectedUrls) {
    return false;
  }

  const toolNameMatches =
    !hasExpectedToolNames || expectedToolNames.includes(match.toolName);
  const urlMatches =
    !hasExpectedUrls || expectedUrlIncludes.some((text) => match.url?.includes(text));

  return toolNameMatches && urlMatches;
}

function tempSqlitePath(name) {
  return path.join(os.tmpdir(), `webmcp-relay-${name}-${process.pid}-${Date.now()}.sqlite`);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

async function gitSha() {
  try {
    const head = await fs.readFile(path.join(process.cwd(), ".git", "HEAD"), "utf8");
    const trimmed = head.trim();
    if (!trimmed.startsWith("ref: ")) {
      return trimmed;
    }

    const ref = trimmed.slice(5);
    return (await fs.readFile(path.join(process.cwd(), ".git", ref), "utf8")).trim();
  } catch {
    return undefined;
  }
}

function helpText() {
  return `Usage:
  webmcp-relay eval run <case.json...> [options]
  webmcp-relay eval agent <agent-case.json...> [options]
  webmcp-relay eval search <search-case.json...> [options]
  webmcp-relay eval harness prepare <agent-case.json...> [options]
  webmcp-relay eval harness score <run-dir|harness-run.json> [options]

Options:
  --report <path>           Write JSON report to a file.
  --registry-db <path>      SQLite registry path for the eval run.
  --telemetry-db <path>     SQLite telemetry path for the eval run.
  --no-telemetry            Disable telemetry events during eval.
  --headless                Launch Chrome headlessly. Default for eval.
  --channel <name>          Chrome channel for chrome-devtools-mcp to launch.
  --timeout <ms>            Navigation timeout.

Case shape:
  {
    "id": "analytics-filter-post-errors",
    "intent": "filter POST server logs with status 500",
    "siteUrl": "https://...",
    "expectedToolNames": ["query"],
    "input": { "...": "..." },
    "expectedOutputIncludes": ["Query applied"]
}
`;
}

function agentHelpText() {
  return `Usage:
  webmcp-relay eval agent <case.json...> [options]

This runs an LLM-in-the-loop agent against webmcp-relay over MCP. The transcript
records MCP listTools, callTool, tools/list_changed notifications, LLM decisions,
tool arguments, tool results, and scoring.

Provider options:
  --provider <name>         openai-compatible or scripted. Default: openai-compatible.
  --model <name>            Model for openai-compatible chat completions.
  --base-url <url>          API base URL. Default: OPENAI_BASE_URL or https://api.openai.com/v1.
  --api-key-env <name>      Environment variable containing the API key. Default: OPENAI_API_KEY.
  --temperature <number>    Default: 0.
  --no-response-format      Do not send response_format={"type":"json_object"}.

Run options:
  --report <path>           Write JSON report to a file.
  --registry-db <path>      SQLite registry path for the eval run.
  --telemetry-db <path>     SQLite telemetry path for the eval run.
  --no-telemetry            Disable telemetry events during eval.
  --max-steps <number>      Max LLM decisions per case. Default: 8.
  --headless                Launch Chrome headlessly. Default for eval.
  --channel <name>          Chrome channel for chrome-devtools-mcp to launch.
  --timeout <ms>            Navigation timeout.

Case shape:
  {
    "id": "agent-pizza-large-bbq",
    "goal": "Make the pizza large and set its style to BBQ.",
    "siteUrl": "https://...",
    "successCriteria": {
      "mustCallMcpTools": ["open_page"],
      "mustCallWebmcpTools": ["set_pizza_size", "set_pizza_style"],
      "mustIncludeOutputs": ["Set pizza size to Large", "Changed pizza style to BBQ"]
    }
  }
`;
}

function searchHelpText() {
  return `Usage:
  webmcp-relay eval search <case.json...> [options]

This runs deterministic local registry search-quality evals. It seeds a local
SQLite registry with fixture tools, runs intent queries, records ranked matches,
and reports top-1, success rate, mean reciprocal rank, latency, and tag
breakdowns.

Options:
  --report <path>           Write JSON report to a file.
  --registry-db <path>      SQLite registry path for the eval run.
  --limit <number>          Default result limit for each query. Default: 10.

Case shape:
  {
    "id": "registry-search-quality",
    "tools": [
      {
        "id": "analytics-query",
        "url": "https://...",
        "name": "query",
        "description": "Filter server logs by status code"
      }
    ],
    "cases": [
      {
        "id": "exact-server-errors",
        "query": "filter POST status 500 logs",
        "expectedToolIds": ["analytics-query"],
        "maxRank": 1,
        "tags": ["exact"]
      }
    ]
  }
`;
}

function harnessHelpText() {
  return `Usage:
  webmcp-relay eval harness prepare <agent-case.json...> [options]
  webmcp-relay eval harness run <codex|claude|gemini> <agent-case.json...> [options]
  webmcp-relay eval harness score <run-dir|harness-run.json> [options]

This prepares eval cases for an external MCP-capable agent harness such as
Codex, Claude, or a custom runner. Each case gets an isolated prompt,
mcp-config.json, registry DB, telemetry DB, log file, and optional transcript
path.

Prepare options:
  --out <dir>               Output directory. Default: reports/harness-run.
  --harness <name>          Label for the target harness, for example codex or claude.
  --report <path>           Also write the prepare report to a file.
  --headless                Include --headless in generated relay configs.
  --channel <name>          Chrome channel for generated relay configs.
  --browser-url <url>       Connect generated relay configs to an existing browser.
  --timeout <ms>            Navigation timeout.

Run options:
  --out <dir>               Output directory. Default: reports/harness-run.
  --report <path>           Write JSON run report to a file.
  --dry-run                 Prepare files and print runner commands without invoking the harness.
  --no-score                Do not score after running.
  --score-source <mode>     auto, transcript, or telemetry. Default: auto.
  --runner-command <cmd>    Override runner command, for example codex or npx.
  --runner-package <pkg>    Override npx package for codex/gemini runners.
  --model <model>           Forward model to the harness CLI when supported.
  --timeout-ms <ms>         Max process runtime per case. Default: 600000.

Score options:
  --report <path>           Write JSON score report to a file.
  --source <mode>           auto, transcript, or telemetry. Default: auto.
  --transcript-dir <dir>    Directory containing <case-id>.json transcripts.
  --telemetry-db <path>     Override telemetry DB path for scoring.
  --limit <number>          Max telemetry events to inspect. Default: 1000.

Examples:
  npm run eval:harness run codex
  webmcp-relay eval harness prepare evals/agent/pizza-maker.json --out ./reports/codex-harness --harness codex --headless --channel canary
  webmcp-relay eval harness run codex evals/agent/pizza-maker.json --out ./reports/codex-harness --headless --channel canary
  webmcp-relay eval harness run claude evals/agent/pizza-maker.json --out ./reports/claude-harness --headless --channel canary
  webmcp-relay eval harness run gemini evals/agent/pizza-maker.json --out ./reports/gemini-harness --headless --channel canary
  webmcp-relay eval harness score ./reports/codex-harness --report ./reports/codex-harness-score.json
`;
}
