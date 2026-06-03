import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRegistryCli } from "../src/registry-cli.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("registry CLI lists, searches, shows, and stats tools as JSON", async () => {
  const registryPath = await seededRegistryPath();

  const list = JSON.parse(await captureStdout(() =>
    runRegistryCli(["list", "--registry-db", registryPath, "--json"])
  ));
  assert.equal(list.tools.length, 1);
  assert.equal(list.tools[0].toolName, "query");

  const search = JSON.parse(await captureStdout(() =>
    runRegistryCli(["search", "filter POST logs", "--registry-db", registryPath, "--json"])
  ));
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].entry.toolName, "query");

  const show = JSON.parse(await captureStdout(() =>
    runRegistryCli(["show", list.tools[0].id, "--registry-db", registryPath, "--json"])
  ));
  assert.equal(show.id, list.tools[0].id);

  const stats = JSON.parse(await captureStdout(() =>
    runRegistryCli(["stats", "--registry-db", registryPath, "--json"])
  ));
  assert.equal(stats.toolCount, 1);
  assert.equal(stats.urlCount, 1);
});

async function seededRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webmcp-registry-cli-test-"));
  const registryPath = path.join(dir, "registry.sqlite");
  const registry = new ToolRegistry({
    path: registryPath
  });

  await registry.upsertTools("https://example.com/logs", [
    {
      name: "query",
      description: "Filter server logs by status and method",
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            description: "HTTP method"
          },
          status: {
            type: "string",
            description: "HTTP status"
          }
        }
      }
    }
  ]);
  registry.close();
  return registryPath;
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
