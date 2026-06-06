#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCommonArgs, readValue, splitOption } from "./cli.js";
import { DevtoolsWebmcpClient } from "./devtools-webmcp-client.js";
import { runEvalCli } from "./eval-cli.js";
import { createLogger } from "./logger.js";
import { runRegistryCli } from "./registry-cli.js";
import { TelemetryStore } from "./telemetry-store.js";
import { ToolRegistry } from "./tool-registry.js";
import { WebmcpRelay } from "./webmcp-relay-core.js";

async function main() {
  if (process.argv[2] === "eval") {
    await runEvalCli(process.argv.slice(3));
    return;
  }

  if (process.argv[2] === "registry") {
    await runRegistryCli(process.argv.slice(3));
    return;
  }

  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const logger = createLogger({
    level: options.logLevel,
    file: options.logFile,
    component: "webmcp-relay"
  });
  logger.info("process.start", {
    mode: options.mode,
    headless: options.headless,
    channel: options.channel,
    browserUrl: options.browserUrl,
    registryEnabled: options.registryEnabled,
    telemetryEnabled: options.telemetryEnabled,
    registryDb: options.registryDb,
    telemetryDb: options.telemetryDb,
    logLevel: options.logLevel,
    logFile: options.logFile
  });

  const bridge = new DevtoolsWebmcpClient({
    ...options,
    logger: logger.child("devtools")
  });
  const registry = new ToolRegistry({
    path: options.registryDb,
    enabled: options.registryEnabled
  });
  const telemetry = new TelemetryStore({
    path: options.telemetryDb,
    enabled: options.telemetryEnabled
  });
  const relay = new WebmcpRelay({
    bridge,
    mode: options.mode,
    registry,
    telemetry,
    logger: logger.child("relay")
  });

  try {
    await relay.openInitialUrl(options);
    logger.info("server.connect.start", {
      transport: "stdio"
    });
    await relay.server.connect(new StdioServerTransport());
    logger.info("server.connect.done", {
      transport: "stdio"
    });
  } catch (error) {
    logger.error("process.error", {
      error
    });
    process.stderr.write(`WebMCP relay failed: ${error.message}\n`);
    const stderr = bridge.serverStderr();
    if (stderr) {
      process.stderr.write(`\nChrome DevTools MCP stderr:\n${stderr}\n`);
    }
    process.exitCode = 1;
    await relay.close();
    logger.close();
  }
}

function parseArgs(args) {
  const commonArgs = [];
  const extra = {
    mode: "dynamic",
    registryEnabled: true,
    telemetryEnabled: true
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
      case "--telemetry-db":
        extra.telemetryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--no-telemetry":
        extra.telemetryEnabled = false;
        break;
      case "--log-level":
        extra.logLevel = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--log-file":
        extra.logFile = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--no-log":
        extra.logLevel = "off";
        break;
      default:
        commonArgs.push(arg);
        break;
    }
  }

  if (!["stable", "dynamic"].includes(extra.mode)) {
    throw new Error(`Unsupported mode: ${extra.mode}`);
  }

  const common = parseCommonArgs(commonArgs);
  return {
    ...common,
    ...extra,
    logLevel:
      extra.logLevel ??
      process.env.WEBMCP_RELAY_LOG_LEVEL ??
      (common.verbose ? "debug" : "warn"),
    logFile: extra.logFile ?? process.env.WEBMCP_RELAY_LOG_FILE
  };
}

function helpText() {
  return `Usage:
  webmcp-relay
  webmcp-relay --stable
  webmcp-relay --dynamic

Modes:
  --stable       Expose wrapper tools including open_page, webmcp_list_tools, and webmcp_call_tool.
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
  --telemetry-db <path>     Local SQLite telemetry path. Defaults to the user data directory.
  --no-telemetry            Disable local telemetry logging.
  --log-level <level>       Log level: off, error, warn, info, debug. Default: warn.
  --log-file <path>         Also append logs to a file. Uses WEBMCP_RELAY_LOG_FILE if set.
  --no-log                  Disable relay logs.
  --verbose                 Debug logging plus inherited Chrome DevTools MCP stderr.

Eval:
  webmcp-relay eval run <case.json...> --report ./report.json
  webmcp-relay eval agent <agent-case.json...> --model <model> --report ./agent-report.json
  webmcp-relay eval search <search-case.json...> --report ./search-report.json
  webmcp-relay eval harness prepare <agent-case.json...> --out ./harness-run
  webmcp-relay eval harness run codex <agent-case.json...> --out ./harness-run
  webmcp-relay eval harness score ./harness-run --report ./harness-score.json

Registry:
  webmcp-relay registry list --registry-db ./registry.sqlite
  webmcp-relay registry search "filter server logs"
  webmcp-relay registry show <registry-id>
  webmcp-relay registry stats
`;
}

main();
