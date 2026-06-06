import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("bundled eval fixtures are valid and have unique ids", async () => {
  const evalDir = path.resolve("evals");
  const files = (await fs.readdir(evalDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const ids = new Set();
  let caseCount = 0;

  assert.equal(files.length >= 10, true);

  for (const file of files) {
    const fullPath = path.join(evalDir, file);
    const parsed = JSON.parse(await fs.readFile(fullPath, "utf8"));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases ?? [parsed];

    assert.equal(cases.length > 0, true, `${file} must contain at least one case`);

    for (const evalCase of cases) {
      caseCount += 1;
      assert.equal(typeof evalCase.id, "string", `${file} case is missing id`);
      assert.equal(ids.has(evalCase.id), false, `Duplicate eval id ${evalCase.id}`);
      ids.add(evalCase.id);

      assert.equal(typeof evalCase.intent, "string", `${evalCase.id} is missing intent`);
      assert.equal(typeof evalCase.siteUrl, "string", `${evalCase.id} is missing siteUrl`);

      if (evalCase.expectedToolNames !== undefined) {
        assert.equal(
          Array.isArray(evalCase.expectedToolNames),
          true,
          `${evalCase.id} expectedToolNames must be an array`
        );
      }

      if (evalCase.expectedUrlIncludes !== undefined) {
        assert.equal(
          typeof evalCase.expectedUrlIncludes === "string" ||
            Array.isArray(evalCase.expectedUrlIncludes),
          true,
          `${evalCase.id} expectedUrlIncludes must be a string or array`
        );
      }

      if (evalCase.expectedOutputIncludes !== undefined) {
        assert.notEqual(
          evalCase.input,
          undefined,
          `${evalCase.id} expectedOutputIncludes requires input so execution runs`
        );
      }
    }
  }

  assert.equal(caseCount >= 14, true);
});

test("bundled registry search eval fixtures are valid and have unique ids", async () => {
  const evalDir = path.resolve("evals", "search");
  const files = (await fs.readdir(evalDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const suiteIds = new Set();
  const caseIds = new Set();

  assert.equal(files.length >= 1, true);

  for (const file of files) {
    const fullPath = path.join(evalDir, file);
    const parsed = JSON.parse(await fs.readFile(fullPath, "utf8"));
    const suites = Array.isArray(parsed) ? parsed : parsed.suites ?? [parsed];

    for (const suite of suites) {
      assert.equal(typeof suite.id, "string", `${file} suite is missing id`);
      assert.equal(suiteIds.has(suite.id), false, `Duplicate search eval suite id ${suite.id}`);
      suiteIds.add(suite.id);
      assert.equal(Array.isArray(suite.tools), true, `${suite.id} tools must be an array`);
      assert.equal(Array.isArray(suite.cases), true, `${suite.id} cases must be an array`);

      const toolIds = new Set(suite.tools.map((tool) => tool.id));
      assert.equal(toolIds.size, suite.tools.length, `${suite.id} tool ids must be unique`);

      for (const evalCase of suite.cases) {
        assert.equal(typeof evalCase.id, "string", `${suite.id} case is missing id`);
        assert.equal(caseIds.has(evalCase.id), false, `Duplicate search eval id ${evalCase.id}`);
        caseIds.add(evalCase.id);
        assert.equal(typeof evalCase.query, "string", `${evalCase.id} is missing query`);
        assert.equal(
          Array.isArray(evalCase.expectedToolIds),
          true,
          `${evalCase.id} expectedToolIds must be an array`
        );
        for (const toolId of evalCase.expectedToolIds) {
          assert.equal(toolIds.has(toolId), true, `${evalCase.id} references ${toolId}`);
        }
      }
    }
  }
});
