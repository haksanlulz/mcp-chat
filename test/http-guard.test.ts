// App standard WEB-2 (headers on what the runtime serves) and WEB-3 (request guard), checked over real
// HTTP against server/index.ts started with no MCP servers. The runtime serves the API and the BUILT page
// (MCP_CHAT_WEB_DIR, here a fixture): the page gets a per-response nonce CSP with strict-dynamic and
// Trusted Types with no policy allowed. The Vite dev server's page is not covered (HMR needs inline script).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
let runtime: ChildProcess;
let port = 0;
let dir = "";
let stderr = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-chat-guard-"));
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, JSON.stringify({ servers: [] }));
  // a built page in Vite's shape (entry module, modulepreload, stylesheet), and a file beside the web dir
  // that no URL may reach
  mkdirSync(join(dir, "web", "assets"), { recursive: true });
  writeFileSync(join(dir, "web", "index.html"), '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-abc.js"></script>' +
    '<link rel="modulepreload" crossorigin href="/assets/chunk-def.js"><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head>' +
    '<body><div id="root"></div><script type="module">/* second */</script></body></html>');
  writeFileSync(join(dir, "web", "assets", "index-abc.js"), "console.log('app');");
  writeFileSync(join(dir, "web", "assets", "index-abc.css"), "body{margin:0}");
  writeFileSync(join(dir, "outside.js"), "not served");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), MCP_CHAT_CONFIG: cfg, MCP_CHAT_PORT: "0",
    OLLAMA_BASE_URL: "http://127.0.0.1:9", MCP_CHAT_WEB_DIR: join(dir, "web") };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_BASE_URL; delete env.MCP_CHAT_TRACE;
  runtime = spawn(process.execPath, ["--import", "tsx", join(here, "server", "index.ts")], { env, stdio: ["ignore", "ignore", "pipe"] });
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
function raw(path: string, headers: Record<string, string>, method = "GET"): Promise<http.IncomingMessage & { body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve(Object.assign(res, { body })));
    });
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

describe("WEB-1 (ASVS V3.5.4): the runtime has a hostname of its own", () => {
  it("RED LEG: mcp-chat.localhost is served as the app, and a same-site page is still refused", async () => {
    const host = `mcp-chat.localhost:${port}`;
    expect((await raw("/api/health", { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" })).statusCode, "own name").toBe(200);
    expect((await raw("/api/health", { host, origin: `http://127.0.0.1:${port}` })).statusCode, "origin of another name").toBe(403);
    expect((await raw("/api/health", { host: `other.localhost:${port}` })).statusCode, "another .localhost name").toBe(403);
    expect(stderr).toContain(`http://mcp-chat.localhost:${port}/`);
  });
});

/** The security event lines written to stderr so far (server/log.ts). */
const events = () => stderr.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("WEB-1 (ASVS V16.3): refusals and rejected requests are logged", () => {
  it("RED LEG: a refused request writes one security line with the reason, path and the browser's headers", async () => {
    await raw("/api/tools?probe=refusal", { host: `127.0.0.1:${port}`, origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    await new Promise((r) => setTimeout(r, 200));
    const e = events().find((x) => x.event === "refused" && x.origin === "https://evil.example" && x.site === "cross-site");
    expect(e, stderr).toMatchObject({ log: "security", status: 403, method: "GET", path: "/api/tools", reason: "Same-origin access required.", site: "cross-site" });
    expect(String(e!.t)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("RED LEG: a rejected chat body (wrong type, bad shape) writes a rejected line", async () => {
    const host = `127.0.0.1:${port}`;
    expect((await raw("/api/chat", { host, "content-type": "text/plain" }, "POST")).statusCode).toBe(415);
    const shape = await post("/api/chat", host, { messages: [] });
    expect(shape.statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 200));
    const rejected = events().filter((x) => x.event === "rejected" && x.path === "/api/chat").map((x) => x.status);
    expect(rejected).toEqual(expect.arrayContaining([415, 400]));
  });
});

describe("WEB-1 (ASVS V14.3.2): nothing the API returns is cached", () => {
  it("RED LEG: no-store on JSON, refusals, 404, the trace routes and the chat stream", async () => {
    const host = `127.0.0.1:${port}`;
    for (const path of ["/api/health", "/api/tools", "/api/traces", "/api/trace/nope", "/nope"]) {
      expect((await raw(path, { host })).headers["cache-control"], path).toBe("no-store");
    }
    expect((await raw("/api/tools", { host: "rebind.example" })).headers["cache-control"], "refusal").toBe("no-store");
    const stream = await post("/api/chat", host, { messages: [{ role: "user", content: "hi" }] });
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");
    expect(stream.headers["cache-control"], "stream").toBe("no-store");
  });
});

function post(path: string, host: string, body: unknown): Promise<http.IncomingMessage & { body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; });
      res.on("end", () => resolve(Object.assign(res, { body: text })));
    });
    req.on("error", reject);
    req.end(data);
  });
}

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

describe("WEB-2: the built page gets a nonce CSP and Trusted Types", () => {
  const nonceOf = (csp: string) => csp.match(/'nonce-([A-Za-z0-9+/=]{16,})'/)?.[1];
  it("RED LEG: a fresh nonce per response, on every script tag, strict-dynamic, no policy may be created", async () => {
    const host = `127.0.0.1:${port}`;
    const a = await raw("/", { host, "sec-fetch-site": "none" }), b = await raw("/index.html", { host });
    expect(a.statusCode).toBe(200);
    expect(String(a.headers["content-type"])).toContain("text/html");
    const csp = String(a.headers["content-security-policy"] ?? "");
    const nonce = nonceOf(csp);
    expect(nonce, csp).toBeTruthy();
    expect(nonceOf(String(b.headers["content-security-policy"] ?? "")), "the nonce repeats").not.toBe(nonce);
    for (const part of ["'strict-dynamic'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'",
      "require-trusted-types-for 'script'", "trusted-types 'none'"]) expect(csp, csp).toContain(part);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    const tags = a.body.match(/<script[^>]*>/g) ?? [];
    expect(tags.length).toBe(2);
    for (const tag of tags) expect(tag, tag).toContain(`nonce="${nonce}"`);
    expect(a.headers["x-frame-options"]).toBe("DENY");
    expect(a.headers["cache-control"]).toBe("no-store");
  });
  it("serves the built assets with their types, and nothing outside the web dir", async () => {
    const host = `127.0.0.1:${port}`;
    const js = await raw("/assets/index-abc.js", { host }), css = await raw("/assets/index-abc.css", { host });
    expect([js.statusCode, js.headers["content-type"], js.body]).toEqual([200, "text/javascript; charset=utf-8", "console.log('app');"]);
    expect([css.statusCode, css.headers["content-type"]]).toEqual([200, "text/css; charset=utf-8"]);
    expect(js.headers["x-content-type-options"]).toBe("nosniff");
    for (const path of ["/assets/../../outside.js", "/assets/..%2f..%2foutside.js", "/assets/%2e%2e/%2e%2e/outside.js", "/outside.js",
      "/assets/missing.js", "/assets/", "/assets/%E0%A4%A"]) {
      const r = await raw(path, { host });
      expect(r.statusCode, path).toBe(404);
      expect(r.body, path).not.toContain("not served");
    }
    expect((await raw("/", { host }, "POST")).statusCode, "POST /").toBe(404);
  });
});
