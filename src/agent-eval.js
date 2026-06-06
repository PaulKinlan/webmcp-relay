import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { DevtoolsWebmcpClient } from "./devtools-webmcp-client.js";
import { TelemetryStore } from "./telemetry-store.js";
import { ToolRegistry } from "./tool-registry.js";
import { WebmcpRelay } from "./webmcp-relay-core.js";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RESULT_CHARS = 12000;

export async function runAgentEval(options) {
  const cases = await loadAgentEvalCases(options.caseFiles);
  const registryPath = options.registryDb ?? tempSqlitePath("agent-registry");
  const telemetryPath = options.telemetryDb ?? tempSqlitePath("agent-telemetry");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const results = [];

  for (const testCase of cases) {
    results.push(await runAgentEvalCase(testCase, {
      ...options,
      registryPath,
      telemetryPath
    }));
  }

  return {
    type: "agent",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    gitSha: await gitSha(),
    nodeVersion: process.version,
    provider: options.provider,
    model: options.model,
    registryPath,
    telemetryPath,
    caseCount: cases.length,
    summary: summarizeAgentResults(results),
    results
  };
}

async function runAgentEvalCase(testCase, options) {
  const started = performance.now();
  const transcript = [];
  const notifications = [];
  const maxSteps = testCase.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const bridge = new DevtoolsWebmcpClient(options);
  const registry = new ToolRegistry({
    path: options.registryPath,
    enabled: true
  });
  const telemetry = new TelemetryStore({
    path: options.telemetryPath,
    enabled: options.telemetryEnabled !== false
  });
  const relay = new WebmcpRelay({
    bridge,
    mode: "dynamic",
    registry,
    telemetry
  });
  const client = new Client(
    {
      name: "webmcp-relay-agent-eval",
      version: "0.1.0"
    },
    {
      capabilities: {}
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let currentTools = [];
  let dynamicToolNames = new Map();
  let toolListChanged = false;
  let scriptedDecisionIndex = 0;

  client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
    toolListChanged = true;
    notifications.push({
      type: "notification",
      method: notification.method,
      atStep: transcript.length
    });
  });

  async function refreshTools(reason) {
    const startedAtStep = performance.now();
    const listResult = await client.listTools();
    currentTools = listResult.tools ?? [];
    dynamicToolNames = originalToolNameMap(currentTools);
    transcript.push({
      type: "list_tools",
      reason,
      latencyMs: performance.now() - startedAtStep,
      toolNames: currentTools.map((tool) => tool.name),
      tools: currentTools.map(publicTool)
    });
    return currentTools;
  }

  try {
    await relay.server.connect(serverTransport);
    await client.connect(clientTransport);
    await refreshTools("initial");

    if (testCase.seedSites?.length > 0) {
      for (const url of testCase.seedSites) {
        await callMcpTool(client, transcript, {
          toolName: "open_page",
          arguments: {
            url,
            timeout: options.navigationTimeout
          },
          reason: "seed registry"
        }, { dynamicToolNames, maxResultChars });
        await refreshTools("seed_site");
        toolListChanged = false;
      }
    }

    if (testCase.resetUrl) {
      await callMcpTool(client, transcript, {
        toolName: "open_page",
        arguments: {
          url: testCase.resetUrl,
          timeout: options.navigationTimeout
        },
        reason: "reset active page after seeding"
      }, { dynamicToolNames, maxResultChars });
      await refreshTools("reset_url");
      toolListChanged = false;
    }

    for (let step = 1; step <= maxSteps; step += 1) {
      if (toolListChanged) {
        toolListChanged = false;
        await refreshTools("tools/list_changed");
      }

      const decisionStarted = performance.now();
      const decision = options.provider === "scripted"
        ? nextScriptedDecision(testCase, scriptedDecisionIndex++)
        : await completeAgentDecision({
          testCase,
          tools: currentTools,
          transcript,
          notifications,
          step,
          maxSteps,
          options
        });

      transcript.push({
        type: "llm_decision",
        step,
        latencyMs: performance.now() - decisionStarted,
        decision
      });

      if (decision.action === "finish") {
        break;
      }

      if (decision.action === "list_tools") {
        await refreshTools("agent_request");
        continue;
      }

      if (decision.action === "call_tool") {
        await callMcpTool(client, transcript, decision, {
          dynamicToolNames,
          maxResultChars
        });
        continue;
      }

      transcript.push({
        type: "agent_error",
        message: `Unsupported decision action: ${decision.action}`
      });
    }

    const score = scoreAgentTranscript(testCase, transcript);
    return {
      id: testCase.id,
      goal: testCase.goal,
      siteUrl: testCase.siteUrl,
      success: score.success,
      score,
      durationMs: performance.now() - started,
      transcript,
      notifications
    };
  } catch (error) {
    return {
      id: testCase.id,
      goal: testCase.goal,
      siteUrl: testCase.siteUrl,
      success: false,
      error: error.message,
      durationMs: performance.now() - started,
      transcript,
      notifications
    };
  } finally {
    await client.close().catch(() => {});
    await relay.close();
  }
}

async function callMcpTool(client, transcript, decision, { dynamicToolNames, maxResultChars }) {
  const name = decision.toolName ?? decision.name;
  const args = decision.arguments ?? decision.args ?? {};
  const started = performance.now();
  const entry = {
    type: "call_tool",
    name,
    arguments: args,
    reason: decision.reason,
    originalToolName: originalToolNameForCall(name, args, dynamicToolNames)
  };

  if (!name || typeof name !== "string") {
    entry.isError = true;
    entry.error = "Decision is missing string toolName.";
    transcript.push(entry);
    return entry;
  }

  try {
    const result = await client.callTool({
      name,
      arguments: args
    });
    entry.latencyMs = performance.now() - started;
    entry.isError = result.isError === true;
    entry.resultText = truncate(resultText(result), maxResultChars);
    entry.structuredContent = truncateJson(result.structuredContent, maxResultChars);
    transcript.push(entry);
    return entry;
  } catch (error) {
    entry.latencyMs = performance.now() - started;
    entry.isError = true;
    entry.error = error.message;
    transcript.push(entry);
    return entry;
  }
}

async function completeAgentDecision({ testCase, tools, transcript, notifications, step, maxSteps, options }) {
  const model = new OpenAiCompatibleAgentModel(options);
  return model.completeDecision({
    testCase,
    tools,
    transcript: transcriptForPrompt(transcript),
    notifications,
    step,
    maxSteps
  });
}

class OpenAiCompatibleAgentModel {
  constructor(options) {
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1")
      .replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env[options.apiKeyEnv ?? "OPENAI_API_KEY"];
    this.model = options.model ?? process.env.WEBMCP_RELAY_AGENT_MODEL ?? process.env.OPENAI_MODEL;
    this.temperature = options.temperature ?? 0;
    this.useResponseFormat = options.responseFormat !== false;
  }

  async completeDecision(context) {
    if (!this.apiKey) {
      throw new Error("Agent eval requires an API key. Set OPENAI_API_KEY or pass --api-key-env.");
    }
    if (!this.model) {
      throw new Error("Agent eval requires --model or WEBMCP_RELAY_AGENT_MODEL.");
    }

    const body = {
      model: this.model,
      temperature: this.temperature,
      messages: [
        {
          role: "system",
          content: agentSystemPrompt()
        },
        {
          role: "user",
          content: JSON.stringify(promptPayload(context), null, 2)
        }
      ]
    };

    if (this.useResponseFormat) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`LLM request failed ${response.status}: ${truncate(text, 1000)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`LLM response was not JSON: ${truncate(text, 1000)}`);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`LLM response did not contain message content: ${truncate(text, 1000)}`);
    }

    return parseAgentDecision(content);
  }
}

function agentSystemPrompt() {
  return [
    "You are controlling an MCP client connected to webmcp-relay.",
    "Choose exactly one next action and return only JSON.",
    "You can list MCP tools, call one available MCP tool, or finish.",
    "If a siteUrl is supplied, normally call open_page first to navigate and discover page WebMCP tools.",
    "After opening a WebMCP page, dynamic tools may appear. Prefer direct dynamic tools such as webmcp_tool_set_pizza_size when they are available.",
    "Use webmcp_search_registry and webmcp_execute_registry_tool when the task refers to tools discovered over time or pre-seeded registry tools.",
    "Use schemas exactly, including enum values and required fields.",
    "JSON shape: {\"action\":\"list_tools\"} or {\"action\":\"call_tool\",\"toolName\":\"...\",\"arguments\":{},\"reason\":\"...\"} or {\"action\":\"finish\",\"answer\":\"...\"}."
  ].join(" ");
}

function promptPayload({ testCase, tools, transcript, notifications, step, maxSteps }) {
  return {
    goal: testCase.goal,
    siteUrl: testCase.siteUrl,
    seededSites: testCase.seedSites ?? [],
    successCriteria: testCase.successCriteria ?? {},
    step,
    maxSteps,
    availableTools: tools.map(publicTool),
    notifications,
    transcript
  };
}

export function parseAgentDecision(text) {
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Agent decision was not a JSON object: ${truncate(String(text), 1000)}`);
  }

  const action = parsed.action;
  if (!["list_tools", "call_tool", "finish"].includes(action)) {
    throw new Error(`Unsupported agent action: ${action}`);
  }

  return {
    action,
    toolName: parsed.toolName ?? parsed.name,
    arguments: parsed.arguments ?? parsed.args ?? {},
    reason: parsed.reason,
    answer: parsed.answer
  };
}

export function scoreAgentTranscript(testCase, transcript) {
  const criteria = testCase.successCriteria ?? {};
  const callEntries = transcript.filter((entry) => entry.type === "call_tool");
  const calledMcpToolNames = callEntries.map((entry) => entry.name).filter(Boolean);
  const calledWebmcpToolNames = callEntries
    .map((entry) => entry.originalToolName)
    .filter(Boolean);
  const outputText = callEntries
    .map((entry) => [entry.resultText, entry.error].filter(Boolean).join("\n"))
    .join("\n");
  const finishText = transcript
    .filter((entry) => entry.type === "llm_decision" && entry.decision?.action === "finish")
    .map((entry) => entry.decision.answer)
    .filter(Boolean)
    .join("\n");
  const combinedText = `${outputText}\n${finishText}`;
  const mustCallMcpTools = normaliseList(criteria.mustCallMcpTools);
  const mustCallWebmcpTools = normaliseList(
    criteria.mustCallWebmcpTools ?? criteria.mustCallTools
  );
  const mustIncludeOutputs = normaliseList(
    criteria.mustIncludeOutputs ?? criteria.expectedOutputIncludes
  );
  const mustFinish = criteria.mustFinish !== false;
  const missingMcpToolCalls = mustCallMcpTools.filter((name) =>
    !calledMcpToolNames.includes(name)
  );
  const missingWebmcpToolCalls = mustCallWebmcpTools.filter((name) =>
    !calledWebmcpToolNames.includes(name)
  );
  const missingOutputIncludes = mustIncludeOutputs.filter((text) =>
    !combinedText.includes(text)
  );
  const errorCalls = callEntries.filter((entry) => entry.isError);
  const finished = !mustFinish ||
    transcript.some((entry) => entry.type === "llm_decision" && entry.decision?.action === "finish");
  const success =
    missingMcpToolCalls.length === 0 &&
    missingWebmcpToolCalls.length === 0 &&
    missingOutputIncludes.length === 0 &&
    (criteria.allowErrors === true || errorCalls.length === 0) &&
    finished;

  return {
    success,
    finished,
    calledMcpToolNames,
    calledWebmcpToolNames,
    missingMcpToolCalls,
    missingWebmcpToolCalls,
    missingOutputIncludes,
    errorCallCount: errorCalls.length,
    toolCallCount: callEntries.length,
    llmDecisionCount: transcript.filter((entry) => entry.type === "llm_decision").length,
    outputText: truncate(combinedText, DEFAULT_MAX_RESULT_CHARS)
  };
}

export async function loadAgentEvalCases(files) {
  const cases = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text);
    const fileCases = Array.isArray(parsed) ? parsed : parsed.cases ?? [parsed];
    cases.push(...fileCases.map((testCase) => validateAgentEvalCase(testCase, file)));
  }

  return cases;
}

function validateAgentEvalCase(testCase, file) {
  if (!testCase.id || typeof testCase.id !== "string") {
    throw new Error(`Agent eval case in ${file} is missing string id.`);
  }
  if (!testCase.goal || typeof testCase.goal !== "string") {
    throw new Error(`Agent eval case ${testCase.id} is missing string goal.`);
  }
  if (testCase.siteUrl !== undefined && typeof testCase.siteUrl !== "string") {
    throw new Error(`Agent eval case ${testCase.id} has non-string siteUrl.`);
  }
  if (testCase.seedSites !== undefined && !Array.isArray(testCase.seedSites)) {
    throw new Error(`Agent eval case ${testCase.id} seedSites must be an array.`);
  }

  return testCase;
}

function nextScriptedDecision(testCase, index) {
  const decision = testCase.scriptedDecisions?.[index];
  if (!decision) {
    return {
      action: "finish",
      answer: "No more scripted decisions."
    };
  }
  return parseAgentDecision(JSON.stringify(decision));
}

function publicTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    originalToolName: originalToolNameFromTool(tool)
  };
}

function originalToolNameMap(tools) {
  return new Map(
    tools
      .map((tool) => [tool.name, originalToolNameFromTool(tool)])
      .filter(([, original]) => original)
  );
}

function originalToolNameFromTool(tool) {
  return tool?._meta?.["webmcp/originalToolName"];
}

function originalToolNameForCall(name, args, dynamicToolNames) {
  if (dynamicToolNames.has(name)) {
    return dynamicToolNames.get(name);
  }

  if (name === "webmcp_call_tool") {
    return args?.name ?? args?.toolName;
  }

  return undefined;
}

function transcriptForPrompt(transcript) {
  return transcript.map((entry) => {
    if (entry.type === "list_tools") {
      return {
        type: entry.type,
        reason: entry.reason,
        toolNames: entry.toolNames
      };
    }

    if (entry.type === "call_tool") {
      return {
        type: entry.type,
        name: entry.name,
        originalToolName: entry.originalToolName,
        arguments: entry.arguments,
        isError: entry.isError,
        resultText: truncate(entry.resultText ?? entry.error ?? "", 2000)
      };
    }

    return entry;
  });
}

function resultText(result) {
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  if (text) {
    return text;
  }

  return JSON.stringify({
    structuredContent: result.structuredContent,
    _meta: result._meta
  });
}

function summarizeAgentResults(results) {
  const total = results.length;
  const success = results.filter((result) => result.success).length;
  const toolCalls = results.flatMap((result) => result.score?.calledMcpToolNames ?? []);
  const llmDecisionCounts = results.map((result) => result.score?.llmDecisionCount).filter(Number.isFinite);

  return {
    total,
    success,
    successRate: ratio(success, total),
    totalToolCalls: toolCalls.length,
    averageLlmDecisions: average(llmDecisionCounts)
  };
}

function parseJsonLoose(text) {
  const trimmed = String(text).trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }
    throw new Error("No JSON object found.");
  }
}

function normaliseList(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function truncateJson(value, maxChars) {
  if (value === undefined) {
    return undefined;
  }
  return truncate(JSON.stringify(value), maxChars);
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...<truncated>`;
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
