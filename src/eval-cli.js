import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCommonArgs, readValue, splitOption } from "./cli.js";
import { DevtoolsWebmcpClient } from "./devtools-webmcp-client.js";
import { TelemetryStore } from "./telemetry-store.js";
import { ToolRegistry } from "./tool-registry.js";
import { WebmcpRelay } from "./webmcp-relay-core.js";

export async function runEvalCli(args) {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return;
  }

  if (command !== "run") {
    throw new Error(`Unsupported eval command: ${command}`);
  }

  const options = parseEvalRunArgs(rest);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const report = await runEval(options);
  const text = JSON.stringify(report, null, 2);

  if (options.report) {
    await fs.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
    await fs.writeFile(options.report, `${text}\n`, "utf8");
  }

  process.stdout.write(`${text}\n`);
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
