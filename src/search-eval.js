import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "./tool-registry.js";

export async function runSearchEval(options = {}) {
  const suites = await loadSearchEvalSuites(options.caseFiles ?? []);
  const registryPath = options.registryDb ?? tempSqlitePath("search-registry");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const registry = new ToolRegistry({
    path: registryPath,
    enabled: true
  });
  const suiteReports = [];

  try {
    for (const suite of suites) {
      suiteReports.push(await runSearchEvalSuite(registry, suite, options));
    }
  } finally {
    registry.close();
  }

  const results = suiteReports.flatMap((suite) => suite.results);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    registryPath,
    suiteCount: suiteReports.length,
    seededToolCount: suiteReports.reduce((sum, suite) => sum + suite.seededToolCount, 0),
    caseCount: results.length,
    summary: summarizeSearchResults(results),
    suites: suiteReports
  };
}

async function runSearchEvalSuite(registry, suite, options) {
  const logicalIdByRegistryId = new Map();
  const seededTools = [];

  for (const seedTool of suite.tools) {
    const [entry] = await registry.upsertTools(seedTool.url, [
      {
        name: seedTool.name,
        title: seedTool.title,
        description: seedTool.description,
        inputSchema: seedTool.inputSchema,
        outputSchema: seedTool.outputSchema,
        annotations: seedTool.annotations
      }
    ]);
    logicalIdByRegistryId.set(entry.id, seedTool.id);
    seededTools.push({
      id: seedTool.id,
      registryId: entry.id,
      url: entry.url,
      toolName: entry.toolName,
      title: entry.title,
      description: entry.description
    });
  }

  const results = [];
  for (const testCase of suite.cases) {
    results.push(await runSearchEvalCase(registry, logicalIdByRegistryId, suite, testCase, options));
  }

  return {
    id: suite.id,
    description: suite.description,
    seededToolCount: seededTools.length,
    caseCount: results.length,
    summary: summarizeSearchResults(results),
    seededTools,
    results
  };
}

async function runSearchEvalCase(registry, logicalIdByRegistryId, suite, testCase, options) {
  const limit = normaliseLimit(testCase.limit ?? suite.limit ?? options.limit);
  const expectedToolIds = normaliseExpectedToolIds(testCase);
  const maxRank = normaliseMaxRank(testCase.maxRank);
  const started = performance.now();
  const matches = await registry.search(testCase.query, {
    limit
  });
  const latencyMs = performance.now() - started;
  const rankedMatches = matches.map((match, index) => ({
    position: index + 1,
    toolId: logicalIdByRegistryId.get(match.entry.id) ?? match.entry.id,
    registryId: match.entry.id,
    toolName: match.entry.toolName,
    title: match.entry.title,
    description: match.entry.description,
    url: match.entry.url,
    ftsRank: match.rank,
    score: match.score
  }));
  const matchIndex = rankedMatches.findIndex((match) =>
    expectedToolIds.includes(match.toolId)
  );
  const rank = matchIndex >= 0 ? matchIndex + 1 : null;
  const success = rank !== null && rank <= maxRank;

  return {
    id: testCase.id,
    query: testCase.query,
    tags: testCase.tags ?? [],
    expectedToolIds,
    maxRank,
    limit,
    success,
    rank,
    topToolId: rankedMatches[0]?.toolId,
    reciprocalRank: rank ? 1 / rank : 0,
    latencyMs,
    matches: rankedMatches
  };
}

async function loadSearchEvalSuites(files) {
  const suites = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text);
    const fileSuites = Array.isArray(parsed) ? parsed : parsed.suites ?? [parsed];
    suites.push(...fileSuites.map((suite) => validateSearchEvalSuite(suite, file)));
  }

  return suites;
}

function validateSearchEvalSuite(suite, file) {
  if (!suite.id || typeof suite.id !== "string") {
    throw new Error(`Search eval suite in ${file} is missing string id.`);
  }
  if (!Array.isArray(suite.tools) || suite.tools.length === 0) {
    throw new Error(`Search eval suite ${suite.id} must define tools.`);
  }
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error(`Search eval suite ${suite.id} must define cases.`);
  }

  const toolIds = new Set();
  for (const tool of suite.tools) {
    if (!tool.id || typeof tool.id !== "string") {
      throw new Error(`Search eval suite ${suite.id} has a tool without string id.`);
    }
    if (toolIds.has(tool.id)) {
      throw new Error(`Search eval suite ${suite.id} has duplicate tool id ${tool.id}.`);
    }
    toolIds.add(tool.id);

    if (!tool.url || typeof tool.url !== "string") {
      throw new Error(`Search eval tool ${tool.id} is missing string url.`);
    }
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error(`Search eval tool ${tool.id} is missing string name.`);
    }
  }

  for (const testCase of suite.cases) {
    if (!testCase.id || typeof testCase.id !== "string") {
      throw new Error(`Search eval suite ${suite.id} has a case without string id.`);
    }
    if (!testCase.query || typeof testCase.query !== "string") {
      throw new Error(`Search eval case ${testCase.id} is missing string query.`);
    }

    const expectedToolIds = normaliseExpectedToolIds(testCase);
    if (expectedToolIds.length === 0) {
      throw new Error(`Search eval case ${testCase.id} must define expectedToolId or expectedToolIds.`);
    }
    for (const toolId of expectedToolIds) {
      if (!toolIds.has(toolId)) {
        throw new Error(`Search eval case ${testCase.id} references unknown tool id ${toolId}.`);
      }
    }
  }

  return suite;
}

function summarizeSearchResults(results) {
  const total = results.length;
  const success = results.filter((result) => result.success).length;
  const top1 = results.filter((result) => result.rank === 1).length;
  const found = results.filter((result) => result.rank !== null);

  return {
    total,
    success,
    successRate: ratio(success, total),
    top1,
    top1Rate: ratio(top1, total),
    meanReciprocalRank: average(results.map((result) => result.reciprocalRank)),
    averageMatchedRank: average(found.map((result) => result.rank)),
    averageLatencyMs: average(results.map((result) => result.latencyMs)),
    byTag: summarizeByTag(results)
  };
}

function summarizeByTag(results) {
  const tags = new Map();

  for (const result of results) {
    for (const tag of result.tags ?? []) {
      if (!tags.has(tag)) {
        tags.set(tag, []);
      }
      tags.get(tag).push(result);
    }
  }

  return Object.fromEntries(
    [...tags.entries()].map(([tag, taggedResults]) => [
      tag,
      {
        total: taggedResults.length,
        success: taggedResults.filter((result) => result.success).length,
        successRate: ratio(
          taggedResults.filter((result) => result.success).length,
          taggedResults.length
        ),
        top1: taggedResults.filter((result) => result.rank === 1).length,
        top1Rate: ratio(
          taggedResults.filter((result) => result.rank === 1).length,
          taggedResults.length
        ),
        meanReciprocalRank: average(
          taggedResults.map((result) => result.reciprocalRank)
        )
      }
    ])
  );
}

function normaliseExpectedToolIds(testCase) {
  if (Array.isArray(testCase.expectedToolIds)) {
    return testCase.expectedToolIds.map(String);
  }
  if (testCase.expectedToolId) {
    return [String(testCase.expectedToolId)];
  }
  return [];
}

function normaliseLimit(value) {
  const limit = Number(value ?? 10);
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 10;
}

function normaliseMaxRank(value) {
  const rank = Number(value ?? 1);
  return Number.isFinite(rank) && rank > 0 ? Math.floor(rank) : 1;
}

function tempSqlitePath(name) {
  return path.join(os.tmpdir(), `webmcp-relay-${name}-${process.pid}-${Date.now()}.sqlite`);
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}
