# mcp-chat handoff

## Last Updated

### 2026-11-05 — Full runtime and browser audit (gpt-6-astra)

Fresh gpt-6.1-sol and gpt-6.1-terra reviews covered the agent, providers, stdio, HTTP, browser, CI and public work sample. The runtime now checks tool argument schemas, origin, input size, stream completion and cancellation across those boundaries. MCP setup drains stderr, closes failed children and validates tool discovery and names. The README distinguishes the published housing regression from its separate successful screenshot.

One real local Llama 3.2 turn through the browser called a stdio fixture and returned its value in two iterations. The socket smoke also exercises rejection and client disconnect. See `GAUNTLET.md` for the verification limits.

verify: `npm ci && npm run typecheck && npm test && npm run build:web && npm run smoke`
