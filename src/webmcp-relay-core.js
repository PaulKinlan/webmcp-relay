import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { describeArgs, noopLogger } from "./logger.js";

export const RELAY_TOOL_NAMES = {
  openPage: "open_page",
  openSite: "webmcp_open_site",
  refreshTools: "webmcp_refresh_tools",
  listTools: "webmcp_list_tools",
  callTool: "webmcp_call_tool",
  searchRegistry: "webmcp_search_registry",
  executeRegistryTool: "webmcp_execute_registry_tool"
};

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: true
};

export class WebmcpRelay {
  constructor({ bridge, mode = "stable", registry, telemetry, logger }) {
    if (!bridge) {
      throw new Error("WebmcpRelay requires a DevtoolsWebmcpClient bridge.");
    }

    this.bridge = bridge;
    this.mode = mode;
    this.currentUrl = undefined;
    this.siteTools = [];
    this.dynamicToolMap = new Map();
    this.registry = registry;
    this.telemetry = telemetry;
    this.logger = logger ?? noopLogger;
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
            ? "When the user asks to open, visit, go to, load, or navigate to a URL or website, call open_page. This opens Chrome, discovers page WebMCP tools, exposes them directly, and emits tools/list_changed when they change. webmcp_open_site is kept as a compatibility alias. Use webmcp_search_registry to find tools discovered across sites and webmcp_execute_registry_tool to run them."
            : "When the user asks to open, visit, go to, load, or navigate to a URL or website, call open_page. Inspect tools with webmcp_list_tools, call them with webmcp_call_tool, or use webmcp_search_registry for tools discovered across sites. webmcp_open_site is kept as a compatibility alias."
      }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.listMcpTools();
      this.logger.debug("mcp.list_tools", {
        mode: this.mode,
        count: tools.length,
        toolNames: tools.map((tool) => tool.name)
      });
      return {
        tools
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      this.logger.debug("mcp.call_tool.received", {
        toolName: name,
        args: describeArgs(args)
      });
      return this.callMcpTool(name, args);
    });

    this.logger.info("relay.created", {
      mode: this.mode,
      registryEnabled: this.registry?.enabled !== false && Boolean(this.registry),
      telemetryEnabled: this.telemetry?.enabled !== false && Boolean(this.telemetry)
    });
  }

  async close() {
    this.logger.info("relay.close.start");
    await this.bridge.close();
    this.registry?.close?.();
    this.telemetry?.close?.();
    await this.server.close().catch(() => {});
    this.logger.info("relay.close.done");
  }

  async openInitialUrl(options = {}) {
    if (!options.url) {
      this.logger.debug("initial_url.skip");
      return;
    }

    this.logger.info("initial_url.open", {
      url: options.url
    });
    await this.openSite({
      url: options.url,
      waitForText: options.waitForText,
      timeout: options.navigationTimeout,
      pageIdx: options.pageIdx
    }, { notify: false });
  }

  listMcpTools() {
    const tools = [
      openPageTool(),
      openSiteTool(),
      refreshToolsTool(),
      listSiteToolsTool(),
      callSiteTool()
    ];

    if (this.registry && this.registry.enabled !== false) {
      tools.push(searchRegistryTool(), executeRegistryTool());
    }

    if (this.mode === "dynamic") {
      tools.push(...this.siteTools.map((tool) => this.toDynamicMcpTool(tool)));
    }

    return tools;
  }

  async callMcpTool(name, args) {
    this.logger.debug("mcp.call_tool.dispatch", {
      toolName: name,
      args: describeArgs(args)
    });

    switch (name) {
      case RELAY_TOOL_NAMES.openPage:
      case RELAY_TOOL_NAMES.openSite:
        return this.openSite(args);
      case RELAY_TOOL_NAMES.refreshTools:
        return this.refreshTools();
      case RELAY_TOOL_NAMES.listTools:
        return this.listSiteTools(args);
      case RELAY_TOOL_NAMES.callTool:
        return this.callSiteTool(args);
      case RELAY_TOOL_NAMES.searchRegistry:
        return this.searchRegistry(args);
      case RELAY_TOOL_NAMES.executeRegistryTool:
        return this.executeRegistryTool(args);
      default:
        return this.callDynamicTool(name, args);
    }
  }

  async openSite(args = {}, options = {}) {
    return this.withTelemetry(
      "open_site",
      {
        url: args.url
      },
      async () => {
        if (!args.url || typeof args.url !== "string") {
          throw invalidParams(
            `${RELAY_TOOL_NAMES.openPage} requires a string url.`
          );
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
      },
      () => ({
        toolCount: this.siteTools.length
      })
    );
  }

  async refreshTools(options = {}) {
    return this.withTelemetry(
      "refresh_tools",
      {
        url: this.currentUrl
      },
      async () => {
        const { tools } = await this.bridge.listPageTools();
        this.siteTools = tools;
        this.rebuildDynamicToolMap();
        await this.persistCurrentTools();

        if (options.notify !== false) {
          this.notifyToolsChanged();
        }

        return jsonResult(`Discovered ${this.siteTools.length} WebMCP tool(s).`, {
          url: this.currentUrl,
          tools: this.publicSiteTools()
        });
      },
      () => ({
        toolCount: this.siteTools.length,
        toolNames: this.siteTools.map((tool) => tool.name)
      })
    );
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
    return this.withTelemetry(
      "call_site_tool",
      {
        url: this.currentUrl,
        toolName: name
      },
      async () => {
        if (!name || typeof name !== "string") {
          throw invalidParams(`${RELAY_TOOL_NAMES.callTool} requires name.`);
        }

        const result = await this.bridge.executePageTool(name, normaliseToolInput(args.input));
        await this.recordCurrentToolUse(name, result);
        return result;
      }
    );
  }

  async callDynamicTool(name, args = {}) {
    const siteToolName = this.dynamicToolMap.get(name);

    return this.withTelemetry(
      "call_dynamic_tool",
      {
        url: this.currentUrl,
        toolName: siteToolName ?? name
      },
      async () => {
        if (!siteToolName) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }

        const result = await this.bridge.executePageTool(siteToolName, args);
        await this.recordCurrentToolUse(siteToolName, result);
        return result;
      },
      () => ({
        dynamicName: name
      })
    );
  }

  async searchRegistry(args = {}) {
    return this.withTelemetry(
      "search_registry",
      {
        query: args.query ?? args.intent ?? ""
      },
      async () => {
        this.assertRegistry();

        const query = args.query ?? args.intent ?? "";
        if (typeof query !== "string") {
          throw invalidParams(`${RELAY_TOOL_NAMES.searchRegistry} requires query to be a string.`);
        }

        const matches = await this.registry.search(query, {
          limit: args.limit
        });

        return jsonResult(`Found ${matches.length} registry match(es).`, {
          query,
          registryPath: this.registry.path,
          matches: matches.map((match) => publicRegistryMatch(match))
        });
      },
      (result) => ({
        resultCount: result.structuredContent?.matches?.length ?? 0,
        topRegistryId: result.structuredContent?.matches?.[0]?.id,
        topToolName: result.structuredContent?.matches?.[0]?.toolName
      })
    );
  }

  async executeRegistryTool(args = {}) {
    return this.withTelemetry(
      "execute_registry_tool",
      {
        registryId: args.id ?? args.toolId
      },
      async () => {
        this.assertRegistry();

        const id = args.id ?? args.toolId;
        if (!id || typeof id !== "string") {
          throw invalidParams(`${RELAY_TOOL_NAMES.executeRegistryTool} requires id.`);
        }

        const entry = await this.registry.get(id);
        if (!entry) {
          throw invalidParams(`No registry tool found for id: ${id}`);
        }

        await this.bridge.navigate(entry.url, {
          waitForText: args.waitForText,
          timeout: args.timeout
        });
        this.currentUrl = entry.url;
        await this.refreshTools({ notify: false });

        const currentTool = this.siteTools.find((tool) => tool.name === entry.toolName);
        if (!currentTool) {
          throw invalidParams(
            `Registry tool ${entry.toolName} was not exposed after opening ${entry.url}.`
          );
        }

        const result = await this.bridge.executePageTool(entry.toolName, normaliseToolInput(args.input));
        await this.recordRegistryUse(entry.id, result);
        return result;
      },
      () => ({
        url: this.currentUrl
      })
    );
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

    this.logger.info("tools.list_changed", {
      currentUrl: this.currentUrl,
      toolCount: this.siteTools.length,
      toolNames: this.siteTools.map((tool) => tool.name)
    });
    this.server.sendToolListChanged().catch((error) => {
      this.logger.warn("tools.list_changed.error", {
        error
      });
    });
  }

  async persistCurrentTools() {
    if (!this.registry || !this.currentUrl) {
      this.logger.debug("registry.persist.skip", {
        hasRegistry: Boolean(this.registry),
        currentUrl: this.currentUrl
      });
      return;
    }

    const entries = await this.registry.upsertTools(this.currentUrl, this.siteTools);
    this.logger.debug("registry.persist.done", {
      url: this.currentUrl,
      count: entries.length,
      ids: entries.map((entry) => entry.id)
    });
  }

  async recordCurrentToolUse(toolName, result) {
    if (!this.registry || !this.currentUrl || result?.isError) {
      this.logger.debug("registry.record_current_tool_use.skip", {
        hasRegistry: Boolean(this.registry),
        currentUrl: this.currentUrl,
        toolName,
        resultIsError: result?.isError === true
      });
      return;
    }

    const id = this.registry.idFor(this.currentUrl, toolName);
    await this.registry.recordUse(id);
    this.logger.debug("registry.record_current_tool_use.done", {
      id,
      toolName
    });
  }

  async recordRegistryUse(id, result) {
    if (!this.registry || result?.isError) {
      this.logger.debug("registry.record_registry_use.skip", {
        hasRegistry: Boolean(this.registry),
        id,
        resultIsError: result?.isError === true
      });
      return;
    }

    await this.registry.recordUse(id);
    this.logger.debug("registry.record_registry_use.done", {
      id
    });
  }

  assertRegistry() {
    if (!this.registry || this.registry.enabled === false) {
      throw invalidParams("The WebMCP tool registry is disabled.");
    }
  }

  async withTelemetry(eventType, baseEvent, action, metadataFn) {
    const startedAt = performance.now();
    this.logger.info(`${eventType}.start`, baseEvent);

    try {
      const result = await action();
      const metadata = metadataFn ? metadataFn(result) : undefined;
      const latencyMs = performance.now() - startedAt;
      await this.logTelemetry({
        ...baseEvent,
        eventType,
        latencyMs,
        isError: result?.isError === true,
        errorText: result?.isError ? firstTextContent(result) : undefined,
        metadata
      });
      this.logger.info(`${eventType}.done`, {
        ...baseEvent,
        latencyMs,
        isError: result?.isError === true,
        ...metadata
      });
      return result;
    } catch (error) {
      const latencyMs = performance.now() - startedAt;
      await this.logTelemetry({
        ...baseEvent,
        eventType,
        latencyMs,
        isError: true,
        errorText: error.message
      });
      this.logger.error(`${eventType}.error`, {
        ...baseEvent,
        latencyMs,
        error
      });
      throw error;
    }
  }

  async logTelemetry(event) {
    if (!this.telemetry || this.telemetry.enabled === false) {
      return;
    }

    await this.telemetry.log(event);
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

function openPageTool() {
  return {
    name: RELAY_TOOL_NAMES.openPage,
    title: "Open Page",
    description:
      "Open, visit, browse, go to, load, or navigate Chrome to a URL or website. Use this for ordinary navigation requests; it also discovers any WebMCP tools exposed by the page.",
    inputSchema: navigationInputSchema(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function openSiteTool() {
  return {
    name: RELAY_TOOL_NAMES.openSite,
    title: "Open WebMCP Site",
    description:
      "Compatibility alias for open_page. Opens or navigates Chrome to a URL, then discovers WebMCP tools on the page.",
    inputSchema: navigationInputSchema(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function navigationInputSchema() {
  return {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL or website to open, visit, go to, load, or navigate to."
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

function searchRegistryTool() {
  return {
    name: RELAY_TOOL_NAMES.searchRegistry,
    description:
      "Search the local WebMCP tool registry for tools that may satisfy a task or intent across previously discovered sites.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Task, intent, or capability to search for."
        },
        intent: {
          type: "string",
          description: "Alias for query."
        },
        limit: {
          type: "number",
          description: "Maximum results to return. Defaults to 10, max 50."
        }
      },
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false
    },
    execution: {
      taskSupport: "forbidden"
    }
  };
}

function executeRegistryTool() {
  return {
    name: RELAY_TOOL_NAMES.executeRegistryTool,
    description:
      "Open the site for a tool found in the local registry, refresh its WebMCP tools, and execute the selected tool by registry id.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Registry tool id returned by webmcp_search_registry."
        },
        toolId: {
          type: "string",
          description: "Alias for id."
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
        },
        waitForText: {
          type: "string",
          description: "Optional visible text to wait for after opening the site."
        },
        timeout: {
          type: "number",
          description: "Navigation timeout in milliseconds."
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

function publicRegistryMatch(match) {
  const entry = match.entry;
  return {
    id: entry.id,
    score: match.score,
    rank: match.rank,
    url: entry.url,
    origin: entry.origin,
    toolName: entry.toolName,
    title: entry.title,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    useCount: entry.useCount ?? 0,
    lastUsed: entry.lastUsed
  };
}

function firstTextContent(result) {
  return (result?.content ?? []).find((item) => item.type === "text")?.text;
}

function invalidParams(message) {
  return new McpError(ErrorCode.InvalidParams, message);
}
