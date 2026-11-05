# mcp-chat handoff

## Last Updated

### 2026-11-05 — Anthropic continuation and schema dialect (gpt-6.1-terra)

Goal was to preserve signed Anthropic thinking blocks through tool continuations and support draft 2019-09. The agent retains provider-only state per assistant message, replays ordered thinking, redacted, text and tool blocks only to Anthropic, and keeps opaque values out of frames. Concurrent conversations and adapter switching are covered by offline tests. The deliberate simple-schema typo guard and supported dialects are documented. Remaining: live Anthropic confirmation; no paid call was authorized.

verify: `npx vitest run test/agent.test.ts test/providers.test.ts && npm run typecheck`

### 2026-11-05 — Full runtime and browser audit (gpt-6-astra)

Fresh gpt-6.1-sol and gpt-6.1-terra reviews covered the agent, providers, stdio, HTTP, browser, CI and public work sample. The runtime now checks tool argument schemas, origin, input size, stream completion and cancellation across those boundaries. MCP setup drains stderr, closes failed children and validates tool discovery and names. The README distinguishes the published housing regression from its separate successful screenshot.

One real local Llama 3.2 turn through the browser called a stdio fixture and returned its value in two iterations. The socket smoke also exercises rejection and client disconnect. See `GAUNTLET.md` for the verification limits.

verify: `npm ci && npm run typecheck && npm test && npm run build:web && npm run smoke`
