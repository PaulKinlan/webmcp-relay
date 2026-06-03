import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TelemetryStore } from "../src/telemetry-store.js";

test("telemetry store records and reads recent events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webmcp-telemetry-test-"));
  const telemetry = new TelemetryStore({
    path: path.join(dir, "telemetry.sqlite")
  });

  await telemetry.log({
    eventType: "search_registry",
    query: "filter logs",
    latencyMs: 12.5,
    isError: false,
    metadata: {
      resultCount: 1
    }
  });

  const [event] = await telemetry.recent(1);
  assert.equal(event.eventType, "search_registry");
  assert.equal(event.query, "filter logs");
  assert.equal(event.latencyMs, 12.5);
  assert.deepEqual(event.metadata, {
    resultCount: 1
  });

  telemetry.close();
});
