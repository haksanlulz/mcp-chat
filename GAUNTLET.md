# GAUNTLET — mcp-chat

Constraint state for this repo. `README.md` says what it does; this says what has to pass before a change is done.

## §1 Oracle — done-definition

A change is DONE when:

1. `npm test` is green and every rule in README § "Rules the loop enforces" still has a test that goes red when the rule is removed.
2. `npm run typecheck` is clean.
3. The runtime starts against at least one real MCP server over stdio and `/api/tools` lists its tools qualified.
4. One real question through `POST /api/chat` against a live model produces a `tool_call` → `tool_result` → `done(answer)` sequence, read from the frames, not from the UI.
5. The UI renders a failed tool call as a failed card, never as answer text.

## §2 Channel map

| Artifact | Real channel | Pass condition | Rung |
|---|---|---|---|
| `server/agent.ts` | the loop's own event stream | every frame type in order; `done` once, last; cap and errors loud | `npm test` |
| `server/mcp.ts` | a real MCP server over stdio | `/api/health` up, `/api/tools` lists `<server>__<tool>` names | runtime smoke (§4) |
| `server/providers/*` | the real provider wire | one live turn calls a tool and answers | live loop (§4) |
| `web/` | static render (`react-dom/server`) + a browser against the runtime | tool cards show status; error card says it is not an answer; nothing but streamed tokens reads as answer text | `test/web.test.tsx` (9 tests, 4 RED LEG probed 2026-09-18) · `node tools/screenshot.mjs` drives headless Chrome over CDP against the live runtime and writes `docs/screenshot.png` from a real turn — **2026-09-18: two servers, three green cards, grounded answers** (the failed-card state is asserted in the static tests, not yet provoked on screen) |
| this suite | a change | mutation probe: remove a rule, its test goes red | §3 |

## §3 Invariants

| # | Invariant | Scan |
|---|---|---|
| I1 | No tool is invoked with arguments that fail its `inputSchema` | `test/agent.test.ts` "misspelled argument never reaches the tool" — red when `validateArgs` is bypassed (probed 2026-09-15) |
| I2 | An `isError` result is never rendered as a token | "isError is surfaced as an error frame" — red when the error frame is dropped (probed 2026-09-15) |
| I3 | The iteration cap emits an error, never a silent stop | "iteration cap fires" — red when the error emit is removed (probed 2026-09-15) |
| I4 | `done` exactly once, last | asserted in every loop test |
| I5 | A tool result never renders as answer text; a failed call is a failed card | `test/web.test.tsx` "an assistant turn whose only tool call failed carries no answer text" — red when the card is replaced by a text div; "a failed call renders as an error card" — red when the alert is removed (both probed 2026-09-18) |
| I6 | A frame split across SSE chunks is one frame | "a frame split across two chunks is one frame" — red when the decoder drops the carry-over (probed 2026-09-18) |

⚠️ **The first mutation-probe run reported all three "STAYED GREEN" — the probe was wrong, not the tests.** Its regex read vitest's summary line through ANSI colour codes and never matched `Tests N failed`. Re-run with the codes stripped: all three red. Rule 23 — a verifier's mass result is a claim about the verifier first.

## §4 Ladder

| Class | Rungs |
|---|---|
| loop / validation (`server/agent.ts`) | `npm test` + re-run the three mutation probes (README § Rules) |
| MCP manager / providers | `npm test` + `npm run typecheck` + runtime smoke: start with a real server, `curl /api/health`, `curl /api/tools` |
| provider wire changes | + one live turn (`POST /api/chat`) against the real provider, frames read |
| web | `npm test` (the four web RED LEGs) + `node tools/screenshot.mjs` against the live runtime; open it and click one failed tool card |
| docs only | none |

**Runtime smoke, verbatim** (needs a local MCP server checkout; adjust the path):

```
cat > mcp-chat.config.json <<'EOF'
{ "servers": [ { "name": "cards", "command": "npx", "args": ["tsx", "/path/to/mcp-scryfall/index.ts"], "cwd": "/path/to/mcp-scryfall" } ] }
EOF
npx tsx server/index.ts &   # then:
curl -s http://127.0.0.1:8731/api/health
curl -s http://127.0.0.1:8731/api/tools
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8731/api/chat   # 400
```

⚠️ **Stop the runtime by PID, and confirm.** Killing the `npx` wrapper leaves the `tsx` child and the spawned MCP servers alive; a later smoke then talks to the *old* runtime and reads as green for the wrong process (happened 2026-09-15). And when sweeping orphans, match on `mcp-chat`, not on `tsx` — the workspace's own Claude Code sessions run their MCP servers through `tsx` too, and a broad filter took them all down.

## §5 Acceptance specs

```
SPEC a-bad-tool-call-never-leaves-the-runtime
Given a model that emits a tool call with a misspelled or missing argument
When the loop processes it
Then the tool is not invoked, the model receives an isError result naming the
     problem (and the nearest accepted key), and the UI shows a failed card
Check: test/agent.test.ts "RED LEG: a misspelled argument never reaches the tool"
```

```
SPEC an-error-is-never-an-answer
Given a tool result with isError, or a tool that throws, or the cap
When the loop reports it
Then it arrives as tool_result{isError} / error frames, never as token frames,
     and done carries stoppedBy = error | cap accordingly
Check: test/agent.test.ts "RED LEG: a tool that returns isError…", "…thrown tool…", "…iteration cap…"
```

## §6 Escape log

- 2026-09-15 — none yet in the artifact. Two instrument escapes during the build, both recorded above: the ANSI-blind mutation probe, and the orphan sweep that matched `tsx`.
- 2026-09-18 — none in the artifact. Two more instrument escapes: the web mutation probe's first run crashed on a cp1252 decode of vitest's output before any verdict, and its `write_text` restore rewrote a file's line endings (fixed with `newline=""`; `git status` is the check). And `tools/screenshot.mjs` first targeted `127.0.0.1:5173` while vite binds `localhost`, which resolves to `::1` here — the page was a connection-refused error and the script correctly refused to shoot it.
