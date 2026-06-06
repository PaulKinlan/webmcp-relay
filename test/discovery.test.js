import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChromeDevToolsMcpArgs,
  discoverWebmcpTools,
  extractWebmcpTools
} from "../src/discovery.js";

test("builds chrome-devtools-mcp args with the WebMCP category and feature flags", () => {
  const args = buildChromeDevToolsMcpArgs({
    channel: "canary",
    headless: true
  });

  assert.deepEqual(args.slice(0, 3), [
    "-y",
    "chrome-devtools-mcp@latest",
    "--category-experimental-webmcp"
  ]);
  assert.equal(args.includes("--headless"), true);
  assert.equal(args.includes("--isolated"), true);
  assert.equal(args.includes("--channel=canary"), true);
  assert.equal(
    args.includes(
      "--chrome-arg=--enable-features=WebMCPTesting,DevToolsWebMCPSupport"
    ),
    true
  );
});

test("connects to an existing browser without adding launch-only Chrome flags", () => {
  const args = buildChromeDevToolsMcpArgs({
    browserUrl: "http://127.0.0.1:9222",
    headless: true,
    channel: "canary"
  });

  assert.equal(args.includes("--browser-url=http://127.0.0.1:9222"), true);
  assert.equal(args.includes("--headless"), false);
  assert.equal(args.includes("--channel=canary"), false);
  assert.equal(
    args.some((arg) => arg.startsWith("--chrome-arg=--enable-features=")),
    false
  );
});

test("always includes required WebMCP Chrome feature flags when launching", () => {
  const args = buildChromeDevToolsMcpArgs({
    chromeFeatures: "SomeOtherFeature"
  });

  assert.equal(
    args.includes(
      "--chrome-arg=--enable-features=SomeOtherFeature,WebMCPTesting,DevToolsWebMCPSupport"
    ),
    true
  );
});

test("navigates before listing WebMCP tools", async () => {
  const client = new MockClient();
  const result = await discoverWebmcpTools(client, {
    url: "https://example.com"
  });

  assert.deepEqual(
    client.calls.map((call) => call.name),
    ["new_page", "list_webmcp_tools"]
  );
  assert.equal(client.calls[0].arguments.url, "https://example.com");
  assert.equal(result.webmcpTools.length, 3);
  assert.deepEqual(result.webmcpTools.map((tool) => tool.name), [
    "exportLogs",
    "summarizeTraffic",
    "filterLogs"
  ]);
});

test("throws a helpful error when the WebMCP category is not enabled", async () => {
  const client = new MockClient({
    chromeTools: [{ name: "new_page" }]
  });

  await assert.rejects(
    () =>
      discoverWebmcpTools(client, {
        url: "https://example.com"
      }),
    /--category-experimental-webmcp/
  );
});

test("extracts tools from JSON text content", () => {
  const tools = extractWebmcpTools({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tools: [
            {
              name: "searchFlights",
              description: "Search flights by origin and destination"
            }
          ]
        })
      }
    ]
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["searchFlights"]);
});

test("extracts tools from chrome-devtools WebMCP text listings", () => {
  const tools = extractWebmcpTools({
    content: [
      {
        type: "text",
        text: `## WebMCP tools
name="query", description="Query the server logs. Resolve \"last week\" before calling.", inputSchema={"type":"object","properties":{"status":{"type":"string","description":"HTTP status filter."},"method":{"type":"string","description":"HTTP method filter."}},"required":["method"]}, annotations=undefined`
      }
    ]
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "query");
  assert.equal(tools[0].inputSchema.properties.status.description, "HTTP status filter.");
});

class MockClient {
  constructor(options = {}) {
    this.calls = [];
    this.chromeTools =
      options.chromeTools ??
      [
        { name: "new_page" },
        { name: "list_webmcp_tools" },
        { name: "execute_webmcp_tool" }
      ];
  }

  async listTools() {
    return {
      tools: this.chromeTools
    };
  }

  async callTool(call) {
    this.calls.push(call);

    if (call.name === "list_webmcp_tools") {
      return {
        structuredContent: {
          tools: [
            {
              name: "exportLogs",
              description: "Export current server access logs as CSV"
            },
            {
              name: "summarizeTraffic",
              description: "Summarize request traffic by route"
            },
            {
              name: "filterLogs",
              description: "Filter failed requests by status, method, path, and date"
            }
          ]
        }
      };
    }

    return { content: [] };
  }
}
