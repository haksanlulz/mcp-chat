#!/usr/bin/env -S node --import tsx
/**
 * Runtime smoke: start the real HTTP runtime against the fixture MCP server,
 * hit the three routes, and stop it BY PID. Offline — no model is called
 * (a malformed /api/chat must 400 before any provider is touched), so this
 * runs in CI. Exit 0 only if every check passes.
 *
 *   npm run smoke
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "test", "fixtures", "echo-server.ts");
const port = 8800 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), "mcp-chat-smoke-"));
const cfg = join(dir, "config.json");
writeFileSync(cfg, JSON.stringify({
  servers: [
    { name: "fx", command: process.execPath, args: ["--import", "tsx", fixture] },
    { name: "bad", command: "definitely-not-a-command-on-this-machine" },
  ],
}));

const traceDir = join(dir, "traces");
const env = { ...process.env, MCP_CHAT_CONFIG: cfg, MCP_CHAT_PORT: String(port), MCP_CHAT_TRACE: traceDir };
delete env.ANTHROPIC_API_KEY; delete env.OPENAI_BASE_URL; // provider choice is not under test; keep it Ollama so no key is ever read
const runtime = spawn(process.execPath, ["--import", "tsx", join(here, "server", "index.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
let stderr = "";
runtime.stderr.on("data", (d) => { stderr += d; });

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  let health: any = null;
  for (let i = 0; i < 150 && !health; i++) {
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

  // Traces: health reports them on; a rejected request writes none; the list
  // and the by-id route answer; an id that is not a trace is 404, and one with
  // a path in it is 404 too (never a file outside the trace dir).
  check("health reports traces enabled", health?.traces === true);
  const listed: any = await (await fetch(`${base}/api/traces`)).json();
  check("no trace written for 400s", listed.enabled === true && Array.isArray(listed.traces) && listed.traces.length === 0, JSON.stringify(listed).slice(0, 120));
  check("unknown trace id → 404", (await fetch(`${base}/api/trace/nope`)).status === 404);
  check("path-shaped trace id → 404", (await fetch(`${base}/api/trace/..%2Fconfig.json`)).status === 404);
} finally {
  runtime.kill();
  await sleep(300);
  check("runtime stopped", runtime.exitCode !== null || runtime.killed);
}
console.log(failed ? `\n${failed} FAILED` : "\nall smoke checks passed");
process.exit(failed ? 1 : 0);
