import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertRequiredChromeTools,
  buildChromeDevToolsMcpArgs,
  executeWebmcpTool,
  listWebmcpTools,
  navigateToUrl
} from "./discovery.js";
import { noopLogger } from "./logger.js";

export class DevtoolsWebmcpClient {
  constructor(options = {}) {
    this.options = {
      command: "npx",
      mcpPackage: "chrome-devtools-mcp@latest",
      headless: false,
      isolated: true,
      navigationTimeout: 30000,
      extraServerArgs: [],
      verbose: false,
      ...options
    };
    this.client = null;
    this.transport = null;
    this.chromeToolNames = [];
    this.stderrChunks = [];
    this.logger = this.options.logger ?? noopLogger;
  }

  async connect() {
    if (this.client) {
      return;
    }

    const args = buildChromeDevToolsMcpArgs(this.options);
    this.logger.info("connect.start", {
      command: this.options.command,
      args,
      browserUrl: this.options.browserUrl,
      channel: this.options.channel,
      headless: this.options.headless
    });

    this.transport = new StdioClientTransport({
      command: this.options.command,
      args,
      stderr: this.options.verbose ? "inherit" : "pipe"
    });

    if (!this.options.verbose && this.transport.stderr) {
      this.transport.stderr.on("data", (chunk) => {
        this.stderrChunks.push(String(chunk));
      });
    }

    this.client = new Client(
      {
        name: "webmcp-devtools-bridge",
        version: "0.1.0"
      },
      {
        capabilities: {}
      }
    );

    try {
      await this.client.connect(this.transport);
      await this.refreshChromeTools();
      this.logger.info("connect.done", {
        chromeToolCount: this.chromeToolNames.length,
        hasWebmcpList: this.chromeToolNames.includes("list_webmcp_tools"),
        hasWebmcpExecute: this.chromeToolNames.includes("execute_webmcp_tool")
      });
    } catch (error) {
      this.logger.error("connect.error", {
        error
      });
      throw error;
    }
  }

  async close() {
    if (!this.client) {
      return;
    }

    const client = this.client;
    this.client = null;
    this.transport = null;
    this.logger.info("close.start");
    await client.close().catch(() => {});
    this.logger.info("close.done");
  }

  async refreshChromeTools() {
    await this.ensureConnected();
    const result = await this.client.listTools();
    this.chromeToolNames = (result.tools ?? []).map((tool) => tool.name);
    assertRequiredChromeTools(this.chromeToolNames);
    this.logger.debug("chrome_tools.refreshed", {
      count: this.chromeToolNames.length,
      toolNames: this.chromeToolNames
    });
    return this.chromeToolNames;
  }

  async navigate(url, options = {}) {
    const startedAt = performance.now();
    this.logger.info("navigate.start", {
      url,
      pageIdx: options.pageIdx ?? this.options.pageIdx,
      waitForText: Boolean(options.waitForText),
      timeout: options.timeout ?? this.options.navigationTimeout
    });

    await this.ensureConnected();
    try {
      await navigateToUrl(this.client, {
        url,
        pageIdx: options.pageIdx ?? this.options.pageIdx,
        timeout: options.timeout ?? this.options.navigationTimeout,
        chromeToolNames: this.chromeToolNames
      });

      if (options.waitForText) {
        await this.client.callTool({
          name: "wait_for",
          arguments: {
            text: options.waitForText,
            timeout: options.timeout ?? this.options.navigationTimeout
          }
        });
      }

      this.logger.info("navigate.done", {
        url,
        latencyMs: performance.now() - startedAt
      });
    } catch (error) {
      this.logger.error("navigate.error", {
        url,
        latencyMs: performance.now() - startedAt,
        error
      });
      throw error;
    }
  }

  async listPageTools(options = {}) {
    const startedAt = performance.now();
    this.logger.info("webmcp_tools.list.start", {
      pageIdx: options.pageIdx ?? this.options.pageIdx
    });
    await this.ensureConnected();
    try {
      const result = await listWebmcpTools(this.client, {
        pageIdx: options.pageIdx ?? this.options.pageIdx
      });
      this.logger.info("webmcp_tools.list.done", {
        toolCount: result.tools.length,
        toolNames: result.tools.map((tool) => tool.name),
        latencyMs: performance.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logger.error("webmcp_tools.list.error", {
        latencyMs: performance.now() - startedAt,
        error
      });
      throw error;
    }
  }

  async executePageTool(name, input, options = {}) {
    const startedAt = performance.now();
    this.logger.info("webmcp_tool.execute.start", {
      toolName: name,
      pageIdx: options.pageIdx ?? this.options.pageIdx,
      inputKeys: input && typeof input === "object" && !Array.isArray(input)
        ? Object.keys(input)
        : undefined
    });
    await this.ensureConnected();
    try {
      const result = await executeWebmcpTool(this.client, name, input, {
        pageIdx: options.pageIdx ?? this.options.pageIdx
      });
      this.logger.info("webmcp_tool.execute.done", {
        toolName: name,
        isError: result.isError === true,
        latencyMs: performance.now() - startedAt
      });
      return result;
    } catch (error) {
      this.logger.error("webmcp_tool.execute.error", {
        toolName: name,
        latencyMs: performance.now() - startedAt,
        error
      });
      throw error;
    }
  }

  serverStderr() {
    return this.stderrChunks.join("").trim();
  }

  async ensureConnected() {
    if (!this.client) {
      await this.connect();
    }
  }
}
