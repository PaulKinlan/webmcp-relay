import assert from "node:assert/strict";
import test from "node:test";
import { createLogger, describeArgs } from "../src/logger.js";

test("logger writes structured JSON lines at the configured level", () => {
  const lines = [];
  const logger = createLogger({
    level: "info",
    component: "test",
    stream: {
      write(line) {
        lines.push(line);
      }
    }
  });

  logger.debug("ignored");
  logger.info("thing.happened", {
    value: 1
  });

  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "info");
  assert.equal(entry.component, "test");
  assert.equal(entry.event, "thing.happened");
  assert.equal(entry.value, 1);
  assert.equal(typeof entry.time, "string");
});

test("describeArgs reports keys without exposing values", () => {
  assert.deepEqual(describeArgs({
    url: "https://example.com",
    input: {
      token: "secret",
      status: "500"
    }
  }), {
    keys: ["url", "input"],
    inputKeys: ["token", "status"]
  });
});
