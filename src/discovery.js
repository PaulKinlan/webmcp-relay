export const CHROME_TOOL_NAMES = {
  newPage: "new_page",
  navigatePage: "navigate_page",
  listWebmcpTools: "list_webmcp_tools",
  executeWebmcpTool: "execute_webmcp_tool"
};

export const REQUIRED_WEBMCP_CHROME_FEATURES = [
  "WebMCPTesting",
  "DevToolsWebMCPSupport"
];

export function buildChromeDevToolsMcpArgs(options = {}) {
  const {
    mcpPackage = "chrome-devtools-mcp@latest",
    browserUrl,
    channel,
    headless = false,
    isolated = true,
    chromeFeatures,
    extraServerArgs = []
  } = options;

  const args = ["-y", mcpPackage, "--category-experimental-webmcp"];

  if (browserUrl) {
    args.push(`--browser-url=${browserUrl}`);
  } else {
    if (headless) {
      args.push("--headless");
    }

    if (isolated) {
      args.push("--isolated");
    }

    if (channel) {
      args.push(`--channel=${channel}`);
    }

    const requiredChromeFeatures = webmcpChromeFeatures(chromeFeatures);
    if (requiredChromeFeatures) {
      args.push(`--chrome-arg=--enable-features=${requiredChromeFeatures}`);
    }
  }

  args.push(...extraServerArgs);
  return args;
}

export function webmcpChromeFeatures(chromeFeatures) {
  const featureNames = new Set(
    String(chromeFeatures ?? "")
      .split(",")
      .map((feature) => feature.trim())
      .filter(Boolean)
  );

  for (const feature of REQUIRED_WEBMCP_CHROME_FEATURES) {
    featureNames.add(feature);
  }

  return [...featureNames].join(",");
}

export async function discoverWebmcpTools(client, options) {
  const {
    url,
    waitForText,
    navigationTimeout = 30000,
    pageIdx,
    raw = false
  } = options;

  if (!url) {
    throw new Error("Missing required URL.");
  }

  const chromeToolsResult = await client.listTools();
  const chromeTools = chromeToolsResult.tools ?? [];
  const chromeToolNames = chromeTools.map((tool) => tool.name);

  assertRequiredChromeTools(chromeToolNames);

  await navigateToUrl(client, {
    url,
    pageIdx,
    timeout: navigationTimeout,
    chromeToolNames
  });

  if (waitForText) {
    await client.callTool({
      name: "wait_for",
      arguments: {
        text: waitForText,
        timeout: navigationTimeout
      }
    });
  }

  const webmcpResult = await client.callTool({
    name: CHROME_TOOL_NAMES.listWebmcpTools,
    arguments: pageIdx === undefined ? {} : { pageIdx }
  });

  const webmcpTools = extractWebmcpTools(webmcpResult);

  return {
    url,
    chromeToolNames,
    webmcpTools,
    rawWebmcpResult: raw ? webmcpResult : undefined
  };
}

export async function listWebmcpTools(client, options = {}) {
  const { pageIdx } = options;
  const result = await client.callTool({
    name: CHROME_TOOL_NAMES.listWebmcpTools,
    arguments: pageIdx === undefined ? {} : { pageIdx }
  });

  return {
    tools: extractWebmcpTools(result),
    rawResult: result
  };
}

export async function executeWebmcpTool(client, name, input, options = {}) {
  const { pageIdx } = options;
  const args = {
    toolName: name
  };

  if (input !== undefined) {
    args.input = typeof input === "string" ? input : JSON.stringify(input);
  }

  if (pageIdx !== undefined) {
    args.pageIdx = pageIdx;
  }

  return client.callTool({
    name: CHROME_TOOL_NAMES.executeWebmcpTool,
    arguments: args
  });
}

export function extractWebmcpTools(result) {
  const candidates = [
    result?.structuredContent,
    result?._meta,
    result,
    ...textPayloads(result).map(parseChromeWebmcpListing).filter(Boolean),
    ...textPayloads(result).map(parseJsonLoose).filter(Boolean),
    ...textPayloads(result).map(parseBulletList).filter(Boolean)
  ];

  for (const candidate of candidates) {
    const tools = normaliseTools(candidate);
    if (tools.length > 0) {
      return tools;
    }
  }

  return [];
}

export function assertRequiredChromeTools(chromeToolNames) {
  const missing = [
    CHROME_TOOL_NAMES.listWebmcpTools,
    CHROME_TOOL_NAMES.executeWebmcpTool
  ].filter((name) => !chromeToolNames.includes(name));

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    [
      `Chrome DevTools MCP is missing required WebMCP tool(s): ${missing.join(", ")}.`,
      "Start the server with --category-experimental-webmcp.",
      "For Chrome 149+, also launch Chrome with --enable-features=WebMCPTesting,DevToolsWebMCPSupport."
    ].join(" ")
  );
}

export async function navigateToUrl(client, { url, pageIdx, timeout, chromeToolNames }) {
  if (pageIdx === undefined && chromeToolNames.includes(CHROME_TOOL_NAMES.newPage)) {
    await client.callTool({
      name: CHROME_TOOL_NAMES.newPage,
      arguments: { url, timeout }
    });
    return;
  }

  if (chromeToolNames.includes(CHROME_TOOL_NAMES.navigatePage)) {
    const args = { url, timeout };
    if (pageIdx !== undefined) {
      args.pageIdx = pageIdx;
    }

    await client.callTool({
      name: CHROME_TOOL_NAMES.navigatePage,
      arguments: args
    });
    return;
  }

  throw new Error(
    `Chrome DevTools MCP is missing a navigation tool (${CHROME_TOOL_NAMES.newPage} or ${CHROME_TOOL_NAMES.navigatePage}).`
  );
}

function normaliseTools(candidate) {
  if (!candidate) {
    return [];
  }

  if (Array.isArray(candidate)) {
    return candidate.map(normaliseTool).filter(Boolean);
  }

  if (Array.isArray(candidate.tools)) {
    return candidate.tools.map(normaliseTool).filter(Boolean);
  }

  if (Array.isArray(candidate.webmcpTools)) {
    return candidate.webmcpTools.map(normaliseTool).filter(Boolean);
  }

  if (candidate.name && typeof candidate.name === "string") {
    const tool = normaliseTool(candidate);
    return tool ? [tool] : [];
  }

  return [];
}

function normaliseTool(tool) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  const name = firstString(tool.name, tool.id, tool.toolName);
  if (!name) {
    return null;
  }

  return {
    name,
    title: firstString(tool.title, tool.annotations?.title),
    description: firstString(tool.description, tool.summary, tool.details),
    inputSchema: tool.inputSchema ?? tool.schema ?? tool.parameters,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    raw: tool
  };
}

export function parseJsonLoose(text) {
  const trimmed = String(text).trim();
  if (!trimmed) {
    return null;
  }

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const arrayStart = withoutFence.indexOf("[");
    const arrayEnd = withoutFence.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      try {
        return JSON.parse(withoutFence.slice(arrayStart, arrayEnd + 1));
      } catch {
        return null;
      }
    }

    const objectStart = withoutFence.indexOf("{");
    const objectEnd = withoutFence.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      try {
        return JSON.parse(withoutFence.slice(objectStart, objectEnd + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function parseBulletList(text) {
  const tools = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^[-*]\s+`?([\w./:-]+)`?\s*(?:[-:]\s*)?(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      name: match[1],
      description: match[2] || undefined
    }));

  return tools.length > 0 ? tools : null;
}

function parseChromeWebmcpListing(text) {
  const tools = [];
  let cursor = 0;
  const nameMarker = 'name="';
  const descriptionMarker = '", description="';
  const inputSchemaMarker = '", inputSchema=';

  while (cursor < text.length) {
    const nameStart = text.indexOf(nameMarker, cursor);
    if (nameStart === -1) {
      break;
    }

    const nameValueStart = nameStart + nameMarker.length;
    const nameEnd = text.indexOf(descriptionMarker, nameValueStart);
    if (nameEnd === -1) {
      break;
    }

    const descriptionStart = nameEnd + descriptionMarker.length;
    const descriptionEnd = text.indexOf(inputSchemaMarker, descriptionStart);
    if (descriptionEnd === -1) {
      break;
    }

    const schemaStart = descriptionEnd + inputSchemaMarker.length;
    const schemaEnd = findBalancedJsonEnd(text, schemaStart);
    const schemaText =
      schemaEnd === -1
        ? readUntilNextToolOrAnnotation(text, schemaStart)
        : text.slice(schemaStart, schemaEnd);

    tools.push({
      name: text.slice(nameValueStart, nameEnd),
      description: text.slice(descriptionStart, descriptionEnd),
      inputSchema: parseJsonLoose(schemaText)
    });

    cursor = schemaEnd === -1 ? schemaStart + schemaText.length : schemaEnd;
  }

  return tools.length > 0 ? tools : null;
}

function findBalancedJsonEnd(text, start) {
  const firstBrace = text.indexOf("{", start);
  if (firstBrace === -1) {
    return -1;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

function readUntilNextToolOrAnnotation(text, start) {
  const nextTool = text.indexOf('\nname="', start);
  const annotation = text.indexOf(", annotations=", start);
  const endCandidates = [nextTool, annotation].filter((index) => index !== -1);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length;
  return text.slice(start, end).trim();
}

function textPayloads(result) {
  return (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}
