// App standard WEB-2 (headers on what the runtime serves) and WEB-3 (request guard), checked over real
// HTTP against server/index.ts started with no MCP servers. The runtime serves the API only; the page is
// the Vite dev server's, so WEB-2's page items (nonce CSP, Trusted Types) are not checked here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
let runtime: ChildProcess;
let port = 0;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-chat-guard-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ servers: [] }));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), MCP_CHAT_CONFIG: cfg, MCP_CHAT_PORT: "0", OLLAMA_BASE_URL: "http://127.0.0.1:9" };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_BASE_URL; delete env.MCP_CHAT_TRACE;
  runtime = spawn(process.execPath, ["--import", "tsx", join(here, "server", "index.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  runtime.stderr!.on("data", (d) => { stderr += d; });
  for (let i = 0; i < 150 && !port; i++) {
    port = Number(stderr.match(/\[mcp-chat\] http:\/\/127\.0\.0\.1:(\d+)/)?.[1] ?? 0);
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error(`runtime did not start: ${stderr}`);
}, 30_000);

afterAll(async () => {
  runtime?.kill();
  if (runtime && runtime.exitCode === null) await once(runtime, "exit");
  rmSync(dir, { recursive: true, force: true });
});

/** A raw request, so Host and the Sec-Fetch headers are exactly what a forged request would send. */
function raw(path: string, headers: Record<string, string>): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => { res.resume(); res.on("end", () => resolve(res)); });
    req.on("error", reject);
    req.end();
  });
}

describe("WEB-3: forged requests are refused over HTTP", () => {
  it("RED LEG: a same-site request (another localhost port) is refused, not only cross-site", async () => {
    const host = `127.0.0.1:${port}`;
    expect((await raw("/api/tools", { host: `rebind.example:${port}` })).statusCode, "rebinding Host").toBe(403);
    expect((await raw("/api/tools", { host, origin: "https://evil.example" })).statusCode, "foreign Origin").toBe(403);
    expect((await raw("/api/tools", { host, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" })).statusCode, "cross-site").toBe(403);
    expect((await raw("/api/tools", { host, "sec-fetch-site": "same-site" })).statusCode, "same-site").toBe(403);
    expect((await raw("/api/health", { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" })).statusCode, "the app").toBe(200);
    expect((await raw("/api/health", { host })).statusCode, "a non-browser client").toBe(200);
  });
});

describe("WEB-2: every response the runtime sends carries the headers", () => {
  it("RED LEG: nosniff, frame denial, a deny-all CSP, a referrer policy, COOP and Vary on JSON and on refusals", async () => {
    const host = `127.0.0.1:${port}`;
    for (const res of [await raw("/api/health", { host }), await raw("/api/tools", { host, origin: "https://evil.example" }), await raw("/nope", { host })]) {
      const h = res.headers;
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["x-frame-options"]).toBe("DENY");
      const csp = String(h["content-security-policy"] ?? "");
      for (const part of ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) expect(csp, csp).toContain(part);
      expect(["no-referrer", "strict-origin-when-cross-origin"]).toContain(h["referrer-policy"]);
      expect(h["cross-origin-opener-policy"]).toBe("same-origin");
      const vary = String(h["vary"] ?? "").toLowerCase();
      expect(vary.includes("sec-fetch-site") && vary.includes("origin"), `Vary: ${vary}`).toBe(true);
    }
  });
});
