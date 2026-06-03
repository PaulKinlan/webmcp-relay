import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TELEMETRY_VERSION = 1;

export class TelemetryStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultTelemetryPath();
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
    this.createSchema();
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

  async log(event) {
    if (!this.enabled) {
      return;
    }

    await this.load();
    this.db
      .prepare(
        `INSERT INTO telemetry_events (
           event_type, timestamp, url, tool_name, registry_id, query,
           latency_ms, is_error, error_text, metadata_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.eventType,
        event.timestamp ?? new Date().toISOString(),
        sqlValue(event.url),
        sqlValue(event.toolName),
        sqlValue(event.registryId),
        sqlValue(event.query),
        sqlValue(event.latencyMs),
        event.isError ? 1 : 0,
        sqlValue(event.errorText),
        stringifyJson(event.metadata)
      );
  }

  async recent(limit = 100) {
    await this.load();
    return this.db
      .prepare(
        `SELECT *
         FROM telemetry_events
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(normaliseLimit(limit))
      .map(rowToEvent);
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        url TEXT,
        tool_name TEXT,
        registry_id TEXT,
        query TEXT,
        latency_ms REAL,
        is_error INTEGER NOT NULL DEFAULT 0,
        error_text TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON telemetry_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_telemetry_tool_name ON telemetry_events(tool_name);
      CREATE INDEX IF NOT EXISTS idx_telemetry_registry_id ON telemetry_events(registry_id);
    `);

    this.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('version', ?)")
      .run(String(TELEMETRY_VERSION));
  }
}

export function defaultTelemetryPath() {
  if (process.env.WEBMCP_RELAY_TELEMETRY_DB) {
    return process.env.WEBMCP_RELAY_TELEMETRY_DB;
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "webmcp-relay",
      "telemetry.sqlite"
    );
  }

  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "webmcp-relay", "telemetry.sqlite");
}

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `node:sqlite is required for WebMCP telemetry. Use Node.js with node:sqlite support or start with --no-telemetry. ${error.message}`
    );
  }
}

function rowToEvent(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    timestamp: row.timestamp,
    url: row.url,
    toolName: row.tool_name,
    registryId: row.registry_id,
    query: row.query,
    latencyMs: row.latency_ms,
    isError: row.is_error === 1,
    errorText: row.error_text,
    metadata: parseJson(row.metadata_json)
  };
}

function stringifyJson(value) {
  return value === undefined ? null : JSON.stringify(value);
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

function sqlValue(value) {
  return value === undefined ? null : value;
}

function normaliseLimit(limit) {
  const value = Number(limit ?? 100);
  if (!Number.isFinite(value) || value < 1) {
    return 100;
  }
  return Math.min(Math.floor(value), 1000);
}
