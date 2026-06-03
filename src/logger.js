import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  off: -1
};

export const noopLogger = {
  level: "off",
  child() {
    return this;
  },
  error() {},
  warn() {},
  info() {},
  debug() {},
  close() {}
};

export function createLogger(options = {}) {
  const logger = new JsonLineLogger(options);
  return logger.enabled ? logger : noopLogger;
}

class JsonLineLogger {
  constructor(options = {}) {
    this.level = normaliseLevel(options.level ?? process.env.WEBMCP_RELAY_LOG_LEVEL ?? "warn");
    this.component = options.component ?? "webmcp-relay";
    this.stream = options.stream ?? process.stderr;
    if (options.file) {
      mkdirSync(path.dirname(path.resolve(options.file)), { recursive: true });
      this.fileStream = createWriteStream(options.file, { flags: "a" });
    }
    this.enabled = this.level !== "off";
  }

  child(component) {
    return new ChildLogger(this, component);
  }

  error(event, fields) {
    this.log("error", event, fields);
  }

  warn(event, fields) {
    this.log("warn", event, fields);
  }

  info(event, fields) {
    this.log("info", event, fields);
  }

  debug(event, fields) {
    this.log("debug", event, fields);
  }

  log(level, event, fields = {}, component = this.component) {
    if (!this.shouldLog(level)) {
      return;
    }

    const line = `${JSON.stringify(cleanObject({
      time: new Date().toISOString(),
      level,
      component,
      event,
      ...fields
    }))}\n`;

    this.stream?.write?.(line);
    this.fileStream?.write(line);
  }

  shouldLog(level) {
    return this.enabled && LEVELS[level] <= LEVELS[this.level];
  }

  close() {
    this.fileStream?.end();
  }
}

class ChildLogger {
  constructor(parent, component) {
    this.parent = parent;
    this.level = parent.level;
    this.component = component;
    this.enabled = parent.enabled;
  }

  child(component) {
    return new ChildLogger(this.parent, `${this.component}.${component}`);
  }

  error(event, fields) {
    this.parent.log("error", event, fields, this.component);
  }

  warn(event, fields) {
    this.parent.log("warn", event, fields, this.component);
  }

  info(event, fields) {
    this.parent.log("info", event, fields, this.component);
  }

  debug(event, fields) {
    this.parent.log("debug", event, fields, this.component);
  }

  close() {
    this.parent.close();
  }
}

export function describeArgs(args = {}) {
  if (!args || typeof args !== "object") {
    return {
      type: typeof args
    };
  }

  return {
    keys: Object.keys(args),
    inputKeys: objectKeys(args.input)
  };
}

function objectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value)
    : undefined;
}

function normaliseLevel(level) {
  const normalised = String(level ?? "warn").toLowerCase();
  if (!Object.hasOwn(LEVELS, normalised)) {
    throw new Error(`Unsupported log level: ${level}`);
  }
  return normalised;
}

function cleanObject(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map(cleanObject);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, cleanObject(entryValue)])
  );
}
