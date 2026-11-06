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
| `server/providers/*` | the real provider wire (three: Ollama native, Anthropic, OpenAI-compatible) | one live turn calls a tool and answers; the OpenAI wire against the same Ollama model gives the same answer as the native wire | live loop (§4) |
| `web/` | static render (`react-dom/server`) + a browser against the runtime | tool cards show status; error card says it is not an answer; nothing but streamed tokens reads as answer text | `test/web.test.tsx` (9 tests, 4 RED LEG probed 2026-09-18) · `node tools/screenshot.mjs` drives headless Chrome over CDP against the live runtime and writes `docs/screenshot.png` from a real turn — **2026-09-18: two servers, three green cards, grounded answers** (the failed-card state is asserted in the static tests, not yet provoked on screen) |
| this suite | a change | mutation probe: remove a rule, its test goes red | §3 |

## §3 Invariants

Anthropic extended-thinking tool continuations must replay signed and redacted blocks in order without emitting opaque payloads in frames or sharing them across concurrent requests or other providers. `test/providers.test.ts` exercises two concurrent two-turn conversations and an adapter switch with stubbed provider responses; it does not substitute for a live Anthropic call. Schema checks support draft-04, draft-07, 2019-09 and 2020-12 and ignore undefined keywords; the deliberate simple-schema typo guard, the vendor-keyword and draft-04 cases, and the unsupported-dialect failure are covered in `test/agent.test.ts`.

| # | Invariant | Scan |
|---|---|---|
| I1 | No tool is invoked with arguments that fail its `inputSchema` | `test/agent.test.ts` "misspelled argument never reaches the tool" — red when `validateArgs` is bypassed (probed 2026-09-15) |
| I2 | An `isError` result is never rendered as a token | "isError is surfaced as an error frame" — red when the error frame is dropped (probed 2026-09-15) |
| I3 | The iteration cap emits an error, never a silent stop | "iteration cap fires" — red when the error emit is removed (probed 2026-09-15) |
| I4 | `done` exactly once, last | asserted in every loop test |
| I5 | A tool result never renders as answer text; a failed call is a failed card | `test/web.test.tsx` "an assistant turn whose only tool call failed carries no answer text" — red when the card is replaced by a text div; "a failed call renders as an error card" — red when the alert is removed (both probed 2026-09-18) |
| I6 | A frame split across SSE chunks is one frame | "a frame split across two chunks is one frame" — red when the decoder drops the carry-over (probed 2026-09-18) |
| I7 | The client can send only user/assistant turns; a `tool` role never reaches the model | `test/api.test.ts` "a client-supplied tool message is refused" — red when the role check is removed (probed 2026-09-19); `smoke.ts` asserts the 400 through the real socket |
| I8 | Provider wire: split frames reassemble, tool inputs assemble, error frames throw, transcripts map | `test/providers.test.ts` — five probes red 2026-09-19: Ollama carry-over dropped, Ollama error swallowed, Anthropic `input_json_delta` not accumulated, tool results not folded into one user turn, Anthropic stream error ignored |
| I9 | One MCP server failing to start never takes the runtime down; server `isError` passes through | `test/mcp.test.ts` over a REAL stdio server — red when the catch rethrows (beforeAll fails, 5 skipped) and when a missing-server call throws instead of returning `isError` (probed 2026-09-19) |
| I11 | Thinking is its own frame and part: never a token, shown only under debug; Anthropic's signed blocks are privately replayed on tool continuation | `test/agent.test.ts` + `test/providers.test.ts` + `test/web.test.tsx` — probed 2026-09-20: agent forwards thinking as a token, Ollama emits it as content, Anthropic ignores `thinking_delta`, web renders it as answer text — each red; continuation isolation is tested offline |
| I12 | Every model iteration is accounted for: a `turn` frame with the messages SENT (a copy, not the mutated array), tools, usage, ending | probed: turn frame dropped (3 red), post-append transcript instead of the sent one, Ollama usage dropped, Anthropic `max_tokens` not raised past the thinking budget — each red |
| I14 | The OpenAI-compatible wire assembles tool calls by index across fragments, keeps reasoning out of tokens, asks for usage, and hands malformed args to the validator instead of crashing | `test/openai.test.ts` — seven mutations red 2026-09-20: carry-over dropped, fragments not accumulated, index ignored, reasoning as tokens, `stream_options` dropped, malformed args thrown, `tool_call_id` blanked |
| I13 | Traces are written per request, listed and read back, and an id can never name a file outside the trace dir | `smoke.ts` over the real socket: health reports traces, a 400 writes none, unknown id 404, `..%2F` id 404 |
| I10 | Model text renders as markdown to React elements only; no HTML path, `javascript:` links refused | `test/markdown.test.tsx` — five mutations red 2026-09-20: headings unparsed, `javascript:` allowed, nested children dropped, fence body collapsed, tool pseudo-link as anchor; +2 same day for bare-URL autolink: branch removed, trailing punctuation not peeled; +4 for italics (operator-caught in the printings list): branch removed, italic not recursive, bold not recursive, word-internal `_` italicised |

⚠️ **The first mutation-probe run reported all three "STAYED GREEN" — the probe was wrong, not the tests.** Its regex read vitest's summary line through ANSI colour codes and never matched `Tests N failed`. Re-run with the codes stripped: all three red. Rule 23 — a verifier's mass result is a claim about the verifier first.

## §4 Ladder

| Class | Rungs |
|---|---|
| loop / validation (`server/agent.ts`) | `npm test` + re-run the three mutation probes (README § Rules) |
| MCP manager (`server/mcp.ts`) | `npm test` (real stdio fixture) + `npm run smoke` (real runtime, every route, stopped by PID) |
| provider wire changes | `npm test` (stubbed-fetch wire tests) + one live turn (`POST /api/chat`) against the real provider, frames read |
| `/api/*` shape | `npm test` (`test/api.test.ts`) + `npm run smoke` |
| CI matrix | Node 22.12 and 24 (`.github/workflows/ci.yml`: typecheck · test · build · smoke) |
| web | `npm test` (the web RED LEGs) + `node tools/screenshot.mjs` against the live runtime; open it and click one failed tool card; with debug on, open a thinking block and a turn strip |
| debug surface | `npm test` (agent/providers/web debug tests) + `npm run smoke` (trace routes) + one live turn on a thinking model with `MCP_CHAT_THINK=1 MCP_CHAT_TRACE=1`, frames read: `thinking` present, `turn` per iteration, trace file on disk |
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

- 2026-11-05 — A full review exercised a browser through the Vite proxy, HTTP runtime and a separate stdio MCP process. Local Llama 3.2 called `fixture__echo` with `orchid-72`, received the echoed value and finished on iteration two. A separate run returned a provider error, which reached the browser as an error. The socket smoke test checks refusal of a foreign origin, delivery of the configured Ollama system message and cancellation of a streaming model request when the client disconnects. Provider framing and declared tool schemas have independent negative cases in the offline suite. Hosted model accounts were outside this run.

- 2026-09-15 — none yet in the artifact. Two instrument escapes during the build, both recorded above: the ANSI-blind mutation probe, and the orphan sweep that matched `tsx`.
- 2026-09-20, later — **the testbed had no instruments** (operator: "as a testing bed its not that great — there's no log or ability to see the model thinking"). It could show a call and a result and nothing in between: no reasoning, no prompt, no cost, no record. Measured first: Ollama rejects `think:true` on `qwen3-coder` ("does not support thinking") and honours it on `qwen3.6`; its final frame carries token counts and durations; Anthropic streams `thinking_delta` under a budget and usage on `message_start`/`message_delta`. Built as three layers, red-first, 11 mutations red: `thinking` + `turn` frames in the loop (the turn carries a COPY of the messages sent — a probe confirmed the live array would have shown the post-append transcript), provider support with a one-shot think probe, a JSONL trace store with two read routes, and a debug toggle in the UI. Live on `qwen3.6:35b-a3b`: 231 thinking frames, two turn strips reading 8,070 then 9,880 prompt tokens. The first trace ever written caught a real failure before any of this was proven — `Ollama unreachable` — because the operator's Ollama updater had stopped the service mid-session.
- 2026-09-20 — in the artifact, operator-caught on the second day of testing: **model text was shown raw** (`###`, `- ` bullets, `[tool](link)`) because only `**bold**` was rendered and the "plain prose" instruction in the system prompt does not hold on a local model. Replaced by `web/src/markdown.tsx` (the subset models emit, React elements only, red-first + 5 probes). Same session: **the vite proxy dropped the SSE stream during the model's silent prefill of a large tool result** ("network error" in the UI; the same request straight to :8731 completed, 841 frames / 59 s) — `timeout: 0, proxyTimeout: 0` on the `/api` proxy. Both were invisible to every rung because the rungs render statically and call the runtime directly; the browser-through-proxy path had no instrument. `tools/screenshot.mjs` drives that path but only asserts a screenshot, not a `done` frame.
- 2026-09-19 — none in the artifact. One instrument escape: the mutation probe's summary regex read vitest's `Tests 1 passed | 5 skipped` (a failed `beforeAll`) as zero failures and printed STAYED GREEN for a mutation that had in fact broken the suite. **The exit code is the verdict; a parsed summary line is a convenience** — the re-run keyed on `npm` exit status reported RED.
- 2026-09-18 — none in the artifact. Two more instrument escapes: the web mutation probe's first run crashed on a cp1252 decode of vitest's output before any verdict, and its `write_text` restore rewrote a file's line endings (fixed with `newline=""`; `git status` is the check). And `tools/screenshot.mjs` first targeted `127.0.0.1:5173` while vite binds `localhost`, which resolves to `::1` here — the page was a connection-refused error and the script correctly refused to shoot it.
