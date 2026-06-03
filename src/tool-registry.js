import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REGISTRY_VERSION = 2;

export class ToolRegistry {
  constructor(options = {}) {
    this.path = options.path ?? defaultRegistryPath();
    this.enabled = options.enabled !== false;
    this.db = undefined;
    this.loaded = false;
  }

  async load() {
    if (!this.enabled || this.loaded) {
      return;
    }

    const sqlite = await loadSqlite();
    await fs.mkdir(path.dirname(this.path), { recursive: true });

    this.db = new sqlite.DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.createSchema();
    this.assertFts5();
    this.loaded = true;
  }

  close() {
    if (!this.db) {
      return;
    }

    this.db.close();
    this.db = undefined;
    this.loaded = false;
  }

  async save() {
    await this.load();
  }

  async upsertTools(url, tools) {
    if (!this.enabled || !url) {
      return [];
    }

    await this.load();
    const now = new Date().toISOString();
    const entries = [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const tool of tools) {
        const entry = this.upsertTool(url, tool, now);
        entries.push(entry);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return entries;
  }

  async recordUse(id) {
    if (!this.enabled || !id) {
      return undefined;
    }

    await this.load();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tools
         SET use_count = use_count + 1,
             last_used = ?
         WHERE id = ?`
      )
      .run(now, id);
    return this.get(id);
  }

  idFor(url, toolName) {
    return registryToolId(url, toolName);
  }

  async get(id) {
    await this.load();
    const row = this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id);
    return row ? rowToEntry(row) : undefined;
  }

  async list(options = {}) {
    await this.load();
    const limit = normaliseLimit(options.limit ?? 100);
    return this.db
      .prepare(
        `SELECT *
         FROM tools
         ORDER BY last_used DESC NULLS LAST,
                  use_count DESC,
                  last_seen DESC
         LIMIT ?`
      )
      .all(limit)
      .map(rowToEntry);
  }

  async search(query, options = {}) {
    await this.load();
    const limit = normaliseLimit(options.limit);
    const ftsQuery = toFtsQuery(query);

    if (!ftsQuery) {
      return (await this.list({ limit })).map((entry) => ({
        entry,
        rank: null,
        score: null
      }));
    }

    return this.db
      .prepare(
        `SELECT tools.*,
                bm25(tools_fts, 8.0, 6.0, 4.0, 1.0, 1.0, 3.0) AS rank
         FROM tools_fts
         JOIN tools ON tools.id = tools_fts.id
         WHERE tools_fts MATCH ?
         ORDER BY rank ASC,
                  tools.use_count DESC,
                  tools.last_used DESC NULLS LAST,
                  tools.last_seen DESC
         LIMIT ?`
      )
      .all(ftsQuery, limit)
      .map((row) => ({
        entry: rowToEntry(row),
        rank: row.rank,
        score: typeof row.rank === "number" ? -row.rank : null
      }));
  }

  async stats() {
    await this.load();
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS tool_count,
                COUNT(DISTINCT url) AS url_count,
                COUNT(DISTINCT origin) AS origin_count,
                COALESCE(SUM(use_count), 0) AS total_use_count,
                MAX(last_seen) AS newest_last_seen,
                MAX(last_used) AS newest_last_used
         FROM tools`
      )
      .get();
    const topOrigins = this.db
      .prepare(
        `SELECT origin, COUNT(*) AS tool_count
         FROM tools
         GROUP BY origin
         ORDER BY tool_count DESC, origin ASC
         LIMIT 10`
      )
      .all();
    const topTools = this.db
      .prepare(
        `SELECT id, tool_name, url, use_count, last_used
         FROM tools
         ORDER BY use_count DESC, last_used DESC NULLS LAST, last_seen DESC
         LIMIT 10`
      )
      .all();

    return {
      path: this.path,
      toolCount: totals.tool_count,
      urlCount: totals.url_count,
      originCount: totals.origin_count,
      totalUseCount: totals.total_use_count,
      newestLastSeen: totals.newest_last_seen,
      newestLastUsed: totals.newest_last_used,
      topOrigins: topOrigins.map((row) => ({
        origin: row.origin,
        toolCount: row.tool_count
      })),
      topTools: topTools.map((row) => ({
        id: row.id,
        toolName: row.tool_name,
        url: row.url,
        useCount: row.use_count,
        lastUsed: row.last_used
      }))
    };
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        origin TEXT,
        host TEXT,
        tool_name TEXT NOT NULL,
        title TEXT,
        description TEXT,
        input_schema_json TEXT,
        output_schema_json TEXT,
        annotations_json TEXT,
        schema_text TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        discovery_count INTEGER NOT NULL DEFAULT 0,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tools_url ON tools(url);
      CREATE INDEX IF NOT EXISTS idx_tools_tool_name ON tools(tool_name);
      CREATE INDEX IF NOT EXISTS idx_tools_last_seen ON tools(last_seen);
    `);

    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('version', ?)")
      .run(String(REGISTRY_VERSION));

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
        id UNINDEXED,
        tool_name,
        title,
        description,
        url,
        origin,
        schema_text,
        tokenize = 'unicode61'
      );
    `);
  }

  assertFts5() {
    try {
      this.db.prepare("SELECT rowid FROM tools_fts LIMIT 1").all();
    } catch (error) {
      throw new Error(
        `SQLite FTS5 is required for registry search but is unavailable: ${error.message}`
      );
    }
  }

  upsertTool(url, tool, now) {
    const id = registryToolId(url, tool.name);
    const existing = this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id);
    const parsedUrl = parseUrl(url);
    const schemaText = schemaSearchText(tool.inputSchema);

    if (existing) {
      this.db
        .prepare(
          `UPDATE tools
           SET url = ?,
               origin = ?,
               host = ?,
               tool_name = ?,
               title = ?,
               description = ?,
               input_schema_json = ?,
               output_schema_json = ?,
               annotations_json = ?,
               schema_text = ?,
               last_seen = ?,
               discovery_count = discovery_count + 1
           WHERE id = ?`
        )
        .run(
          url,
          sqlValue(parsedUrl?.origin),
          sqlValue(parsedUrl?.host),
          tool.name,
          sqlValue(tool.title),
          sqlValue(tool.description),
          stringifyJson(tool.inputSchema),
          stringifyJson(tool.outputSchema),
          stringifyJson(tool.annotations),
          schemaText,
          now,
          id
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO tools (
             id, url, origin, host, tool_name, title, description,
             input_schema_json, output_schema_json, annotations_json, schema_text,
             first_seen, last_seen, discovery_count, use_count
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
        )
        .run(
          id,
          url,
          sqlValue(parsedUrl?.origin),
          sqlValue(parsedUrl?.host),
          tool.name,
          sqlValue(tool.title),
          sqlValue(tool.description),
          stringifyJson(tool.inputSchema),
          stringifyJson(tool.outputSchema),
          stringifyJson(tool.annotations),
          schemaText,
          now,
          now
        );
    }

    this.replaceFtsRow({
      id,
      toolName: tool.name,
      title: sqlValue(tool.title),
      description: sqlValue(tool.description),
      url,
      origin: sqlValue(parsedUrl?.origin),
      schemaText
    });

    return rowToEntry(this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id));
  }

  replaceFtsRow({ id, toolName, title, description, url, origin, schemaText }) {
    this.db.prepare("DELETE FROM tools_fts WHERE id = ?").run(id);
    this.db
      .prepare(
        `INSERT INTO tools_fts (
           id, tool_name, title, description, url, origin, schema_text
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, toolName, title, description, url, origin, schemaText);
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
      "registry.sqlite"
    );
  }

  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "webmcp-relay", "registry.sqlite");
}

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `node:sqlite is required for the WebMCP registry. Use Node.js with node:sqlite support or start with --no-registry. ${error.message}`
    );
  }
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

function rowToEntry(row) {
  return {
    id: row.id,
    url: row.url,
    origin: row.origin,
    host: row.host,
    toolName: row.tool_name,
    title: row.title,
    description: row.description,
    inputSchema: parseJson(row.input_schema_json),
    outputSchema: parseJson(row.output_schema_json),
    annotations: parseJson(row.annotations_json),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    discoveryCount: row.discovery_count,
    useCount: row.use_count,
    lastUsed: row.last_used
  };
}

function schemaSearchText(schema) {
  if (!schema || typeof schema !== "object") {
    return "";
  }

  const pieces = [];
  appendSchemaText(schema, pieces);
  return pieces.join(" ");
}

function appendSchemaText(schema, pieces, name) {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (name) {
    pieces.push(name);
  }

  if (typeof schema.title === "string") {
    pieces.push(schema.title);
  }
  if (typeof schema.description === "string") {
    pieces.push(schema.description);
  }
  if (Array.isArray(schema.enum)) {
    pieces.push(...schema.enum.map(String));
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      appendSchemaText(propertySchema, pieces, propertyName);
    }
  }

  for (const key of ["items", "additionalProperties"]) {
    if (schema[key] && typeof schema[key] === "object") {
      appendSchemaText(schema[key], pieces);
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) {
      for (const child of schema[key]) {
        appendSchemaText(child, pieces);
      }
    }
  }
}

function toFtsQuery(query) {
  const terms = String(query ?? "")
    .toLowerCase()
    .match(/[a-z0-9_]{2,}/g);

  if (!terms || terms.length === 0) {
    return "";
  }

  return [...new Set(terms)]
    .slice(0, 20)
    .map((term) => `${term.replaceAll('"', '""')}*`)
    .join(" OR ");
}

function stringifyJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function sqlValue(value) {
  return value === undefined ? null : value;
}

function parseJson(value) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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
