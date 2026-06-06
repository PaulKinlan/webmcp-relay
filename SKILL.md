# WebMCP Relay

Use this skill when the user asks to open, visit, browse, go to, load, inspect,
or navigate to a web page, URL, or site and the `webmcp-relay` MCP server is
available.

## Navigation

- Call `open_page` for ordinary page navigation. The user does not need to say
  WebMCP, MCP, relay, or tool.
- Use `open_page` whenever a task starts with or implies opening a URL or
  website. It opens the page in Chrome, discovers page WebMCP tools, and updates
  the MCP tool list.
- Use `webmcp_open_site` only as a compatibility alias when `open_page` is not
  available.

## Page Tools

- After `open_page`, prefer newly exposed dynamic page tools such as
  `webmcp_tool_*` when the client refreshed its tool list.
- If dynamic page tools are not available, call `webmcp_list_tools` to inspect
  current page tools and `webmcp_call_tool` to invoke one by its original
  WebMCP name.
- Call `webmcp_refresh_tools` after page state changes when the available page
  tools may have changed.
- Use `chrome_*` tools for browser and page interactions outside WebMCP, such as
  closing tabs, selecting pages, clicking, typing, waiting, screenshots, or page
  inspection. These are proxied from Chrome DevTools MCP after the relay has
  connected to Chrome.

## Registry Tools

- Use `webmcp_search_registry` when the user describes a task or intent that
  might be satisfied by a tool discovered on a previous page.
- Use `webmcp_execute_registry_tool` with a registry result id to open the saved
  site, refresh its current WebMCP tools, and execute the selected tool.

## Examples

User: "Open https://example.com"

Action: call `open_page` with `{ "url": "https://example.com" }`.

User: "Go to the analytics dashboard and show POST 500s"

Action: call `open_page`, then use a matching dynamic page tool or
`webmcp_call_tool`.

User: "Find a tool that can order pizza"

Action: call `webmcp_search_registry` with the task, then call
`webmcp_execute_registry_tool` for the selected registry result.
