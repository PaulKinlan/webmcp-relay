# webmcp-relay

`webmcp-relay` is a STDIO MCP server that relays a page's WebMCP tools to an
agent through Chrome DevTools MCP.

It starts Chrome DevTools MCP with the experimental WebMCP category, navigates
Chrome on demand, discovers page WebMCP tools, and exposes them to MCP clients.

Chrome DevTools MCP is spawned as a command. It is not a peer dependency. Use
`--mcp-package` to pin a package version if needed.

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

Run an LLM-in-the-loop agent eval:

```sh
npm run eval:agent -- evals/agent/pizza-maker.json --headless --channel canary --model "$WEBMCP_RELAY_AGENT_MODEL"
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
