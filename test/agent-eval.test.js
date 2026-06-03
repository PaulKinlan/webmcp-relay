import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseAgentDecision, scoreAgentTranscript } from "../src/agent-eval.js";

test("agent decision parser accepts fenced JSON decisions", () => {
  const decision = parseAgentDecision(`\`\`\`json
  {
    "action": "call_tool",
    "toolName": "open_page",
    "arguments": {
      "url": "https://example.com"
    },
    "reason": "Open the page."
  }
  \`\`\``);

  assert.deepEqual(decision, {
    action: "call_tool",
    toolName: "open_page",
    arguments: {
      url: "https://example.com"
    },
    reason: "Open the page.",
    answer: undefined
  });
});

test("agent transcript scorer checks MCP calls, WebMCP calls, output, and finish", () => {
  const score = scoreAgentTranscript(
    {
      successCriteria: {
        mustCallMcpTools: ["open_page"],
        mustCallWebmcpTools: ["set_pizza_size"],
        mustIncludeOutputs: ["Set pizza size to Large"]
      }
    },
    [
      {
        type: "call_tool",
        name: "open_page",
        arguments: {
          url: "https://example.com"
        },
        isError: false,
        resultText: "Opened page"
      },
      {
        type: "call_tool",
        name: "webmcp_tool_set_pizza_size",
        originalToolName: "set_pizza_size",
        arguments: {
          size: "Large"
        },
        isError: false,
        resultText: "{\"output\":\"Set pizza size to Large.\"}"
      },
      {
        type: "llm_decision",
        decision: {
          action: "finish",
          answer: "Done"
        }
      }
    ]
  );

  assert.equal(score.success, true);
  assert.deepEqual(score.missingMcpToolCalls, []);
  assert.deepEqual(score.missingWebmcpToolCalls, []);
  assert.deepEqual(score.missingOutputIncludes, []);
});

test("bundled agent eval fixtures are valid and have unique ids", async () => {
  const evalDir = path.resolve("evals", "agent");
  const files = (await fs.readdir(evalDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const ids = new Set();

  assert.equal(files.length >= 2, true);

  for (const file of files) {
    const fullPath = path.join(evalDir, file);
    const parsed = JSON.parse(await fs.readFile(fullPath, "utf8"));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases ?? [parsed];

    for (const evalCase of cases) {
      assert.equal(typeof evalCase.id, "string", `${file} case is missing id`);
      assert.equal(ids.has(evalCase.id), false, `Duplicate agent eval id ${evalCase.id}`);
      ids.add(evalCase.id);

      assert.equal(typeof evalCase.goal, "string", `${evalCase.id} is missing goal`);
      assert.equal(typeof evalCase.successCriteria, "object", `${evalCase.id} is missing criteria`);
      assert.equal(
        Boolean(evalCase.siteUrl || evalCase.seedSites?.length),
        true,
        `${evalCase.id} must define siteUrl or seedSites`
      );
    }
  }
});
