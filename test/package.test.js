import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("package ships WebMCP relay skill instructions", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  const skill = await fs.readFile(new URL("../SKILL.md", import.meta.url), "utf8");

  assert.equal(packageJson.files.includes("SKILL.md"), true);
  assert.match(skill, /\bopen_page\b/);
  assert.match(skill, /ordinary page navigation/i);
  assert.match(skill, /does not need to say[\s\S]*WebMCP/i);
});
