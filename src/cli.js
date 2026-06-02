export function parseCommonArgs(args, defaults = {}) {
  const options = {
    command: "npx",
    mcpPackage: "chrome-devtools-mcp@latest",
    headless: false,
    isolated: true,
    navigationTimeout: 30000,
    extraServerArgs: [],
    verbose: false,
    ...defaults
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--url":
        options.url = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--wait-for-text":
        options.waitForText = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--browser-url":
        options.browserUrl = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--channel":
        options.channel = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--command":
        options.command = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--mcp-package":
        options.mcpPackage = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--timeout":
        options.navigationTimeout = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--page-idx":
        options.pageIdx = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--chrome-features":
        options.chromeFeatures = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--server-arg":
        options.extraServerArgs.push(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--no-isolated":
        options.isolated = false;
        break;
      case "--json":
        options.json = true;
        break;
      case "--raw":
        options.raw = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      default:
        if (defaults.allowUnknown) {
          options._unknown ??= [];
          options._unknown.push(arg);
          break;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function splitOption(arg) {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex === -1) {
    return { key: arg, inlineValue: undefined };
  }

  return {
    key: arg.slice(0, equalsIndex),
    inlineValue: arg.slice(equalsIndex + 1)
  };
}

export function readValue(arg, inlineValue, args, nextIndex) {
  if (inlineValue !== undefined) {
    return inlineValue;
  }

  const value = args[nextIndex];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}.`);
  }
  return value;
}

export function readJsonArgument(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
