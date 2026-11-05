#!/usr/bin/env -S node --import tsx
/**
 * Runtime smoke: start the real HTTP runtime against the fixture MCP server,
 * exercise HTTP boundaries and a real tool call through a deterministic
 * loopback provider, and stop the owned process. No model or key is needed.
 *
 *   npm run smoke
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, get } from "node:http";
import { once } from "node:events";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "test", "fixtures", "echo-server.ts");
const dir = mkdtempSync(join(tmpdir(), "mcp-chat-smoke-"));
const cfg = join(dir, "config.json");
writeFileSync(cfg, JSON.stringify({
  system: "Use the fixture data only.",
  servers: [
    { name: "fx", command: process.execPath, args: ["--import", "tsx", fixture] },
    { name: "bad", command: "definitely-not-a-command-on-this-machine" },
  ],
}));

const traceDir = join(dir, "traces");
let modelCalls = 0;
let sentSystem = false;
let upstreamCancelled = false;
const provider = createServer(async (req,res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const { messages } = JSON.parse(text);
  modelCalls++;
  sentSystem = messages[0]?.role === "system" && messages[0].content === "Use the fixture data only.";
  res.writeHead(200, {"Content-Type":"application/x-ndjson"});
  if (messages.at(-1).content === "Wait for Stop") {
    res.on("close", () => { upstreamCancelled = true; });
    res.write(JSON.stringify({message:{content:"Waiting"},done:false}) + "\n");
    return;
  }
  const message = messages.at(-1).role === "tool"
    ? {content: "The fixture returned ping."}
    : {tool_calls:[{function:{name:"fx__echo",arguments:{text:"ping"}}}]};
  res.end(JSON.stringify({message,done:true}) + "\n");
});
provider.listen(0,"127.0.0.1"); await once(provider,"listening");
const address = provider.address();
if (!address || typeof address === "string") throw Error("Missing fixture port");
const env = { ...process.env, MCP_CHAT_CONFIG: cfg, MCP_CHAT_PORT: "0", MCP_CHAT_TRACE: traceDir,
  OLLAMA_BASE_URL:`http://127.0.0.1:${address.port}` };
delete env.ANTHROPIC_API_KEY; delete env.OPENAI_BASE_URL; // provider choice is not under test; keep it Ollama so no key is ever read
const runtime = spawn(process.execPath, ["--import", "tsx", join(here, "server", "index.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
const exited = once(runtime,"exit");
let stderr = "";
runtime.stderr.on("data", (d) => { stderr += d; });

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  let health: any = null;
  let base = "";
  for (let i = 0; i < 150 && !health; i++) {
    base = stderr.match(/\[mcp-chat\] (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? "";
    if (!base) { await sleep(200); continue; }
    try { health = await (await fetch(`${base}/api/health`)).json(); } catch { await sleep(200); }
  }
  check("runtime answers /api/health", !!health, health ? "" : stderr.slice(-300));
  if (health) {
    const fx = health.servers.find((s: any) => s.name === "fx");
    const bad = health.servers.find((s: any) => s.name === "bad");
    check("fixture server up with 2 tools", fx?.state === "up" && fx?.tools === 2, JSON.stringify(fx));
    check("bad server reported failed with a reason, runtime still up", bad?.state === "failed" && typeof bad?.error === "string", JSON.stringify(bad));
    check("model label names a provider", /^(ollama|anthropic):/.test(health.model), health.model);
  }
  const tools: any = await (await fetch(`${base}/api/tools`)).json();
  const names = (tools.tools ?? []).map((t: any) => t.name).sort();
  check("/api/tools lists qualified names", JSON.stringify(names) === JSON.stringify(["fx__echo", "fx__fail"]), JSON.stringify(names));

  const post = (body: unknown) => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  check("empty body → 400", (await post({})).status === 400);
  check("tool role from the client → 400", (await post({ messages: [{ role: "tool", content: "x" }, { role: "user", content: "y" }] })).status === 400);
  check("transcript ending on assistant → 400", (await post({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] })).status === 400);
  const r404 = await fetch(`${base}/api/nope`);
  check("unknown route → 404", r404.status === 404);
  const chatBody = JSON.stringify({messages:[{role:"user", content:"Echo ping"}]});
  const send = (headers:Record<string,string>,body=chatBody) => fetch(base+"/api/chat",{method:"POST",headers,body});
  check("foreign origin rejected before model work", (await send({"origin":"https://external.invalid","content-type":"text/plain"})).status === 403);
  check("text form cannot start a job", (await send({"content-type":"text/plain"})).status === 415);
  // fetch may replace a caller-supplied Host header before it reaches the wire.
  const rebound = await new Promise<number|undefined>((resolve,reject) => {
    get(base+"/api/tools", {headers:{host:"external.invalid"}}, res=>{res.resume();resolve(res.statusCode);}).on("error",reject);
  });
  check("DNS rebinding host rejected", rebound === 403);
  check("invalid JSON is a client error", (await send({"content-type":"application/json"},"{")).status === 400);
  check("oversized input rejected", (await send({"content-type":"application/json"},"x".repeat(8*1024*1024+1))).status === 413);

  // Traces: health reports them on; a rejected request writes none; the list
  // and the by-id route answer; an id that is not a trace is 404, and one with
  // a path in it is 404 too (never a file outside the trace dir).
  check("health reports traces enabled", health?.traces === true);
  const listed: any = await (await fetch(`${base}/api/traces`)).json();
  check("no trace written for 400s", listed.enabled === true && Array.isArray(listed.traces) && listed.traces.length === 0, JSON.stringify(listed).slice(0, 120));
  check("unknown trace id → 404", (await fetch(`${base}/api/trace/nope`)).status === 404);
  check("path-shaped trace id → 404", (await fetch(`${base}/api/trace/..%2Fconfig.json`)).status === 404);
  check("refused requests did not reach the model", modelCalls === 0);
  const response = await send({origin:base,"content-type":"application/json"});
  const wire = await response.text();
  check("same-origin full turn uses system prompt and real stdio tool", sentSystem && modelCalls === 2 && response.ok &&
    wire.includes('event: tool_result') && wire.includes('echoed') && wire.includes('"stoppedBy":"answer"'));
  const cancel = new AbortController();
  const slow = await fetch(base+"/api/chat",{method:"POST",headers:{"content-type":"application/json"},
    signal:cancel.signal, body:JSON.stringify({messages:[{role:"user",content:"Wait for Stop"}]})});
  const reader = slow.body!.getReader();
  await reader.read();
  cancel.abort();
  for (let i=0; i<50 && !upstreamCancelled; i++) await sleep(40);
  check("client disconnect aborts the upstream model stream", upstreamCancelled);
} finally {
  runtime.kill();
  await exited;
  provider.closeAllConnections();
  await new Promise<void>(resolve=>provider.close(()=>resolve()));
  check("owned runtime exited", runtime.exitCode !== null || runtime.signalCode !== null);
}
console.log(failed ? `\n${failed} FAILED` : "\nall smoke checks passed");
process.exit(failed ? 1 : 0);
