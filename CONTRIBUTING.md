# Contributing

## Development setup

1. Follow the [Quick start](./README.md#quick-start) to run the Compose stack and the web app.
2. Run the tests before every commit:

   ```bash
   npm test
   ```

   Tests use Node's built-in runner (`node --test`) and need no running services. The MCP end-to-end test starts fake HTTP servers.

## Project conventions

- **ES modules** (`"type": "module"`), Node 18+. No build step.
- **Keep business rules in the web app.** The MCP server and UI are clients of the REST API. New capabilities go into `web/server.js` first, then get a thin wrapper in `mcp/tools.js`.
- **Pure logic goes in its own module** (for example `web/summary.js` and `mcp/analysis.js`) so it can be unit-tested without I/O.
- **Never write to stdout in `mcp/`.** stdout carries the MCP protocol, so log with `console.error`.
- **Generated data stays out of git.** `data/` and `results/` are ignored apart from their `.gitkeep` files.

## Adding an MCP tool

1. Add the endpoint or logic (with tests) if it doesn't exist yet.
2. Register the tool in `mcp/tools.js` with a clear plain-English `description`. The assistant reads it to decide when to use the tool. Use `register` for read-only tools and `registerWrite` for anything that changes state, so it respects `MCP_READ_ONLY`.
3. Apply `assertWithinGuardrails` to anything that sets or starts load.
4. Add the tool to the list in `test/mcp-server.test.js` and to the table in `docs/MCP.md`.
5. Add a line under **Unreleased** in `CHANGELOG.md`.

## Commit messages

Use a short imperative summary, for example "Add check_slo MCP tool", with details in the body if needed.
