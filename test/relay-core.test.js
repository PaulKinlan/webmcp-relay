import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolRegistry } from "../src/tool-registry.js";
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

test("registry tools are exposed when a registry is configured", () => {
  const relay = new WebmcpRelay({
    bridge: new FakeBridge(),
    mode: "stable",
    registry: new FakeRegistry()
  });

  const toolNames = relay.listMcpTools().map((tool) => tool.name);
  assert.equal(toolNames.includes(RELAY_TOOL_NAMES.searchRegistry), true);
  assert.equal(toolNames.includes(RELAY_TOOL_NAMES.executeRegistryTool), true);
});

test("opening a site persists discovered tools to the registry", async () => {
  const registry = await tempRegistry();
  const relay = new WebmcpRelay({
    bridge: new FakeBridge(),
    mode: "dynamic",
    registry
  });

  await relay.openSite({ url: "https://example.com/logs" }, { notify: false });

  const entries = await registry.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://example.com/logs");
  assert.equal(entries[0].toolName, "query");
});

test("searching the registry returns global matches", async () => {
  const registry = await tempRegistry();
  const relay = new WebmcpRelay({
    bridge: new FakeBridge(),
    mode: "dynamic",
    registry
  });

  await relay.openSite({ url: "https://example.com/logs" }, { notify: false });
  const result = await relay.callMcpTool(RELAY_TOOL_NAMES.searchRegistry, {
    query: "query logs by method"
  });

  assert.equal(result.structuredContent.matches.length, 1);
  assert.equal(result.structuredContent.matches[0].toolName, "query");
});

test("executing a registry tool opens the stored site and calls the tool", async () => {
  const registry = await tempRegistry();
  const bridge = new FakeBridge();
  const relay = new WebmcpRelay({
    bridge,
    mode: "dynamic",
    registry
  });

  await relay.openSite({ url: "https://example.com/logs" }, { notify: false });
  const [entry] = await registry.list();

  await relay.callMcpTool(RELAY_TOOL_NAMES.executeRegistryTool, {
    id: entry.id,
    input: {
      method: "POST"
    }
  });

  assert.equal(bridge.url, "https://example.com/logs");
  assert.deepEqual(bridge.executed.at(-1), {
    name: "query",
    input: {
      method: "POST"
    }
  });
  assert.equal((await registry.get(entry.id)).useCount, 1);
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

class FakeRegistry {
  constructor() {
    this.enabled = true;
  }

  async search() {
    return [];
  }

  async get() {
    return undefined;
  }
}

async function tempRegistry() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webmcp-relay-test-"));
  return new ToolRegistry({
    path: path.join(dir, "registry.json")
  });
}
