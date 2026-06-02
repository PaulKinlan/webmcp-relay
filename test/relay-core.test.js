import assert from "node:assert/strict";
import test from "node:test";
import { dynamicMcpToolName, RELAY_TOOL_NAMES, WebmcpRelay } from "../src/webmcp-relay-core.js";

test("stable relay exposes only wrapper tools", () => {
  const relay = new WebmcpRelay({
    bridge: new FakeBridge(),
    mode: "stable"
  });

  const toolNames = relay.listMcpTools().map((tool) => tool.name);
  assert.deepEqual(toolNames, [
    RELAY_TOOL_NAMES.openSite,
    RELAY_TOOL_NAMES.refreshTools,
    RELAY_TOOL_NAMES.listTools,
    RELAY_TOOL_NAMES.callTool
  ]);
});

test("dynamic relay exposes discovered page tools as MCP tools", async () => {
  const bridge = new FakeBridge();
  const relay = new WebmcpRelay({
    bridge,
    mode: "dynamic"
  });

  await relay.openSite({ url: "https://example.com" }, { notify: false });

  const toolNames = relay.listMcpTools().map((tool) => tool.name);
  assert.equal(toolNames.includes("webmcp_tool_query"), true);
  assert.equal(relay.dynamicToolMap.get("webmcp_tool_query"), "query");
});

test("dynamic tool calls dispatch to the original WebMCP tool name", async () => {
  const bridge = new FakeBridge();
  const relay = new WebmcpRelay({
    bridge,
    mode: "dynamic"
  });

  await relay.openSite({ url: "https://example.com" }, { notify: false });
  await relay.callMcpTool("webmcp_tool_query", {
    method: "POST",
    groupBy: "status",
    measure: "count",
    chartType: "table"
  });

  assert.deepEqual(bridge.executed, [
    {
      name: "query",
      input: {
        method: "POST",
        groupBy: "status",
        measure: "count",
        chartType: "table"
      }
    }
  ]);
});

test("stable fallback calls a WebMCP tool by original name", async () => {
  const bridge = new FakeBridge();
  const relay = new WebmcpRelay({
    bridge,
    mode: "stable"
  });

  await relay.callMcpTool(RELAY_TOOL_NAMES.callTool, {
    name: "query",
    input: '{"method":"POST"}'
  });

  assert.deepEqual(bridge.executed, [
    {
      name: "query",
      input: {
        method: "POST"
      }
    }
  ]);
});

test("dynamicMcpToolName sanitizes and avoids collisions", () => {
  const used = new Set(["webmcp_tool_read_logs"]);

  assert.equal(dynamicMcpToolName("read logs", used), "webmcp_tool_read_logs_2");
  assert.equal(dynamicMcpToolName("query", used), "webmcp_tool_query");
});

class FakeBridge {
  constructor() {
    this.executed = [];
  }

  async navigate(url) {
    this.url = url;
  }

  async listPageTools() {
    return {
      tools: [
        {
          name: "query",
          description: "Query logs",
          inputSchema: {
            type: "object",
            properties: {
              method: {
                type: "string"
              }
            }
          }
        }
      ]
    };
  }

  async executePageTool(name, input) {
    this.executed.push({ name, input });
    return {
      content: [
        {
          type: "text",
          text: "ok"
        }
      ]
    };
  }

  async close() {}
}
