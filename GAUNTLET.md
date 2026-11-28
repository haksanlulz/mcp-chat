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

## §7 WEB-1 — ASVS 5.0.0 level 2

App standard WEB-1: ASVS 5.0.0, every level-1 and level-2 item of chapters V1, V3, V13, V14 and V16, taken from the official CSV (`OWASP_Application_Security_Verification_Standard_5.0.0_en.csv`, GitHub release `v5.0.0_release` of OWASP/ASVS), tagged 2026-11-28. Item ids are the CSV's; the short text is a paraphrase, the CSV holds the requirement.

Tags: **gate**, an automated check named in the cell (opened and read when tagged); **review**, a person or session checks what the cell names; **N/A: reason**, the item cannot apply (`N/A: single-user local tool` for server-infrastructure items, as WEB-1 rules); **GAP**, neither enforced nor reviewed, with what closes it.

### V1 Encoding and Sanitization (27 items)

| Item | L | Requirement (short) | Tag | Evidence |
|---|---|---|---|---|
| V1.1.1 | 2 | Decode input to canonical form once, before validation | review | `readJson` decodes the body once as fatal UTF-8 after the size limit (`server/index.ts:81`); an asset path is `decodeURIComponent`-ed once and then checked for containment (`server/web.ts:81-84`; encoded `..` cases in `test/http-guard.test.ts` "serves the built assets ... nothing outside the web dir"). Double encoding is not tested. |
| V1.1.2 | 2 | Output encoding is the last step before the interpreter | **gate** | The front end renders through React elements only: `npm run lint` (eslint-plugin-no-unsanitized, in CI) and `test/markdown.test.tsx` "RED LEG: no HTML path — angle brackets and a script tag stay text ...". |
| V1.2.1 | 1 | Context-correct output encoding for HTTP, HTML, XML | **gate** | `test/markdown.test.tsx` "RED LEG: no HTML path ..." (`<script>` stays `&lt;script&gt;`) and `test/web.test.tsx` "leaves an unbalanced marker alone and never opens an HTML path"; header values are constants. |
| V1.2.2 | 1 | Encode untrusted data in built URLs; only safe URL schemes | **gate** | `test/markdown.test.tsx` "RED LEG: no HTML path ... a link never becomes an anchor to javascript:" and "WEB-4: data:, vbscript: and protocol-relative links never become anchors"; links are http(s) only (`web/src/markdown.tsx`). |
| V1.2.3 | 1 | Encode when building JavaScript or JSON | review | Every SSE frame and JSON body is `JSON.stringify` (`server/index.ts:131`, `:200`), so model or tool text cannot break a frame; `test/stream.test.ts` "browser SSE boundary" covers parsing, not this encoding. |
| V1.2.4 | 1 | Parameterized database queries | N/A: no database | Traces are JSONL files; nothing else persists. |
| V1.2.5 | 1 | No OS command injection | review | MCP servers start from the operator's config file (command and argument array, no shell, `server/mcp.ts:74`); no request or model output reaches a command line. |
| V1.2.6 | 2 | No LDAP injection | N/A: no LDAP |  |
| V1.2.7 | 2 | No XPath injection | N/A: no XPath |  |
| V1.2.8 | 2 | LaTeX processors locked down | N/A: no LaTeX |  |
| V1.2.9 | 2 | Escape regex metacharacters from input | N/A: builds no regex from input | Every `RegExp` is a literal (grep 2026-11-28). |
| V1.3.1 | 1 | Sanitize WYSIWYG HTML with a known library | N/A: accepts no HTML input | Model text is parsed as a Markdown subset into React elements (V1.3.5). |
| V1.3.2 | 1 | No eval or dynamic code execution | review | No `eval` or `new Function` in `server/` or `web/src/` (grep 2026-11-28). In the page, `test/http-guard.test.ts` "RED LEG: a fresh nonce per response ..." asserts no `'unsafe-eval'` and Trusted Types with no policy. Closing as a gate: eslint `no-eval` and `no-implied-eval`. |
| V1.3.3 | 2 | Sanitize and bound data for dangerous contexts | **gate** | Model tool arguments are validated against the tool's `inputSchema` before any call: `test/agent.test.ts` "validateArgs runs before any call" and "RED LEG: a misspelled argument never reaches the tool ..."; request size caps in `test/api.test.ts` "caps count and size ...". |
| V1.3.4 | 2 | Sanitize user-supplied SVG | N/A: accepts no SVG | SVG is served only from the build's own `assets/`. |
| V1.3.5 | 2 | Sanitize or disable user Markdown, CSS, XSL, BBCode | **gate** | `test/markdown.test.tsx` (Markdown subset to React elements; "RED LEG: no HTML path ...", "WEB-4: data:, vbscript: ...", "RED LEG: a link whose text hides its destination shows the real host beside it") and `npm run lint`. |
| V1.3.6 | 2 | SSRF: allowlist protocols, hosts, paths, ports | review | The runtime calls only the provider base URL set by the operator (`OPENAI_BASE_URL`, Anthropic, `OLLAMA_BASE_URL`) and the configured MCP servers; nothing in a request chooses a destination. What a tool fetches is that server's own concern; only read-only tools run (`test/mcp.test.ts` "only read-only tools run"). |
| V1.3.7 | 2 | No templates built from untrusted input | N/A: no template engine |  |
| V1.3.8 | 2 | No JNDI injection | N/A: no JNDI (Node.js) |  |
| V1.3.9 | 2 | Sanitize data sent to memcache | N/A: no memcache |  |
| V1.3.10 | 2 | Sanitize format strings | review | Failed-server status lines and fatal errors are escaped to one line (`statusLine`, `oneLine` in `server/log.ts`); other `console.error` calls print the runtime's own text. |
| V1.3.11 | 2 | No SMTP/IMAP injection | N/A: sends no mail |  |
| V1.4.1 | 2 | Memory-safe strings and copies | N/A: memory-safe runtime | TypeScript on Node.js; no native code. |
| V1.4.2 | 2 | Prevent integer overflow | review | Bounds are explicit: 200 messages, 32,000 characters each (`server/api.ts`), 8 MiB body (`server/index.ts:80`), tools/list pagination capped at 100 pages (`server/mcp.ts:98`). |
| V1.4.3 | 2 | Release memory; no dangling pointers | N/A: memory-safe runtime | Garbage-collected. |
| V1.5.1 | 1 | XML parsers: no external entities (XXE) | N/A: parses no XML |  |
| V1.5.2 | 2 | Safe deserialization of untrusted data | **gate** | Only `JSON.parse`, then shape checks: `test/api.test.ts` "RED LEG: a client-supplied tool message is refused ...", "drops extra keys rather than forwarding them", "refuses an empty list, a missing key, a non-object body ...". |

### V3 Web Frontend Security (19 items)

| Item | L | Requirement (short) | Tag | Evidence |
|---|---|---|---|---|
| V3.2.1 | 1 | Responses cannot render in the wrong context | **gate** | API, refusal and 404 responses carry a deny-all CSP (`default-src 'none'`) and `nosniff`: `test/http-guard.test.ts` "RED LEG: nosniff, frame denial, a deny-all CSP ..."; assets get their own type ("serves the built assets with their types ..."); cross-site loads are refused (WEB-3). |
| V3.2.2 | 1 | Text rendered with textContent / createTextNode | **gate** | `npm run lint` in CI and `test/markdown.test.tsx` "RED LEG: no HTML path ..."; React sets text, never HTML. |
| V3.3.1 | 1 | Cookies Secure with __Host-/__Secure- prefix | N/A: sets no cookies | No `Set-Cookie` or `document.cookie` (grep 2026-11-28). |
| V3.3.2 | 2 | Cookie SameSite set by purpose | N/A: sets no cookies |  |
| V3.3.3 | 2 | Cookies use __Host- prefix | N/A: sets no cookies |  |
| V3.3.4 | 2 | HttpOnly on cookies scripts need not read | N/A: sets no cookies |  |
| V3.4.1 | 1 | HSTS on all responses, max-age >= 1 year | N/A: single-user local tool | Served over plain HTTP on 127.0.0.1 only; HSTS applies to HTTPS hosts and browsers ignore it on HTTP. |
| V3.4.2 | 1 | CORS Allow-Origin fixed or allowlisted | review | No `Access-Control-Allow-*` header is sent (grep 2026-11-28); a foreign `Origin` is refused 403 (`test/http-guard.test.ts` WEB-3). The absence of the header is not asserted. |
| V3.4.3 | 2 | CSP with object-src/base-uri 'none' and nonces or allowlist | **gate** | `test/http-guard.test.ts` "RED LEG: a fresh nonce per response, on every script tag, strict-dynamic, no policy may be created": nonce, `object-src 'none'`, `base-uri 'none'`, no `'unsafe-inline'`. The Vite dev page: `test/vite-dev-csp.test.ts`. |
| V3.4.4 | 2 | X-Content-Type-Options: nosniff on all responses | **gate** | `test/http-guard.test.ts` asserts `nosniff` on JSON, refusals, 404 and assets; it is set before routing (`server/index.ts:152`). |
| V3.4.5 | 2 | Referrer policy set | **gate** | `test/http-guard.test.ts` "RED LEG: nosniff, frame denial ..." asserts the referrer policy (`no-referrer`). |
| V3.4.6 | 2 | CSP frame-ancestors on every response | **gate** | `test/http-guard.test.ts` asserts `frame-ancestors 'none'` on JSON, refusals, 404 and the page. |
| V3.5.1 | 1 | Cross-origin requests to sensitive functions validated (CSRF) | **gate** | Host, Origin and `Sec-Fetch-Site` (`cross-site` and `same-site`) are checked before any route, whatever the method: `test/http-guard.test.ts` "RED LEG: a same-site request (another localhost port) is refused, not only cross-site". |
| V3.5.2 | 1 | If relying on preflight, no non-preflighted call works | **gate** | The app does not rely on preflight (V3.5.1 is the control); a `text/plain` POST, the non-preflighted form, gets 415: `test/http-guard.test.ts` "RED LEG: a rejected chat body (wrong type, bad shape) writes a rejected line". |
| V3.5.3 | 1 | Sensitive functions not on safe methods (or Sec-Fetch checked) | **gate** | The only state-changing route is `POST /api/chat`; GETs read, and a cross-site GET is refused (`test/http-guard.test.ts` WEB-3). `GET /api/trace/:id` returns conversation text and is covered by the same guard. |
| V3.5.4 | 2 | Separate apps on separate hostnames | **gate** | fixed 2026-11-28, was GAP. The runtime answers as `mcp-chat.localhost`, a site of its own (each `*.localhost` name is its own site; 127.0.0.1 is one site for every local tool), and prints that URL at start; another `.localhost` name is refused. `test/http-guard.test.ts` "RED LEG: mcp-chat.localhost is served as the app, and a same-site page is still refused". 127.0.0.1 and localhost still answer, for clients and old bookmarks, and a page on another local tool is still refused as same-site. |
| V3.5.5 | 2 | postMessage from untrusted origins discarded | N/A: no cross-document messaging | No `postMessage` or `message` listener. |
| V3.7.1 | 2 | Only supported client-side technologies | **gate** | No plugins; `object-src 'none'` asserted in `test/http-guard.test.ts`. |
| V3.7.2 | 2 | Off-site auto-redirects only to an allowlist | N/A: issues no redirects |  |

### V13 Configuration (13 items)

| Item | L | Requirement (short) | Tag | Evidence |
|---|---|---|---|---|
| V13.1.1 | 2 | All communication needs documented | review | README § provider table and the config file name every outbound channel: one model provider, the configured MCP servers. Check when a provider is added. |
| V13.2.1 | 2 | Backend components authenticate without static credentials | N/A: single-user local tool | MCP servers are stdio children on one machine; provider keys are static keys issued by the provider. |
| V13.2.2 | 2 | Backend communication with least privilege | **gate** | `test/mcp.test.ts` "passes the config's own env and none of the parent's secrets" and "refuses a tool that does not [declare read-only], and never reaches the server". |
| V13.2.3 | 2 | No default credentials for service auth | N/A: single-user local tool | No account or password of its own. |
| V13.2.4 | 2 | Allowlist of external resources the app may reach | review | The config file is the allowlist of servers; one provider URL; only read-only tools run (`test/mcp.test.ts` "only read-only tools run"). |
| V13.2.5 | 2 | Server-level allowlist for outbound requests | N/A: single-user local tool | No separate web server or firewall layer; V13.2.4 is the application-layer allowlist. |
| V13.3.1 | 2 | Secrets in a secrets manager, not source or builds | **gate** | fixed 2026-11-28, was GAP. `npm start` (`server/launch.ts`) reads the model keys from a secret store through `MCP_CHAT_SECRET_GET`, strips every secret-named variable the shell had, and refuses to start without a getter: `test/launch.test.ts` ("... never an environment fallback", "... only the store's keys go in", "npm start without a getter refuses to start, exit 2 ..."). `npm run dev:server` still reads the shell, for a clone with no store, and says so at start. |
| V13.3.2 | 2 | Least-privilege access to secrets | **gate** | `test/mcp.test.ts` "passes the config's own env and none of the parent's secrets": no server inherits the model key. |
| V13.4.1 | 1 | No source-control metadata exposed | **gate** | Only `index.html` and files under the build's `assets/` are served; `test/http-guard.test.ts` "serves the built assets ... nothing outside the web dir" (traversal and encoded traversal 404). |
| V13.4.2 | 2 | Debug modes off in production | review | Debug surfaces are opt-in: traces off unless `MCP_CHAT_TRACE` is set (`server/trace.ts:20`), thinking off unless `MCP_CHAT_THINK=1`, the UI debug view a local toggle. A testbed, by design. |
| V13.4.3 | 2 | No directory listings | **gate** | `test/http-guard.test.ts` "serves the built assets ..." requests `/assets/` and expects 404. `/api/traces` lists trace ids on purpose when tracing is on. |
| V13.4.4 | 2 | HTTP TRACE not supported | review | Routes match method and path; `TRACE` reaches the JSON 404 (`server/index.ts:211`). Not tested. |
| V13.4.5 | 2 | Docs and monitoring endpoints not exposed unless intended | review | `/api/health`, `/api/tools`, `/api/traces` are the testbed's intended surface, behind the WEB-3 guard. |

### V14 Data Protection (9 items)

| Item | L | Requirement (short) | Tag | Evidence |
|---|---|---|---|---|
| V14.1.1 | 2 | Sensitive data identified and classified | review | fixed 2026-11-28, was GAP. §8 Data classes: key, conversation, tool calls, traces, security events, debug toggle, each with a level. Review it when a class is added. |
| V14.1.2 | 2 | Protection requirements documented per level | review | fixed 2026-11-28, was GAP. §8 Data classes, Requirements column (where, who receives it, caching, retention, logging). |
| V14.2.1 | 1 | No sensitive data in URLs or query strings | **gate** | The key goes in a header: `test/providers.test.ts` "RED LEG: the request carries the key, version, system and tools ..." (`x-api-key`), `test/openai.test.ts` "RED LEG: the request carries the key, model, tools ..." (`authorization`). The chat is a POST body. |
| V14.2.2 | 2 | Sensitive data not cached in server components | N/A: single-user local tool | No shared cache or proxy; nothing is cached server-side. |
| V14.2.3 | 2 | Sensitive data not sent to trackers or third parties | **gate** | Page CSP `connect-src 'self'` asserted in `test/http-guard.test.ts`; no analytics. The conversation goes to the provider the operator configured, which is the app's purpose. |
| V14.2.4 | 2 | Protection controls implemented as documented | review | fixed 2026-11-28, was GAP. §8 Data classes, Checked by column: each requirement names its test; trace retention (until deleted) and the grep over log writes are review-only. |
| V14.3.1 | 1 | Authenticated data cleared from the client at session end | N/A: no authentication or sessions | The transcript is React state and is gone on reload. |
| V14.3.2 | 2 | Cache-Control: no-store on sensitive responses | **gate** | fixed 2026-11-28, was GAP. `no-store` on every API response and the chat stream: `test/http-guard.test.ts` "RED LEG: no-store on JSON, refusals, 404, the trace routes and the chat stream". Built assets stay `no-cache`. |
| V14.3.3 | 2 | No sensitive data in browser storage | review | localStorage holds one key, the debug toggle (`web/src/App.tsx:15`). |

### V16 Security Logging and Error Handling (16 items)

| Item | L | Requirement (short) | Tag | Evidence |
|---|---|---|---|---|
| V16.1.1 | 2 | Logging inventory documented | review | fixed 2026-11-28, was GAP. §8 Log inventory: each destination with its writer, events, format, access and retention. |
| V16.2.1 | 2 | Log entries carry when, where, who, what | **gate** | Security lines carry `t`, `event`, `reason`, `status`, `method`, `path`, `origin`, `site`: `test/http-guard.test.ts` "RED LEG: a refused request writes one security line ...". Traces carry `startedAt` and per-frame `t`. The actor is always the local user. |
| V16.2.2 | 2 | Synchronized clocks; UTC or explicit offset | **gate** | One host clock; `t` is `toISOString()` (UTC), asserted in `test/log.test.ts` "RED LEG: one JSON line with a UTC time ..." and in `test/http-guard.test.ts` (ISO `Z` pattern). |
| V16.2.3 | 2 | Logs go only to documented destinations | review | fixed 2026-11-28, was GAP. §8 Log inventory names the only destinations, with the grep that shows nothing else writes; repeat it when a log line is added. |
| V16.2.4 | 2 | Logs readable by the log processor (common format) | **gate** | Security events are one JSON object per line (`test/log.test.ts` "RED LEG: one JSON line ..."); traces are JSONL, read by `/api/trace/:id`. |
| V16.2.5 | 2 | Sensitive data logged per its protection level | review | fixed 2026-11-28, was GAP. Traces are unredacted by design, recorded as the exception in §8 (trace row); security lines carry no message content, key or query string, and cut reasons at 500 characters (`test/log.test.ts`). |
| V16.3.1 | 2 | Authentication operations logged | N/A: no authentication | Single-user local tool. |
| V16.3.2 | 2 | Failed authorization attempts logged | **gate** | fixed 2026-11-28, was GAP. Every 403 from the request guard writes a `refused` line: `test/http-guard.test.ts` "RED LEG: a refused request writes one security line with the reason, path and the browser's headers" (mutation removing the log call: red). |
| V16.3.3 | 2 | Documented security events and bypass attempts logged | **gate** | fixed 2026-11-28, was GAP. Rejected bodies (400, 413, 415) and refused non-read-only calls are logged: `test/http-guard.test.ts` "RED LEG: a rejected chat body ...", `test/mcp.test.ts` "RED LEG: a refused call is logged as a security event ...". Model argument-validation failures go back to the model and into the trace, not the log (§8). |
| V16.3.4 | 2 | Unexpected errors and control failures logged | review | fixed 2026-11-28, was GAP. The catch-all writes an `error` line before answering 500 or the stream's error frame (`server/index.ts:213-224`). No test provokes an unexpected error. |
| V16.4.1 | 2 | Log data encoded against injection | **gate** | fixed 2026-11-28, was GAP. `test/log.test.ts` "RED LEG: a failed server's error text cannot forge a second line" and "RED LEG: a newline in a field stays inside the one line". |
| V16.4.2 | 2 | Logs protected from access and modification | N/A: single-user local tool | Trace files sit in the user's own checkout under OS permissions; over HTTP they are behind the WEB-3 guard. |
| V16.4.3 | 2 | Logs sent to a separate system | N/A: single-user local tool | No separate log system for a local single-user tool (named N/A in WEB-1). |
| V16.5.1 | 2 | Generic error message, no internals | review | Errors reach the local user as `err.message`, never a stack (`server/index.ts:213-224`); provider errors include the provider's own message by design (`test/providers.test.ts` "a non-2xx status throws with the status and the API's message"). |
| V16.5.2 | 2 | Secure operation when external resources fail | **gate** | `test/mcp.test.ts` "RED LEG: one server that cannot start does not take the others down ..."; `test/agent.test.ts` "RED LEG: a thrown tool becomes an isError result, not a crash", "a model that throws mid-turn ends with error + done(error)". |
| V16.5.3 | 2 | Fail securely; no fail-open | **gate** | `test/agent.test.ts` "enforces conditional, format and draft-07 schemas and fails closed for unsupported or remote schemas", "RED LEG: an unknown tool name is refused before any call"; `test/mcp.test.ts` "refuses a tool that does not ..."; `test/stream.test.ts` "rejects a truncated last frame rather than silently dropping it". |

### Counts

| Chapter | Items (CSV) | Tagged | gate | review | N/A | GAP |
|---|---|---|---|---|---|---|
| V1 | 27 | 27 | 6 | 7 | 14 | 0 |
| V3 | 19 | 19 | 11 | 1 | 7 | 0 |
| V13 | 13 | 13 | 5 | 5 | 3 | 0 |
| V14 | 9 | 9 | 3 | 4 | 2 | 0 |
| V16 | 16 | 16 | 8 | 5 | 3 | 0 |
| **all** | **84** | **84** | 33 | 22 | 29 | 0 |

### GAP list (0)

None open. The first tagging (2026-11-28, `4f8fa49`) found 13; all were fixed the same day, and each such cell says so.

## §8 Data and logging inventory

What this runtime holds and writes, for ASVS V14.1, V14.2.4, V16.1.1, V16.2.3 and V16.2.5 (§7). Written 2026-11-28 from the code; a change that adds a data class, a destination or a log line updates this section in the same commit.

### Data classes

| Class | Level | What | Where it lives | Requirements | Checked by |
|---|---|---|---|---|---|
| Model key | secret | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | a secret store, read by `npm start` (`server/launch.ts`); or the shell running `npm run dev:server`; runtime memory for the process's life | sent only to its own provider, in a header; never to the browser, an MCP server, a trace or a log line; a stale shell copy never reaches the runtime under `npm start` | `test/providers.test.ts`, `test/openai.test.ts` (header), `test/mcp.test.ts` "passes the config's own env and none of the parent's secrets", `test/launch.test.ts` |
| Conversation | private | the user's messages, the model's answers and thinking | the browser's React state (gone on reload); the request in runtime memory; the configured provider, which is the app's purpose; trace files when tracing is on | not cached (`no-store`); no third party beyond the configured provider (page CSP `connect-src 'self'`); kept on disk only by opt-in tracing | `test/http-guard.test.ts` (no-store, CSP) |
| Tool calls and results | private, may hold third-party records | arguments the model wrote, what the MCP server returned | as the conversation; arguments also go to the MCP server that runs the tool | as the conversation; only read-only tools run | `test/mcp.test.ts` "only read-only tools run" |
| Trace files | private, **unredacted by design** | every frame of a request: conversation, tool results, thinking, usage | `traces/` (gitignored) or the directory in `MCP_CHAT_TRACE`, under the user's own file permissions | off unless `MCP_CHAT_TRACE` is set; served only through the WEB-3 guard with `no-store`; kept until the user deletes them, never pruned. Redaction would defeat the testbed (seeing exactly what the model saw), so the exception is recorded here instead (ASVS V16.2.5) | `test/log.test.ts` "traces are opt-in", `test/http-guard.test.ts` (no-store, guard) |
| Security events | internal | refusals, rejected bodies, refused tool calls, unexpected errors (below) | stderr | no message content, no key, no query string; reasons cut at 500 characters | `test/log.test.ts`, `test/http-guard.test.ts` |
| Debug toggle | public | `"0"` or `"1"` | browser localStorage | none | — |

### Log inventory

The runtime writes to these destinations and no other: a grep for `console.`, `stderr.write`, `stdout.write`, `appendFile` and `writeFile` under `server/` finds only these (2026-11-28; repeat it when a log line is added).

| Destination | Written by | Events | Format | Access | Retention |
|---|---|---|---|---|---|
| stderr, status lines | `server/index.ts`, `server/launch.ts` | each MCP server up or failed (error text escaped), the model label, where the key came from, trace setting, listen address, fatal start errors | `[mcp-chat] …`, one line each | whoever reads the terminal or the file it is redirected to | the terminal's, or that file's |
| stderr, security events | `server/log.ts`, from `server/index.ts` and `server/mcp.ts` | `refused` (Host, Origin, Sec-Fetch-Site), `rejected` (400, 413, 415), `tool_refused` (not read-only), `error` (anything unexpected, before or after the stream started) | one JSON object per line: `t` (UTC), `log: "security"`, `event`, `reason`, `status`, `method`, `path` (no query), `origin`, `site`, `tool` | as above | as above |
| trace files | `server/trace.ts` | every frame of every `/api/chat` request, when `MCP_CHAT_TRACE` is set | JSONL: a `meta` line with `startedAt` (UTC), then one frame per line with `t` in ms from the start | the user's file permissions; `/api/traces`, `/api/trace/:id` behind the WEB-3 guard | until deleted |

Not logged: successful requests (the trace is their record), model argument-validation failures (they come back to the model as an `isError` result and appear in the trace), and anything from an MCP server's own stderr, which is drained and dropped (`server/mcp.ts`).
