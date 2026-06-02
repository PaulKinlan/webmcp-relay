import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertRequiredChromeTools,
  buildChromeDevToolsMcpArgs,
  executeWebmcpTool,
  listWebmcpTools,
  navigateToUrl
} from "./discovery.js";

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
  }

  async connect() {
    if (this.client) {
      return;
    }

    this.transport = new StdioClientTransport({
      command: this.options.command,
      args: buildChromeDevToolsMcpArgs(this.options),
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

    await this.client.connect(this.transport);
    await this.refreshChromeTools();
  }

  async close() {
    if (!this.client) {
      return;
    }

    const client = this.client;
    this.client = null;
    this.transport = null;
    await client.close().catch(() => {});
  }

  async refreshChromeTools() {
    await this.ensureConnected();
    const result = await this.client.listTools();
    this.chromeToolNames = (result.tools ?? []).map((tool) => tool.name);
    assertRequiredChromeTools(this.chromeToolNames);
    return this.chromeToolNames;
  }

  async navigate(url, options = {}) {
    await this.ensureConnected();
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
  }

  async listPageTools(options = {}) {
    await this.ensureConnected();
    return listWebmcpTools(this.client, {
      pageIdx: options.pageIdx ?? this.options.pageIdx
    });
  }

  async executePageTool(name, input, options = {}) {
    await this.ensureConnected();
    return executeWebmcpTool(this.client, name, input, {
      pageIdx: options.pageIdx ?? this.options.pageIdx
    });
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
