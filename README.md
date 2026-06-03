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

## Modes

By default, `webmcp-relay` runs in dynamic mode.

Dynamic mode exposes wrapper tools first:

- `webmcp_open_site`
- `webmcp_refresh_tools`
- `webmcp_list_tools`
- `webmcp_call_tool`
- `webmcp_search_registry`
- `webmcp_execute_registry_tool`

After `webmcp_open_site`, it calls Chrome DevTools MCP `list_webmcp_tools`,
rebuilds its MCP tool list, and sends `notifications/tools/list_changed`.
Clients that refresh tools will then see page tools such as `webmcp_tool_query`.

Stable mode is available for clients that do not support dynamic tool-list
refresh:

```sh
npx -y webmcp-relay --stable
```

In stable mode, use `webmcp_list_tools` and `webmcp_call_tool`.

## Local Tool Registry

`webmcp-relay` keeps a local registry of WebMCP tools discovered over time. This
adds a Web Intents-style lookup layer: a user-agent-local list of sites and
capabilities that can be searched globally, not only on the active page.

Discovery updates:

- `webmcp_open_site` discovers the page's tools and stores them.
- `webmcp_refresh_tools` refreshes the active page's tools and stores them.

Use updates:

- Calling a dynamic page tool updates its `useCount` and `lastUsed`.
- Calling `webmcp_call_tool` updates its `useCount` and `lastUsed`.
- Calling `webmcp_execute_registry_tool` updates its `useCount` and `lastUsed`.

Registry lookup:

- `webmcp_search_registry` searches previously discovered tools by task, tool
  name, description, URL, and input schema fields.
- `webmcp_execute_registry_tool` opens the stored site URL, refreshes its current
  WebMCP tools, verifies the registered tool still exists, then executes it.

The default registry path is:

- macOS: `~/Library/Application Support/webmcp-relay/registry.json`
- Linux/other: `$XDG_DATA_HOME/webmcp-relay/registry.json` or
  `~/.local/share/webmcp-relay/registry.json`

Override it:

```sh
npx -y webmcp-relay --registry-db /path/to/registry.json
```

Disable it:

```sh
npx -y webmcp-relay --no-registry
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
npm run relay -- --headless --channel canary --registry-db ./registry.json
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
`webmcp_open_site`, receiving `tools/list_changed`, then calling the dynamically
exposed `webmcp_tool_query`.

Registry lookup was verified by opening the analytics dashboard demo, searching
for `filter POST server logs`, receiving the stored `query` tool match, then
executing it via `webmcp_execute_registry_tool`.

Stable relay was verified by connecting an MCP client over stdio, listing
`webmcp_open_site,webmcp_refresh_tools,webmcp_list_tools,webmcp_call_tool`,
discovering the page tool `query`, and calling it.

## Test

```sh
npm test
```

The unit tests use fake bridges for relay behavior, so they do not require
Chrome.
