import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REGISTRY_VERSION = 1;

const STOP_WORDS = new Set([
  "a",
  "about",
  "and",
  "are",
  "can",
  "for",
  "from",
  "have",
  "into",
  "the",
  "this",
  "tool",
  "tools",
  "use",
  "using",
  "with"
]);

export class ToolRegistry {
  constructor(options = {}) {
    this.path = options.path ?? defaultRegistryPath();
    this.enabled = options.enabled !== false;
    this.data = {
      version: REGISTRY_VERSION,
      tools: {}
    };
    this.loaded = false;
  }

  async load() {
    if (!this.enabled || this.loaded) {
      return;
    }

    try {
      const text = await fs.readFile(this.path, "utf8");
      const parsed = JSON.parse(text);
      this.data = {
        version: REGISTRY_VERSION,
        tools: parsed.tools && typeof parsed.tools === "object" ? parsed.tools : {}
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    this.loaded = true;
  }

  async save() {
    if (!this.enabled) {
      return;
    }

    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), "utf8");
  }

  async upsertTools(url, tools) {
    if (!this.enabled || !url) {
      return [];
    }

    await this.load();
    const now = new Date().toISOString();
    const entries = [];

    for (const tool of tools) {
      const entry = registryEntryForTool(url, tool, now, this.data.tools);
      this.data.tools[entry.id] = entry;
      entries.push(entry);
    }

    await this.save();
    return entries;
  }

  async recordUse(id) {
    if (!this.enabled || !id) {
      return undefined;
    }

    await this.load();
    const entry = this.data.tools[id];
    if (!entry) {
      return undefined;
    }

    entry.useCount = (entry.useCount ?? 0) + 1;
    entry.lastUsed = new Date().toISOString();
    await this.save();
    return entry;
  }

  idFor(url, toolName) {
    return registryToolId(url, toolName);
  }

  async get(id) {
    await this.load();
    return this.data.tools[id];
  }

  async list() {
    await this.load();
    return Object.values(this.data.tools).sort((a, b) => {
      const aSeen = a.lastSeen ?? "";
      const bSeen = b.lastSeen ?? "";
      return bSeen.localeCompare(aSeen);
    });
  }

  async search(query, options = {}) {
    await this.load();
    const limit = normaliseLimit(options.limit);
    const entries = await this.list();
    const queryTokens = [...tokenize(query)];

    const scored = entries.map((entry) => {
      const text = registrySearchText(entry);
      const entryTokens = tokenize(text);
      const matchedTerms = queryTokens.filter((token) => entryTokens.has(token));
      const exactText = text.toLowerCase();
      const exactBoost = queryTokens.filter((token) => exactText.includes(token)).length;
      const useBoost = Math.min(entry.useCount ?? 0, 5) * 0.25;
      const score = matchedTerms.length + exactBoost * 0.5 + useBoost;

      return {
        entry,
        score,
        matchedTerms: [...new Set(matchedTerms)]
      };
    });

    return scored
      .filter((result) => queryTokens.length === 0 || result.score > 0)
      .sort((a, b) => b.score - a.score || compareRecent(a.entry, b.entry))
      .slice(0, limit);
  }
}

export function defaultRegistryPath() {
  if (process.env.WEBMCP_RELAY_DB) {
    return process.env.WEBMCP_RELAY_DB;
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "webmcp-relay",
      "registry.json"
    );
  }

  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "webmcp-relay", "registry.json");
}

function registryEntryForTool(url, tool, now, existingTools) {
  const id = registryToolId(url, tool.name);
  const existing = existingTools[id] ?? {};
  const parsedUrl = parseUrl(url);

  return {
    ...existing,
    id,
    url,
    origin: parsedUrl?.origin,
    host: parsedUrl?.host,
    toolName: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    firstSeen: existing.firstSeen ?? now,
    lastSeen: now,
    discoveryCount: (existing.discoveryCount ?? 0) + 1,
    useCount: existing.useCount ?? 0,
    lastUsed: existing.lastUsed
  };
}

function registryToolId(url, toolName) {
  const hash = crypto
    .createHash("sha256")
    .update(`${normaliseUrlForId(url)}\n${toolName}`)
    .digest("hex")
    .slice(0, 16);
  return `webmcp_${hash}`;
}

function normaliseUrlForId(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return String(url);
  }

  parsed.hash = "";
  return parsed.toString();
}

function registrySearchText(entry) {
  return [
    entry.toolName,
    entry.title,
    entry.description,
    entry.url,
    entry.origin,
    schemaText(entry.inputSchema)
  ]
    .filter(Boolean)
    .join(" ");
}

function schemaText(schema) {
  if (!schema || typeof schema !== "object") {
    return "";
  }

  const pieces = [];
  if (schema.description) {
    pieces.push(schema.description);
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, value] of Object.entries(schema.properties)) {
      pieces.push(name);
      if (value && typeof value === "object" && typeof value.description === "string") {
        pieces.push(value.description);
      }
    }
  }

  return pieces.join(" ");
}

function tokenize(text) {
  return new Set(
    String(text)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  );
}

function compareRecent(a, b) {
  const aDate = a.lastUsed ?? a.lastSeen ?? "";
  const bDate = b.lastUsed ?? b.lastSeen ?? "";
  return bDate.localeCompare(aDate);
}

function normaliseLimit(limit) {
  const value = Number(limit ?? 10);
  if (!Number.isFinite(value) || value < 1) {
    return 10;
  }
  return Math.min(Math.floor(value), 50);
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
