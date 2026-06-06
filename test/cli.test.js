import assert from "node:assert/strict";
import test from "node:test";
import { parseCommonArgs } from "../src/cli.js";

test("parseCommonArgs treats devtools-url as browserUrl", () => {
  const options = parseCommonArgs([
    "--devtools-url",
    "http://127.0.0.1:9222"
  ]);

  assert.equal(options.browserUrl, "http://127.0.0.1:9222");
});

test("parseCommonArgs keeps browser-url as a compatibility alias", () => {
  const options = parseCommonArgs([
    "--browser-url",
    "http://127.0.0.1:9333"
  ]);

  assert.equal(options.browserUrl, "http://127.0.0.1:9333");
});
