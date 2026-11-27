# mcp-chat handoff

## Last Updated

### 2026-11-25 to 26 — MCP security audit: read-only calls only, pinned example config, link hosts shown (Opus 5.5, root cwd)

`44a0193` a tool call runs only when the tool declares `readOnlyHint: true` or its server has `"readOnly": true` in the config; write tools do not run. `ec22488` the example config pins each `npx -y` package to its published version, and fixes `"readOnly"` sitting inside `env`. `b66c613` a `[text](https://...)` link whose text does not name its real host shows the host beside it. `f51dbf7` a started MCP server never inherits the runtime's secrets (test). All pushed. By design, not changed: the OpenAI key follows `OPENAI_BASE_URL` (both are the operator's environment); traces are off unless `MCP_CHAT_TRACE` is set and never deleted (the operator's call). Audit record: the operator's local MCP security audit report, rows 10, 12, 25.

### 2026-11-06 — Vendor keywords and draft-04 no longer fail every call (Fable 5.1)

Audit finding MC-1 (`F:/claude/.coord/reviews/fable-audit-codex-2026-11-06.md`): `validateArgs` compiled every `inputSchema` with Ajv `strict: true`, so one `x-` vendor keyword or OpenAPI `nullable` made every call to that tool fail with "strict mode: unknown keyword" before the server was reached, and a draft-04 `$schema` failed with "no schema with key or ref". Now `strictSchema: false` (undefined keywords ignored as JSON Schema specifies; `strictNumbers` kept; the meta-schema still rejects a malformed keyword the dialect does define) and `ajv-draft-04` serves draft-04 (boolean `exclusiveMaximum` enforced). External `$ref`, `$async` and undeclared dialects (draft-06 in the test) still fail closed. The `unknownValidationKeyword` pin in `test/agent.test.ts` flipped from reject to accept; README rule 1 and GAUNTLET updated. An unknown `format` is ignored with Ajv's console warning at compile time. Four commits ahead of origin now, nothing pushed; `studio-site/public/mcp-chat.html` and the evidence ledger pin dbc1083 and go stale on push (audit S-6).

verify: `npx vitest run && npm run typecheck` — 118 tests. With `strict: true` restored the new case fails on exactly the old error.

### 2026-11-05 — Anthropic continuation and schema dialect (gpt-6.1-terra)

Goal was to preserve signed Anthropic thinking blocks through tool continuations and support draft 2019-09. The agent retains provider-only state per assistant message, replays ordered thinking, redacted, text and tool blocks only to Anthropic, and keeps opaque values out of frames. Concurrent conversations and adapter switching are covered by offline tests. The deliberate simple-schema typo guard and supported dialects are documented. Remaining: live Anthropic confirmation; no paid call was authorized.

verify: `npx vitest run test/agent.test.ts test/providers.test.ts && npm run typecheck`

### 2026-11-05 — Full runtime and browser audit (gpt-6-astra)

Fresh gpt-6.1-sol and gpt-6.1-terra reviews covered the agent, providers, stdio, HTTP, browser, CI and public work sample. The runtime now checks tool argument schemas, origin, input size, stream completion and cancellation across those boundaries. MCP setup drains stderr, closes failed children and validates tool discovery and names. The README distinguishes the published housing regression from its separate successful screenshot.

The final peer challenge reproduced incorrect rejection of an extra key in a pattern-property schema. The flat typo policy now defers to schemas with key constraints or composition. A test exercises permissive, constrained, and explicitly closed cases.

One real local Llama 3.2 turn through the browser called a stdio fixture and returned its value in two iterations. The socket smoke also exercises rejection and client disconnect. See `GAUNTLET.md` for the verification limits.

verify: `npm ci && npm run typecheck && npm test && npm run build:web && npm run smoke`
