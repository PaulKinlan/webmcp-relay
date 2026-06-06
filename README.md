# webmcp-relay

`webmcp-relay` is a STDIO MCP server that relays a page's WebMCP tools to an
agent through Chrome DevTools MCP.

It starts Chrome DevTools MCP with the experimental WebMCP category, navigates
Chrome on demand, discovers page WebMCP tools, exposes those tools to MCP
clients, and records discovered tools in a local registry for later lookup.

Chrome DevTools MCP is spawned as a command. It is not a peer dependency. Use
`--mcp-package` to pin a package version if needed.

## Capabilities

`webmcp-relay` gives an agent a browser-facing WebMCP layer with these core
capabilities:

- Navigate Chrome with `open_page` for normal requests to open, visit, browse,
  go to, load, inspect, or navigate to a page.
- Discover WebMCP tools exposed by the current page through Chrome DevTools MCP.
- Expose discovered page tools directly as MCP tools in dynamic mode, for
  example `webmcp_tool_query`.
- Expose Chrome DevTools MCP browser/page tools with a `chrome_` prefix after
  the relay connects, for example `chrome_close_page`, `chrome_list_pages`, or
  interaction tools made available by the installed Chrome DevTools MCP server.
- Provide stable fallback tools for clients that do not refresh dynamic tool
  lists: `webmcp_list_tools` and `webmcp_call_tool`.
- Store tools discovered over time in a local SQLite registry.
- Search that registry by task or intent with `webmcp_search_registry`.
- Re-open the saved site for a registry match and execute the selected tool with
  `webmcp_execute_registry_tool`.
- Log local discovery, lookup, execution, and eval telemetry for later analysis.

The main idea is that an agent should not need the user to say "WebMCP". If the
user asks to navigate, the agent can call `open_page`; if the user asks for a
capability seen before, the agent can search the local registry and execute the
matching tool.

## Discovery Model

Discovery happens at two levels: the active page and the local registry.

Active page discovery:

1. The agent calls `open_page` with a URL.
2. The relay navigates Chrome through Chrome DevTools MCP.
3. The relay calls Chrome DevTools MCP `list_webmcp_tools` for the page.
4. The relay exposes the current page tools to the MCP client.
5. In dynamic mode, the relay sends `notifications/tools/list_changed` so
   clients can refresh and see tools such as `webmcp_tool_query`.

Registry discovery:

1. Every discovered page tool is stored locally with its site URL, origin, name,
   title, description, and input schema.
2. Re-discovering a page updates existing registry entries, including last seen
   time and current metadata.
3. Tool calls update usage fields such as `useCount` and `lastUsed`.
4. `webmcp_search_registry` searches across all previously discovered tools, not
   only tools on the active page.
5. `webmcp_execute_registry_tool` opens the stored site URL, refreshes the live
   WebMCP tools, verifies the selected tool still exists, and executes it.

This is not a crawler. The registry only contains tools from pages the relay has
opened, refreshed, or seeded through evals. The registry is local by default.

## MCP Client Config

Once published, the intended setup is:

```json
{
  "mcpServers": {
    "webmcp-relay": {
      "command": "npx",
      "args": [
        "-y",
        "webmcp-relay",
        "--headless",
        "--channel",
        "canary"
      ]
    }
  }
}
```

For local development from this repo:

```json
{
  "mcpServers": {
    "webmcp-relay": {
      "command": "node",
      "args": [
        "/Users/paulkinlan/Documents/WebMCP + Codex Test/src/webmcp-relay.js",
        "--headless",
        "--channel",
        "canary"
      ]
    }
  }
}
```

Do not use `npm run` in MCP client config because npm can write script banners
to stdout and break stdio MCP framing.

The npm package also ships `SKILL.md` for agents that can load skills. It tells
the model to use `open_page` for normal requests to open, visit, browse, go to,
load, inspect, or navigate to a URL. The user should not need to mention
WebMCP, MCP, relay, or tools to trigger page navigation through the relay.

## Modes

By default, `webmcp-relay` runs in dynamic mode.

Dynamic mode exposes wrapper tools first:

- `open_page`
- `webmcp_open_site`
- `webmcp_refresh_tools`
- `webmcp_list_tools`
- `webmcp_call_tool`
- `webmcp_search_registry`
- `webmcp_execute_registry_tool`

After `open_page`, it calls Chrome DevTools MCP `list_webmcp_tools`,
rebuilds its MCP tool list, and sends `notifications/tools/list_changed`.
Clients that refresh tools will then see page tools such as `webmcp_tool_query`.
Dynamic mode also re-exposes non-WebMCP Chrome DevTools MCP tools with a
`chrome_` prefix after Chrome DevTools MCP has connected. This lets the agent
use browser/page controls such as listing or closing pages, selecting tabs,
waiting, screenshots, clicking, typing, or other interaction tools supported by
the installed Chrome DevTools MCP server. The raw `list_webmcp_tools` and
`execute_webmcp_tool` tools are hidden because the relay already provides
WebMCP-specific wrappers.
`webmcp_open_site` remains available as a compatibility alias.

Stable mode is available for clients that do not support dynamic tool-list
refresh:

```sh
npx -y webmcp-relay --stable
```

In stable mode, use `webmcp_list_tools` and `webmcp_call_tool`.

## Local Tool Registry

`webmcp-relay` keeps a local SQLite registry of WebMCP tools discovered over
time. This adds a Web Intents-style lookup layer: a user-agent-local list of
sites and capabilities that can be searched globally, not only on the active
page.

Registry search uses SQLite FTS5 with BM25 ranking over tool name, title,
description, URL, origin, and input-schema text. The relay does not implement
its own ranking algorithm.

Discovery updates:

- `open_page` discovers the page's tools and stores them.
- `webmcp_open_site` is a compatibility alias for `open_page`.
- `webmcp_refresh_tools` refreshes the active page's tools and stores them.

Use updates:

- Calling a dynamic page tool updates its `useCount` and `lastUsed`.
- Calling `webmcp_call_tool` updates its `useCount` and `lastUsed`.
- Calling `webmcp_execute_registry_tool` updates its `useCount` and `lastUsed`.

Registry lookup:

- `webmcp_search_registry` searches the SQLite FTS5 index by task, tool name,
  description, URL, and input schema fields.
- `webmcp_execute_registry_tool` opens the stored site URL, refreshes its current
  WebMCP tools, verifies the registered tool still exists, then executes it.

The default registry path is:

- macOS: `~/Library/Application Support/webmcp-relay/registry.sqlite`
- Linux/other: `$XDG_DATA_HOME/webmcp-relay/registry.sqlite` or
  `~/.local/share/webmcp-relay/registry.sqlite`

Override it:

```sh
npx -y webmcp-relay --registry-db /path/to/registry.sqlite
```

Disable it:

```sh
npx -y webmcp-relay --no-registry
```

Inspect the registry from the CLI:

```sh
webmcp-relay registry stats --registry-db ./registry.sqlite
webmcp-relay registry list --registry-db ./registry.sqlite
webmcp-relay registry search "filter POST server logs" --registry-db ./registry.sqlite
webmcp-relay registry show webmcp_2a78e9273019e1f9 --registry-db ./registry.sqlite
```

All registry inspection commands support `--json`.

## Telemetry And Evals

`webmcp-relay` can log local telemetry events for discovery, lookup, and
execution. Telemetry is stored in SQLite and stays local.

Logged event types include:

- `open_site`
- `refresh_tools`
- `search_registry`
- `call_site_tool`
- `call_dynamic_tool`
- `call_chrome_tool`
- `execute_registry_tool`
- `eval_case`

The default telemetry path is:

- macOS: `~/Library/Application Support/webmcp-relay/telemetry.sqlite`
- Linux/other: `$XDG_DATA_HOME/webmcp-relay/telemetry.sqlite` or
  `~/.local/share/webmcp-relay/telemetry.sqlite`

Override it:

```sh
npx -y webmcp-relay --telemetry-db /path/to/telemetry.sqlite
```

Disable it:

```sh
npx -y webmcp-relay --no-telemetry
```

## Relay Logging

The MCP stdio transport uses stdout, so relay logs are written to stderr and
optionally to a file. Logs are JSON lines with `time`, `level`, `component`,
`event`, and event fields.

Enable operator logs:

```sh
npx -y webmcp-relay --headless --channel canary --log-level info
```

Write logs to a file as well:

```sh
npx -y webmcp-relay \
  --headless \
  --channel canary \
  --log-level info \
  --log-file ./reports/relay.jsonl
```

Environment variables are also supported:

```sh
WEBMCP_RELAY_LOG_LEVEL=debug WEBMCP_RELAY_LOG_FILE=./reports/relay.jsonl \
  npx -y webmcp-relay --headless --channel canary
```

Log levels are `off`, `error`, `warn`, `info`, and `debug`. The default is
`warn`. `--verbose` implies debug relay logs and also inherits Chrome DevTools
MCP stderr.

Useful relay events include:

- `process.start`
- `server.connect.start`
- `open_site.start` / `open_site.done`
- `refresh_tools.start` / `refresh_tools.done`
- `tools.list_changed`
- `search_registry.start` / `search_registry.done`
- `execute_registry_tool.start` / `execute_registry_tool.done`
- `call_dynamic_tool.start` / `call_dynamic_tool.done`
- `call_chrome_tool.start` / `call_chrome_tool.done`
- `devtools` component events such as `connect.start`, `navigate.done`, and
  `webmcp_tool.execute.done`

Run deterministic evals:

```sh
npx -y webmcp-relay eval run evals/analytics-dashboard.json \
  --headless \
  --channel canary \
  --report ./reports/latest.json
```

Run all bundled evals:

```sh
npm run eval:all -- --headless --channel canary --report ./reports/latest.json
```

These deterministic evals do not use an LLM. They verify browser discovery,
registry lookup, execution plumbing, latency, Node version, git SHA, registry DB
path, and telemetry DB path.

Run local registry search-quality evals:

```sh
npx -y webmcp-relay eval search evals/search/registry-search-quality.json \
  --report ./reports/search-quality.json
```

Search-quality evals do not use Chrome or an LLM. They seed a local SQLite
registry with fixture tools, run intent queries, and score whether the expected
tool appears within the required rank. Reports include top-1 rate, success rate,
mean reciprocal rank, average matched rank, average latency, full ranked
matches, and breakdowns by tags such as `exact`, `fuzzy`, `schema`, and
`ambiguous`.

Eval case shape:

```json
{
  "id": "analytics-filter-post-errors",
  "intent": "filter POST server logs with status 500",
  "siteUrl": "https://googlechromelabs.github.io/webmcp-tools/demos/analytics-dashboard/",
  "expectedToolNames": ["query"],
  "expectedUrlIncludes": "analytics-dashboard",
  "input": {
    "method": "POST",
    "status": "500",
    "groupBy": "status",
    "measure": "count",
    "chartType": "table"
  },
  "expectedOutputIncludes": ["Query applied"]
}
```

`expectedUrlIncludes` is optional but useful when different sites expose tools
with the same name, for example `search_location`.

Search eval case shape:

```json
{
  "id": "registry-search-quality-baseline",
  "tools": [
    {
      "id": "analytics-query",
      "url": "https://googlechromelabs.github.io/webmcp-tools/demos/analytics-dashboard/",
      "name": "query",
      "description": "Filter server logs by HTTP status code"
    }
  ],
  "cases": [
    {
      "id": "exact-analytics-post-500",
      "query": "filter POST server logs with status 500",
      "expectedToolIds": ["analytics-query"],
      "maxRank": 1,
      "tags": ["exact", "analytics"]
    }
  ]
}
```

This provides a repeatable baseline for improving lookup later. A future vector
or hybrid search implementation can run the same evals and compare top-1 rate,
MRR, tag-level failures, and latency against the current SQLite FTS5/BM25
baseline.

Run LLM-in-the-loop agent evals:

```sh
OPENAI_API_KEY=... npm run eval:agent -- evals/agent/pizza-maker.json \
  --headless \
  --channel canary \
  --model "$WEBMCP_RELAY_AGENT_MODEL" \
  --report ./reports/agent-latest.json
```

Agent evals connect an MCP client to `webmcp-relay`, give the LLM a goal and the
current MCP tool list, and ask it to return one JSON decision per step:
`list_tools`, `call_tool`, or `finish`. Reports include the actual MCP
`listTools` calls, `callTool` calls, `tools/list_changed` notifications, tool
arguments, tool output, LLM decisions, and scoring.

## External Agent Harness Evals

Harness evals run real MCP-capable agents such as Codex, Claude Code, or Gemini
CLI against `webmcp-relay`. Use them when you want to see whether an external
agent actually discovers and calls the right tools.

### Fast Path

Run one Codex eval:

```sh
npm run eval:harness:codex -- evals/agent/pizza-maker.json
```

Score the previous Codex run without knowing any paths:

```sh
npm run eval:harness:codex score
```

The equivalent explicit score shortcut is:

```sh
npm run eval:harness:codex:score
```

Run one Codex eval with debug relay logs and a named output directory:

```sh
npm run eval:harness:codex -- evals/agent/pizza-maker.json \
  --out ./reports/codex-smoke \
  --headless \
  --channel canary \
  --log-level debug \
  --report ./reports/codex-smoke/report.json
```

The command prints progress to the terminal on stderr and writes the full JSON
run report to stdout. `--report` also saves that report to a file.

Harness runs default to `--channel canary` because current WebMCP invocation
support is behind Chrome feature flags. When `webmcp-relay` launches Chrome, it
always forwards:

```sh
--enable-features=WebMCPTesting,DevToolsWebMCPSupport
```

If you pass `--browser-url`, the relay connects to an existing browser instead
of launching Chrome; start that browser yourself with the same feature flags.

Always put npm's `--` separator before eval case paths and flags. For example,
use `npm run eval:harness:codex -- --log-level debug`, not
`npm run eval:harness:codex --log-level debug`. Without the separator, npm can
consume flags before `webmcp-relay` sees them.

Watch relay activity while the eval is running:

```sh
tail -f ./reports/codex-smoke/agent-pizza-large-bbq/relay.jsonl
```

Re-score the same run from telemetry:

```sh
npm run eval:harness:codex:score -- --source telemetry
```

Run all bundled agent evals:

```sh
npm run eval:harness:codex -- \
  --out ./reports/codex-harness-run \
  --headless \
  --channel canary \
  --log-level info \
  --report ./reports/codex-harness-run/report.json
```

If you do not pass a case file, harness runs default to `evals/agent/*.json`.

### Harnesses

Codex:

```sh
npm run eval:harness:codex -- evals/agent/pizza-maker.json \
  --out ./reports/codex-harness \
  --headless \
  --channel canary
```

Claude Code:

```sh
npm run eval:harness:claude -- evals/agent/pizza-maker.json \
  --out ./reports/claude-harness \
  --headless \
  --channel canary
```

Gemini CLI:

```sh
npm run eval:harness:gemini -- evals/agent/pizza-maker.json \
  --out ./reports/gemini-harness \
  --headless \
  --channel canary
```

Equivalent long form:

```sh
npm run eval:harness -- run codex evals/agent/pizza-maker.json \
  --out ./reports/codex-harness \
  --headless \
  --channel canary
```

When using the generic `eval:harness` npm script, put npm's `--` separator
before the harness subcommand and options. The shortcut scripts already include
the subcommand, so their `--` separator goes before case files and options.

### Output Files

Every harness run creates one output directory. Each case gets a case directory:

```text
reports/codex-smoke/
  harness-run.json
  report.json
  agent-pizza-large-bbq/
    case.json
    prompt.md
    mcp-config.json
    runner-command.sh
    relay.jsonl
    codex-stdout.txt
    codex-stderr.txt
    registry.sqlite
    telemetry.sqlite
    transcript.json
```

Important files:

- `mcp-config.json`: MCP config for the harness
- `prompt.md`: the task prompt to give the agent
- `case.json`: the original eval case
- `runner-command.sh`: exact harness command that was run
- `<harness>-stdout.txt`: captured harness stdout
- `<harness>-stderr.txt`: captured harness stderr
- `relay.jsonl`: relay server logs; use this to debug discovery and tool calls
- `registry.sqlite`: per-case local tool registry
- `telemetry.sqlite`: per-case telemetry DB for tool-call scoring
- `transcript.json`: optional strict-scoring transcript written by the harness

`--log-level debug` makes `relay.jsonl` more detailed. It does not stream relay
logs to stdout because MCP stdio uses stdout for protocol messages and the eval
command uses stdout for the JSON report. The CLI prints high-level progress to
stderr and writes detailed logs to the case directory.

### Scoring

`eval harness run` scores automatically after it runs the harness. Re-run scoring
when you want to inspect a run again or switch scoring source.

Score the previous run for a specific harness:

```sh
npm run eval:harness:codex score
npm run eval:harness:codex:score
npm run eval:harness:claude:score
npm run eval:harness:gemini:score
```

Score the previous run, regardless of harness:

```sh
npm run eval:harness:score
```

Each harness run writes latest-run pointers under `reports/`, so score commands
can find the last run even when you used a custom `--out` directory.

Scoring modes:

- `--source auto` uses `transcript.json` when present, otherwise falls back to
  relay telemetry. This is the default.
- `--source transcript` requires transcript files and gives strict scoring,
  including output text and finish state.
- `--source telemetry` scores tool calls from `telemetry.sqlite`. This works
  even when the external harness cannot write transcripts, but output text and
  finish-state criteria are reported as unscored.

Write the score report:

```sh
npm run eval:harness:codex:score -- \
  --source telemetry \
  --report ./reports/codex-smoke/score.json
```

### Dry Run

Check the generated commands without invoking a model:

```sh
npm run eval:harness:codex -- evals/agent/pizza-maker.json \
  --out ./reports/codex-dry-run \
  --headless \
  --channel canary \
  --dry-run
```

Then inspect:

```sh
cat ./reports/codex-dry-run/agent-pizza-large-bbq/runner-command.sh
cat ./reports/codex-dry-run/agent-pizza-large-bbq/mcp-config.json
```

### Manual Harness Runs

Use the manual prepare path when you want to run the harness yourself:

```sh
npm run eval:harness -- prepare evals/agent/pizza-maker.json \
  --out ./reports/manual-harness \
  --harness codex \
  --headless \
  --channel canary
```

Then configure the harness with the case `mcp-config.json`, start a fresh
session, and paste the case `prompt.md`. The prompt asks the agent to use
`webmcp-relay` tools and, when possible, write `transcript.json` with tool calls,
outputs, and final answer.

Agent case shape:

```json
{
  "id": "agent-pizza-large-bbq",
  "goal": "Make the pizza large and set its style to BBQ.",
  "siteUrl": "https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/",
  "successCriteria": {
    "mustCallMcpTools": ["open_page"],
    "mustCallWebmcpTools": ["set_pizza_size", "set_pizza_style"],
    "mustIncludeOutputs": ["Set pizza size to Large", "Changed pizza style to BBQ"]
  }
}
```

For global lookup behavior, an agent case can seed the local registry first:

```json
{
  "id": "agent-registry-leather-return-policy",
  "goal": "Using tools that may have been discovered previously, check the return policy.",
  "seedSites": ["https://googlechromelabs.github.io/webmcp-tools/demos/leather-bag"],
  "resetUrl": "https://example.com/",
  "successCriteria": {
    "mustCallMcpTools": ["webmcp_search_registry", "webmcp_execute_registry_tool"],
    "mustIncludeOutputs": ["30-Day Guarantee"]
  }
}
```

## Local Commands

Install:

```sh
npm install
```

Run the relay locally:

```sh
npm run relay -- --headless --channel canary
```

Run with an explicit registry DB:

```sh
npm run relay -- --headless --channel canary --registry-db ./registry.sqlite
```

Inspect a local registry DB:

```sh
node ./src/webmcp-relay.js registry search "filter server logs" --registry-db ./registry.sqlite
```

Run the bundled eval:

```sh
npm run eval -- evals/analytics-dashboard.json --headless --channel canary
```

Run the full bundled eval suite:

```sh
npm run eval:all -- --headless --channel canary
```

Run the bundled registry search-quality eval:

```sh
npm run eval:search -- evals/search/registry-search-quality.json --report ./reports/search-quality.json
```

Run an LLM-in-the-loop agent eval:

```sh
npm run eval:agent -- evals/agent/pizza-maker.json --headless --channel canary --model "$WEBMCP_RELAY_AGENT_MODEL"
```

Run an external Codex-style harness eval:

```sh
npm run eval:harness:codex -- evals/agent/pizza-maker.json --out ./reports/harness-run --headless --channel canary --report ./reports/harness-run-report.json
```

Score an external harness run:

```sh
npm run eval:harness:codex score
```

Run stable mode:

```sh
npm run relay:stable -- --headless --channel canary
```

Run the direct Chrome DevTools MCP smoke test:

```sh
npm run smoke:devtools -- \
  --headless \
  --channel canary \
  --url https://googlechromelabs.github.io/webmcp-tools/demos/analytics-dashboard/
```

Call a page WebMCP tool directly through Chrome DevTools MCP:

```sh
npm run smoke:devtools -- \
  --headless \
  --channel canary \
  --call query \
  --input '{"method":"POST","status":"500","groupBy":"status","measure":"count","chartType":"table"}'
```

## Chrome Version Note

On this machine, default Chrome 148 can list WebMCP tools but cannot invoke them:
it returns `Protocol error (WebMCP.invokeTool): 'WebMCP.invokeTool' wasn't found`.
Chrome Canary 150 works for both list and execute.

## Verified Locally

Dynamic relay was verified by connecting an MCP client over stdio, calling
`open_page`, receiving `tools/list_changed`, then calling the dynamically
exposed `webmcp_tool_query`.

Registry lookup was verified by opening the analytics dashboard demo, searching
for `filter POST server logs`, receiving the stored `query` tool match, then
executing it via `webmcp_execute_registry_tool`.

Eval runner was verified against `evals/analytics-dashboard.json`; discovery,
lookup top-1, and execution all passed.

Stable relay was verified by connecting an MCP client over stdio, listing
`open_page,webmcp_open_site,webmcp_refresh_tools,webmcp_list_tools,webmcp_call_tool`,
discovering the page tool `query`, and calling it.

## Test

```sh
npm test
```

The unit tests use fake bridges for relay behavior, so they do not require
Chrome.
