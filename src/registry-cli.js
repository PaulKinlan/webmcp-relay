import { readValue, splitOption } from "./cli.js";
import { ToolRegistry, defaultRegistryPath } from "./tool-registry.js";

export async function runRegistryCli(args) {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return;
  }

  const options = parseRegistryArgs(rest);
  const registry = new ToolRegistry({
    path: options.registryDb
  });

  try {
    switch (command) {
      case "list":
        await printList(registry, options);
        break;
      case "search":
        await printSearch(registry, options);
        break;
      case "show":
        await printShow(registry, options);
        break;
      case "stats":
        await printStats(registry, options);
        break;
      default:
        throw new Error(`Unsupported registry command: ${command}`);
    }
  } finally {
    registry.close();
  }
}

async function printList(registry, options) {
  const entries = await registry.list({
    limit: options.limit
  });

  if (options.json) {
    printJson({
      registryPath: registry.path,
      tools: entries
    });
    return;
  }

  printToolTable(entries);
}

async function printSearch(registry, options) {
  if (!options.query) {
    throw new Error("registry search requires --query <text> or a positional query.");
  }

  const matches = await registry.search(options.query, {
    limit: options.limit
  });

  if (options.json) {
    printJson({
      registryPath: registry.path,
      query: options.query,
      matches
    });
    return;
  }

  printToolTable(
    matches.map((match) => ({
      ...match.entry,
      rank: match.rank,
      score: match.score
    })),
    {
      includeRank: true
    }
  );
}

async function printShow(registry, options) {
  if (!options.id) {
    throw new Error("registry show requires --id <registry-id> or a positional id.");
  }

  const entry = await registry.get(options.id);
  if (!entry) {
    throw new Error(`No registry tool found for id: ${options.id}`);
  }

  if (options.json) {
    printJson(entry);
    return;
  }

  process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
}

async function printStats(registry, options) {
  const stats = await registry.stats();

  if (options.json) {
    printJson(stats);
    return;
  }

  process.stdout.write(`Registry: ${stats.path}\n`);
  process.stdout.write(`Tools: ${stats.toolCount}\n`);
  process.stdout.write(`URLs: ${stats.urlCount}\n`);
  process.stdout.write(`Origins: ${stats.originCount}\n`);
  process.stdout.write(`Total uses: ${stats.totalUseCount}\n`);
  process.stdout.write(`Newest seen: ${stats.newestLastSeen ?? ""}\n`);
  process.stdout.write(`Newest used: ${stats.newestLastUsed ?? ""}\n`);

  if (stats.topOrigins.length > 0) {
    process.stdout.write("\nTop origins:\n");
    for (const origin of stats.topOrigins) {
      process.stdout.write(`- ${origin.origin ?? "(none)"} (${origin.toolCount})\n`);
    }
  }

  if (stats.topTools.length > 0) {
    process.stdout.write("\nTop tools:\n");
    for (const tool of stats.topTools) {
      process.stdout.write(`- ${tool.toolName} ${tool.id} uses=${tool.useCount} ${tool.url}\n`);
    }
  }
}

function parseRegistryArgs(args) {
  const options = {
    registryDb: defaultRegistryPath(),
    limit: 20,
    json: false
  };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const { key, inlineValue } = splitOption(arg);

    switch (key) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--registry-db":
        options.registryDb = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--query":
      case "-q":
        options.query = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--id":
        options.id = readValue(arg, inlineValue, args, ++index);
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--limit":
      case "-n":
        options.limit = Number(readValue(arg, inlineValue, args, ++index));
        if (inlineValue !== undefined) index -= 1;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown registry option: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }

  if (!options.query && positional.length > 0) {
    options.query = positional.join(" ");
  }
  if (!options.id && positional.length === 1) {
    options.id = positional[0];
  }

  return options;
}

function printToolTable(entries, options = {}) {
  if (entries.length === 0) {
    process.stdout.write("No tools found.\n");
    return;
  }

  const rows = entries.map((entry) => ({
    id: entry.id,
    tool: entry.toolName,
    origin: entry.origin ?? "",
    uses: String(entry.useCount ?? 0),
    rank: entry.rank === null || entry.rank === undefined ? "" : entry.rank.toExponential(3),
    description: firstLine(entry.description),
    url: entry.url
  }));
  const columns = options.includeRank
    ? ["id", "tool", "origin", "uses", "rank", "description", "url"]
    : ["id", "tool", "origin", "uses", "description", "url"];

  printTable(rows, columns);
}

function printTable(rows, columns) {
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length))
    ])
  );

  process.stdout.write(`${columns.map((column) => pad(column, widths[column])).join("  ")}\n`);
  process.stdout.write(`${columns.map((column) => "-".repeat(widths[column])).join("  ")}\n`);

  for (const row of rows) {
    process.stdout.write(
      `${columns.map((column) => pad(String(row[column] ?? ""), widths[column])).join("  ")}\n`
    );
  }
}

function pad(value, width) {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/)[0].trim();
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function helpText() {
  return `Usage:
  webmcp-relay registry list [--registry-db ./registry.sqlite] [--json]
  webmcp-relay registry search "intent or task" [--limit 10] [--json]
  webmcp-relay registry show <registry-id> [--json]
  webmcp-relay registry stats [--json]

Commands:
  list      List tools currently stored in the local registry.
  search    Search tools using SQLite FTS5/BM25.
  show      Show one stored tool by registry id.
  stats     Show registry counts and top tools.
`;
}
