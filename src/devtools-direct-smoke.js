#!/usr/bin/env node

import { parseCommonArgs, readJsonArgument, readValue, splitOption } from "./cli.js";
import { DevtoolsWebmcpClient } from "./devtools-webmcp-client.js";

const DEFAULT_URL = "https://googlechromelabs.github.io/webmcp-tools/demos/analytics-dashboard/";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(helpText());
    return;
  }

  const bridge = new DevtoolsWebmcpClient(options);

  try {
    await bridge.connect();

    if (options.url) {
      await bridge.navigate(options.url, options);
    }

    const { tools, rawResult } = await bridge.listPageTools(options);

    if (options.call) {
      const callResult = await bridge.executePageTool(
        options.call,
        readJsonArgument(options.input),
        options
      );
      printResult({
        url: options.url,
        chromeToolNames: bridge.chromeToolNames,
        tools,
        called: options.call,
        callResult,
        rawListResult: options.raw ? rawResult : undefined
      }, options);
      return;
    }

    printResult({
      url: options.url,
      chromeToolNames: bridge.chromeToolNames,
      tools,
      rawListResult: options.raw ? rawResult : undefined
    }, options);
  } catch (error) {
    console.error(`Direct DevTools MCP smoke failed: ${error.message}`);
    const stderr = bridge.serverStderr();
    if (stderr) {
      console.error("\nChrome DevTools MCP stderr:");
      console.error(stderr);
    }
    process.exitCode = 1;
  } finally {
    await bridge.close();
  }
}

function parseArgs(args) {
  const commonArgs = [];
  const extra = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--call":
        extra.call = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--input":
        extra.input = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      default:
        commonArgs.push(arg);
        break;
    }
  }

  return {
    ...parseCommonArgs(commonArgs, {
      url: DEFAULT_URL,
      headless: true
    }),
    ...extra
  };
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`URL: ${result.url}`);
  console.log(`Chrome DevTools MCP tools: ${result.chromeToolNames.length}`);
  console.log(`WebMCP page tools: ${result.tools.length}`);
  for (const tool of result.tools) {
    const inputs = Object.keys(tool.inputSchema?.properties ?? {});
    const inputText = inputs.length > 0 ? ` inputs=${inputs.join(",")}` : "";
    const description = tool.description ? ` - ${firstLine(tool.description)}` : "";
    console.log(`- ${tool.name}${description}${inputText}`);
  }

  if (result.called) {
    console.log("");
    console.log(`Called: ${result.called}`);
    console.log(formatCallResult(result.callResult));
  }
}

function formatCallResult(result) {
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  if (text) {
    return text;
  }

  return JSON.stringify(result, null, 2);
}

function firstLine(text) {
  return String(text).split(/\r?\n/)[0].trim();
}

function helpText() {
  return `Usage:
  npm run smoke:devtools -- --url <webmcp-site-url>

Examples:
  npm run smoke:devtools -- --headless
  npm run smoke:devtools -- --url https://googlechromelabs.github.io/webmcp-tools/demos/analytics-dashboard/
  npm run smoke:devtools -- --call query --input '{"method":"POST","status":"500","groupBy":"status","measure":"count","chartType":"table"}'

This uses Chrome DevTools MCP directly with list_webmcp_tools and execute_webmcp_tool.`;
}

main();
