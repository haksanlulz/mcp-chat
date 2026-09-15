# mcp-chat

A local-first chat UI for MCP servers. A small TypeScript runtime spawns any MCP servers you list over stdio, hands their tools to a model (Ollama locally, or the Anthropic API), runs the tool loop, and streams tokens and tool calls to a React front end that renders every call as a card — arguments, result, and whether it failed.

No framework on the server (`node:http` + SSE), no SDK for the model providers (raw fetch), one runtime dependency: `@modelcontextprotocol/sdk`.

## Run

```
npm install
cp mcp-chat.config.example.json mcp-chat.config.json   # edit the servers list
npm run dev:server        # runtime on http://127.0.0.1:8731
npm run dev:web           # UI on http://127.0.0.1:5173, proxies /api to the runtime
```

Model selection, by environment:

| env | provider |
|---|---|
| `ANTHROPIC_API_KEY` set | Anthropic Messages API; `ANTHROPIC_MODEL` (default `claude-sonnet-5`) |
| otherwise | Ollama at `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`); `OLLAMA_MODEL` (default `qwen3-coder:30b`) |

`MCP_CHAT_PORT` (8731) and `MCP_CHAT_CONFIG` (path) override the defaults. The runtime binds 127.0.0.1 only.

## Config

```json
{
  "system": "optional system prompt",
  "maxIterations": 8,
  "servers": [
    { "name": "housing", "command": "npx", "args": ["-y", "@haksanlulz/mcp-nychousing"] },
    { "name": "cards",   "command": "npx", "args": ["tsx", "/path/to/mcp-scryfall/index.ts"], "cwd": "/path/to/mcp-scryfall" }
  ]
}
```

Each server's tools are exposed to the model as `<name>__<tool>`, so two servers can both have a `search`. A server that fails to start is reported on `/api/health` and in the UI's header; the assistant runs with whatever came up. The child process gets `PATH` and the platform basics plus the `env` you give it, not the whole shell environment.

## HTTP

| route | |
|---|---|
| `GET /api/health` | `{ ok, model, servers: [{ name, state: up\|failed, tools, error? }] }` |
| `GET /api/tools` | the qualified tool list the model sees |
| `POST /api/chat` | `{ messages: [{ role, content }] }` → `text/event-stream` of frames below |

Frames, in order: `token` · `tool_call` · `tool_result` (with `isError`) · `error` · `done` (`stoppedBy: answer | cap | error`). `done` is emitted exactly once, last.

## Rules the loop enforces

Each has a test in `test/agent.test.ts`, and each test was shown to fail when the rule was removed (mutation-probed 2026-09-15) before it was trusted.

1. **Arguments are validated against the tool's `inputSchema` before any call** — missing required key, unknown key (with a near-miss suggestion), wrong type. The MCP SDK's low-level `Server` does not validate `inputSchema` on the far side, so a misspelled key would otherwise be dropped silently. A bad call becomes an `isError` result the model can read; the tool is never invoked.
2. **A tool error is surfaced as an error frame and fed back; it never becomes text.** The UI renders it as a failed card with "this is not an answer". A thrown tool becomes an `isError` result, not a crash.
3. **The iteration cap is loud.** Hitting it emits an `error` frame and `done(cap)`; nothing is truncated quietly.
4. **Unknown tool names are refused before any call.**

## Measured

2026-09-15, this machine (AMD 7900 XTX, Ollama on ROCm):

- `npm test` — 12/12; `npm run typecheck` clean; `vite build` 228 KB JS.
- Runtime over a real server (`mcp-scryfall` via `tsx` over stdio): `/api/health` up with 7 tools, `/api/tools` lists them qualified, malformed `POST /api/chat` → 400.
- **Full loop, local model:** `qwen3-coder:30b` was asked for Lightning Bolt's text and cost. It called `cards__card_named {"name":"Lightning Bolt"}`, the server answered, and the model wrote one sentence quoting the real Oracle text and `{R}` — 2 iterations, `stoppedBy: answer`, 27 tokens.
- **In the browser, two turns:** asked about Lightning Bolt and a misspelled "Lightning Bolp" — the model called `card_named` for the first and chose `card_fuzzy` for the typo, both cards rendered green with server › tool and the arguments, and the answer quoted `{R}` / 3 damage and called the second a typo. A follow-up ("mana cost of Counterspell") called `card_named` again and answered `{U}{U}`. Enter-to-send verified with a dispatched `keydown` (the harness's synthetic Return key did not reach React; a real keyboard does).

## Not yet

- Tool history is not round-tripped across requests; each `POST /api/chat` sends the human-readable transcript only.
- No auth, no TLS, no remote MCP transports — local tool, local model, local servers.
- No tests for the providers' wire parsing beyond the live run above.
