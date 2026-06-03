#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCommonArgs, readValue, splitOption } from "./cli.js";
import { DevtoolsWebmcpClient } from "./devtools-webmcp-client.js";
import { ToolRegistry } from "./tool-registry.js";
import { WebmcpRelay } from "./webmcp-relay-core.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const bridge = new DevtoolsWebmcpClient(options);
  const registry = new ToolRegistry({
    path: options.registryDb,
    enabled: options.registryEnabled
  });
  const relay = new WebmcpRelay({
    bridge,
    mode: options.mode,
    registry
  });

  try {
    await relay.openInitialUrl(options);
    await relay.server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`WebMCP relay failed: ${error.message}\n`);
    const stderr = bridge.serverStderr();
    if (stderr) {
      process.stderr.write(`\nChrome DevTools MCP stderr:\n${stderr}\n`);
    }
    process.exitCode = 1;
    await relay.close();
  }
}

function parseArgs(args) {
  const commonArgs = [];
  const extra = {
    mode: "dynamic",
    registryEnabled: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--mode":
        extra.mode = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--dynamic":
        extra.mode = "dynamic";
        break;
      case "--stable":
        extra.mode = "stable";
        break;
      case "--registry-db":
        extra.registryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--no-registry":
        extra.registryEnabled = false;
        break;
      default:
        commonArgs.push(arg);
        break;
    }
  }

  if (!["stable", "dynamic"].includes(extra.mode)) {
    throw new Error(`Unsupported mode: ${extra.mode}`);
  }

  return {
    ...parseCommonArgs(commonArgs),
    ...extra
  };
}

function helpText() {
  return `Usage:
  webmcp-relay
  webmcp-relay --stable
  webmcp-relay --dynamic

Modes:
  --stable       Expose wrapper tools only: webmcp_open_site, webmcp_list_tools, webmcp_call_tool.
  --dynamic      Also expose discovered page WebMCP tools as MCP tools and send tools/list_changed. Default.

Common options:
  --url <url>               Optional page to open before the MCP client connects.
  --browser-url <url>       Connect to an existing Chrome debugging endpoint.
  --headless                Launch Chrome headlessly.
  --channel <name>          Chrome channel for chrome-devtools-mcp to launch.
  --timeout <ms>            Navigation timeout.
  --mcp-package <pkg>       Package spec for npx. Default: chrome-devtools-mcp@latest.
  --server-arg <arg>        Extra argument forwarded to chrome-devtools-mcp. Repeatable.
  --registry-db <path>      Local SQLite registry path. Defaults to the user data directory.
  --no-registry             Disable local registry persistence and global lookup tools.
`;
}

main();
