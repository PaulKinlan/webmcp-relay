import assert from "node:assert/strict";
import test from "node:test";
import { runSearchEval } from "../src/search-eval.js";

test("registry search eval scores ranked intent matches", async () => {
  const report = await runSearchEval({
    caseFiles: ["evals/search/registry-search-quality.json"],
    limit: 8
  });

  assert.equal(report.suiteCount, 1);
  assert.equal(report.seededToolCount, 8);
  assert.equal(report.caseCount, 10);
  assert.equal(report.summary.success, report.summary.total);
  assert.equal(report.summary.top1, report.summary.total);
  assert.equal(report.summary.meanReciprocalRank, 1);
  assert.equal(report.summary.byTag.fuzzy.total >= 4, true);
  assert.equal(report.suites[0].results.every((result) => result.matches.length > 0), true);
});
