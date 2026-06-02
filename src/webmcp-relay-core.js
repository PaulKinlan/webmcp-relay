import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";

export const RELAY_TOOL_NAMES = {
  openSite: "webmcp_open_site",
  refreshTools: "webmcp_refresh_tools",
  listTools: "webmcp_list_tools",
  callTool: "webmcp_call_tool"
};

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
};

export class WebmcpRelay {
  constructor({ bridge, mode = "stable" }) {
    if (!bridge) {
      throw new Error("WebmcpRelay requires a DevtoolsWebmcpClient bridge.");
    }

    this.bridge = bridge;
    this.mode = mode;
    this.currentUrl = undefined;
    this.siteTools = [];
    this.dynamicToolMap = new Map();
    this.server = new Server(
      {
        name: mode === "dynamic" ? "webmcp-relay" : "webmcp-relay-stable",
        version: "0.1.0"
      },
      {
        capabilities: {
          tools: {
            listChanged: true
          }
        },
        instructions:
          mode === "dynamic"
            ? "Open a WebMCP-enabled page with webmcp_open_site. The server exposes discovered page tools directly and emits tools/list_changed when they change. Use webmcp_call_tool as a fallback."
            : "Open a WebMCP-enabled page with webmcp_open_site, inspect tools with webmcp_list_tools, and call them with webmcp_call_tool."
      }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listMcpTools()
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      return this.callMcpTool(name, args);
    });
  }

  async close() {
    await this.bridge.close();
    await this.server.close().catch(() => {});
  }

  async openInitialUrl(options = {}) {
    if (!options.url) {
      return;
    }

    await this.openSite({
      url: options.url,
      waitForText: options.waitForText,
      timeout: options.navigationTimeout,
      pageIdx: options.pageIdx
    }, { notify: false });
  }

  listMcpTools() {
    const tools = [
      openSiteTool(),
      refreshToolsTool(),
      listSiteToolsTool(),
      callSiteTool()
    ];

    if (this.mode === "dynamic") {
      tools.push(...this.siteTools.map((tool) => this.toDynamicMcpTool(tool)));
    }

    return tools;
  }

  async callMcpTool(name, args) {
    switch (name) {
      case RELAY_TOOL_NAMES.openSite:
        return this.openSite(args);
      case RELAY_TOOL_NAMES.refreshTools:
        return this.refreshTools();
      case RELAY_TOOL_NAMES.listTools:
        return this.listSiteTools(args);
      case RELAY_TOOL_NAMES.callTool:
        return this.callSiteTool(args);
      default:
        return this.callDynamicTool(name, args);
    }
  }

  async openSite(args = {}, options = {}) {
    if (!args.url || typeof args.url !== "string") {
      throw invalidParams(`${RELAY_TOOL_NAMES.openSite} requires a string url.`);
    }

    await this.bridge.navigate(args.url, {
      waitForText: args.waitForText,
      timeout: args.timeout,
      pageIdx: args.pageIdx
    });
    this.currentUrl = args.url;
    await this.refreshTools({ notify: false });

    if (options.notify !== false) {
      this.notifyToolsChanged();
    }

    return jsonResult(
      `Opened ${args.url}. Discovered ${this.siteTools.length} WebMCP tool(s).`,
      {
        url: args.url,
        tools: this.publicSiteTools()
      }
    );
  }

  async refreshTools(options = {}) {
    const { tools } = await this.bridge.listPageTools();
    this.siteTools = tools;
    this.rebuildDynamicToolMap();

    if (options.notify !== false) {
      this.notifyToolsChanged();
    }

    return jsonResult(`Discovered ${this.siteTools.length} WebMCP tool(s).`, {
      url: this.currentUrl,
      tools: this.publicSiteTools()
    });
  }

  async listSiteTools(args = {}) {
    if (args.refresh !== false) {
      await this.refreshTools({ notify: false });
    }

    return jsonResult(`The current page exposes ${this.siteTools.length} WebMCP tool(s).`, {
      url: this.currentUrl,
      tools: this.publicSiteTools()
    });
  }

  async callSiteTool(args = {}) {
    const name = args.name ?? args.toolName;
    if (!name || typeof name !== "string") {
      throw invalidParams(`${RELAY_TOOL_NAMES.callTool} requires name.`);
    }

    return this.bridge.executePageTool(name, normaliseToolInput(args.input));
  }

  async callDynamicTool(name, args = {}) {
    const siteToolName = this.dynamicToolMap.get(name);
    if (!siteToolName) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return this.bridge.executePageTool(siteToolName, args);
  }

  toDynamicMcpTool(tool) {
    const name = this.dynamicNameForSiteTool(tool.name);
    const inputSchema = normaliseInputSchema(tool.inputSchema);
    return {
      name,
      title: tool.title,
      description: tool.description
        ? `WebMCP page tool "${tool.name}": ${tool.description}`
        : `WebMCP page tool "${tool.name}".`,
      inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      _meta: {
        "webmcp/originalToolName": tool.name
      },
      execution: {
        taskSupport: "forbidden"
      }
    };
  }

  publicSiteTools() {
    return this.siteTools.map((tool) => ({
      name: tool.name,
      dynamicName:
        this.mode === "dynamic" ? this.dynamicNameForSiteTool(tool.name) : undefined,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations
    }));
  }

  rebuildDynamicToolMap() {
    this.dynamicToolMap = new Map();
    const usedNames = new Set(Object.values(RELAY_TOOL_NAMES));

    for (const tool of this.siteTools) {
      const name = dynamicMcpToolName(tool.name, usedNames);
      usedNames.add(name);
      this.dynamicToolMap.set(name, tool.name);
    }
  }

  dynamicNameForSiteTool(siteToolName) {
    for (const [dynamicName, originalName] of this.dynamicToolMap.entries()) {
      if (originalName === siteToolName) {
        return dynamicName;
      }
    }

    return undefined;
  }

  notifyToolsChanged() {
    if (this.mode !== "dynamic") {
      return;
    }

    this.server.sendToolListChanged().catch(() => {});
  }
}

export function dynamicMcpToolName(siteToolName, usedNames = new Set()) {
  const sanitized =
    String(siteToolName)
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool";
  const base = `webmcp_tool_${sanitized}`;

  if (!usedNames.has(base)) {
    return base;
  }

  let counter = 2;
  while (usedNames.has(`${base}_${counter}`)) {
    counter += 1;
  }
  return `${base}_${counter}`;
}

function openSiteTool() {
  return {
    name: RELAY_TOOL_NAMES.openSite,
    description: "Navigate Chrome to a WebMCP-enabled page and discover its tools.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Page URL to open."
        },
        waitForText: {
          type: "string",
          description: "Optional visible text to wait for after navigation."
        },
        timeout: {
          type: "number",
          description: "Navigation timeout in milliseconds."
        },
        pageIdx: {
          type: "number",
          description: "Optional Chrome DevTools MCP page index."
        }
      },
      required: ["url"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function refreshToolsTool() {
  return {
    name: RELAY_TOOL_NAMES.refreshTools,
    description:
      "Refresh the WebMCP tool list from the current page. Dynamic mode emits tools/list_changed.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function listSiteToolsTool() {
  return {
    name: RELAY_TOOL_NAMES.listTools,
    description: "List WebMCP tools currently exposed by the page.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: {
          type: "boolean",
          description: "Refresh from the page before returning tools. Defaults to true."
        }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function callSiteTool() {
  return {
    name: RELAY_TOOL_NAMES.callTool,
    description:
      "Call a WebMCP page tool by its original name. Use this as the stable fallback when dynamic tools are not refreshed by the client.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Original WebMCP tool name."
        },
        toolName: {
          type: "string",
          description: "Alias for name."
        },
        input: {
          description: "Tool parameters as an object or a JSON string.",
          anyOf: [
            {
              type: "object",
              additionalProperties: true
            },
            {
              type: "string"
            }
          ]
        }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function normaliseToolInput(input) {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function normaliseInputSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return EMPTY_OBJECT_SCHEMA;
  }

  if (schema.type === "object") {
    return {
      ...schema,
      properties: schema.properties ?? {},
      additionalProperties: schema.additionalProperties ?? false
    };
  }

  return EMPTY_OBJECT_SCHEMA;
}

function jsonResult(text, structuredContent) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    structuredContent
  };
}

function invalidParams(message) {
  return new McpError(ErrorCode.InvalidParams, message);
}
