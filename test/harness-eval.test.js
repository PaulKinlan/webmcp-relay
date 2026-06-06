import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareHarnessEval, runHarnessEval, scoreHarnessEval } from "../src/harness-eval.js";
import { TelemetryStore } from "../src/telemetry-store.js";

test("harness prepare writes isolated case prompt and MCP config", async () => {
  const outDir = await tempDir();
  const report = await prepareHarnessEval({
    caseFiles: ["evals/agent/pizza-maker.json"],
    outDir,
    harness: "codex",
    headless: true,
    channel: "canary"
  });

  assert.equal(report.caseCount, 1);
  const [runCase] = report.cases;
  const prompt = await fs.readFile(runCase.promptFile, "utf8");
  const mcpConfig = JSON.parse(await fs.readFile(runCase.mcpConfigFile, "utf8"));

  assert.match(prompt, /Make the pizza large and set its style to BBQ/);
  assert.match(prompt, /transcript\.json/);
  assert.equal(mcpConfig.mcpServers["webmcp-relay"].command, "node");
  assert.equal(mcpConfig.mcpServers["webmcp-relay"].args.includes("--headless"), true);
  assert.equal(mcpConfig.mcpServers["webmcp-relay"].args.includes("--channel"), true);
  assert.equal(await exists(path.join(outDir, "harness-run.json")), true);
});

test("harness score accepts strict transcript output", async () => {
  const outDir = await tempDir();
  const prepare = await prepareHarnessEval({
    caseFiles: ["evals/agent/pizza-maker.json"],
    outDir,
    harness: "codex"
  });
  const [runCase] = prepare.cases;

  await fs.writeFile(runCase.transcriptFile, `${JSON.stringify({
    id: runCase.id,
    finished: true,
    answer: "Done",
    toolCalls: [
      {
        name: "open_page",
        arguments: {
          url: runCase.siteUrl
        },
        isError: false,
        resultText: "Opened page"
      },
      {
        name: "webmcp_tool_set_pizza_size",
        originalToolName: "set_pizza_size",
        arguments: {
          size: "Large"
        },
        isError: false,
        resultText: "Set pizza size to Large"
      },
      {
        name: "webmcp_tool_set_pizza_style",
        originalToolName: "set_pizza_style",
        arguments: {
          style: "BBQ"
        },
        isError: false,
        resultText: "Changed pizza style to BBQ"
      }
    ]
  }, null, 2)}\n`, "utf8");

  const score = await scoreHarnessEval({
    runPath: outDir
  });

  assert.equal(score.summary.strictSuccess, 1);
  assert.equal(score.summary.scoredSuccess, 1);
  assert.equal(score.results[0].source, "transcript");
});

test("harness score can use telemetry for tool-call-only scoring", async () => {
  const outDir = await tempDir();
  const prepare = await prepareHarnessEval({
    caseFiles: ["evals/agent/pizza-maker.json"],
    outDir,
    harness: "claude"
  });
  const [runCase] = prepare.cases;
  const telemetry = new TelemetryStore({
    path: runCase.telemetryDb
  });

  await telemetry.log({
    eventType: "open_site",
    url: runCase.siteUrl,
    isError: false
  });
  await telemetry.log({
    eventType: "call_dynamic_tool",
    toolName: "set_pizza_size",
    isError: false,
    metadata: {
      dynamicName: "webmcp_tool_set_pizza_size"
    }
  });
  await telemetry.log({
    eventType: "call_dynamic_tool",
    toolName: "set_pizza_style",
    isError: false,
    metadata: {
      dynamicName: "webmcp_tool_set_pizza_style"
    }
  });
  telemetry.close();

  const score = await scoreHarnessEval({
    runPath: outDir,
    source: "telemetry"
  });

  assert.equal(score.summary.scoredSuccess, 1);
  assert.equal(score.summary.strictSuccess, 0);
  assert.deepEqual(score.results[0].unscoredCriteria, ["mustFinish", "mustIncludeOutputs"]);
});

test("harness run dry-run prepares codex command and score", async () => {
  const outDir = await tempDir();
  const report = await runHarnessEval({
    caseFiles: ["evals/agent/pizza-maker.json"],
    harness: "codex",
    outDir,
    headless: true,
    channel: "canary",
    dryRun: true
  });

  assert.equal(report.type, "harness-run");
  assert.equal(report.harness, "codex");
  assert.equal(report.dryRun, true);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].status, "dry_run");
  assert.equal(report.runs[0].command, "npx");
  assert.equal(report.runs[0].args.includes("@openai/codex@latest"), true);
  assert.equal(report.runs[0].args.includes("exec"), true);
  assert.equal(report.runs[0].commandLine.includes("prompt.md"), true);
  assert.equal(await exists(path.join(outDir, "harness-run.json")), true);
  assert.equal(await exists(path.join(outDir, "agent-pizza-large-bbq", "runner-command.sh")), true);
  assert.equal(report.score.summary.total, 1);
});

test("harness run dry-run expands agent eval glob", async () => {
  const outDir = await tempDir();
  const report = await runHarnessEval({
    caseFiles: ["evals/agent/*.json"],
    harness: "codex",
    outDir,
    dryRun: true,
    noScore: true
  });

  assert.equal(report.caseCount >= 2, true);
  assert.equal(report.runs.length, report.caseCount);
  assert.equal(report.runs.some((run) => run.id === "agent-pizza-large-bbq"), true);
  assert.equal(report.runs.some((run) => run.id === "agent-registry-leather-return-policy"), true);
});

test("harness run dry-run prepares gemini project settings", async () => {
  const outDir = await tempDir();
  const report = await runHarnessEval({
    caseFiles: ["evals/agent/pizza-maker.json"],
    harness: "gemini",
    outDir,
    dryRun: true,
    noScore: true
  });
  const settings = JSON.parse(
    await fs.readFile(path.join(outDir, "agent-pizza-large-bbq", ".gemini", "settings.json"), "utf8")
  );

  assert.equal(report.runs[0].command, "npx");
  assert.equal(report.runs[0].args.includes("@google/gemini-cli@latest"), true);
  assert.equal(settings.mcpServers["webmcp-relay"].command, "node");
});

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "webmcp-harness-eval-test-"));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
