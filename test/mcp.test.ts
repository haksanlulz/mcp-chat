/**
 * McpManager against a REAL stdio server (test/fixtures/echo-server.ts), the
 * channel it runs on in production. A mock here would test the mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { McpManager, qualify, split } from "../server/mcp";
import type { SecurityEvent } from "../server/log";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.ts", import.meta.url));
// node --import tsx <file>: no npx wrapper, so stop() reaps the actual server.
const fixture = (name: string) => ({ name, command: process.execPath, args: ["--import", "tsx", FIXTURE] });

describe("qualified names", () => {
  it("round-trip and reject a bare name", () => {
    expect(qualify("housing", "search")).toBe("housing__search");
    expect(split("housing__search")).toEqual({ server: "housing", tool: "search" });
    expect(split("cards__card_named")).toEqual({ server: "cards", tool: "card_named" });
    expect(split("nounderscore")).toBeNull();
    expect(split("__leading")).toBeNull();
  });
});

describe("McpManager over stdio", () => {
  const mgr = new McpManager();
  let status: Awaited<ReturnType<McpManager["start"]>>;

  beforeAll(async () => {
    status = await mgr.start([
      { ...fixture("fx"), readOnly: true },
      { name: "bad", command: "definitely-not-a-command-on-this-machine" },
      { name: "bad name!", command: process.execPath },
    ], { timeoutMs: 30_000 });
  }, 60_000);
  afterAll(async () => { await mgr.stop(); });

  it("rejects ambiguous routes before spawning and discovers tools on later pages", async () => {
    const isolated = new McpManager();
    try {
      const statuses = await isolated.start([fixture("a__b"),fixture("trailing_"),fixture("repeat"), fixture("repeat"),
        {...fixture("pages"),env:{MCP_FIXTURE_PAGES:"1"}}]);
      expect(statuses.filter(s=>s.state==="failed").map(s=>s.name).sort()).toEqual(["a__b","repeat","trailing_"]);
      expect(isolated.tools().map(t=>t.name).sort()).toEqual(["pages__echo","pages__fail"]);
    } finally { await isolated.stop(); }
  });

  it("RED LEG: one server that cannot start does not take the others down; it is reported failed with a reason", () => {
    expect(status.find((s) => s.name === "fx")).toEqual({ name: "fx", state: "up", tools: 2 });
    const bad = status.find((s) => s.name === "bad")!;
    expect(bad.state).toBe("failed");
    expect(bad.error).toMatch(/./);
    expect(status.find((s) => s.name === "bad name!")).toMatchObject({ state: "failed", error: expect.stringContaining("must be [a-z0-9_-]") });
  });

  it("lists tools qualified with the server handle, schemas intact", () => {
    const names = mgr.tools().map((t) => t.name).sort();
    expect(names).toEqual(["fx__echo", "fx__fail"]);
    expect(mgr.tools().find((t) => t.name === "fx__echo")!.inputSchema).toMatchObject({ required: ["text"] });
  });

  it("routes a call to the right server and returns its text", async () => {
    const r = await mgr.call({ id: "1", name: "fx__echo", args: { text: "ping" } });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({ echoed: "ping", record_scope: "a fixture, not data" });
  });

  it("RED LEG: a server's isError comes back as isError, never as a plain result", async () => {
    const r = await mgr.call({ id: "2", name: "fx__fail", args: {} });
    expect(r).toEqual({ content: "fixture upstream 503", isError: true });
  });

  it("a call to a server that is not up is an isError result, not a throw", async () => {
    await expect(mgr.call({ id: "3", name: "bad__anything", args: {} })).resolves.toMatchObject({ isError: true, content: expect.stringContaining("no running server") });
    await expect(mgr.call({ id: "4", name: "unqualified", args: {} })).resolves.toMatchObject({ isError: true });
  });
});

// MCP security audit 2026-11-25: every tool the model asked for was run, with nothing between a talked-round
// model and a tool that changes things. A call now runs only when the tool says it is read-only, or the
// person who wrote the config vouched for the whole server with "readOnly": true. Anything else is refused.
describe("only read-only tools run", () => {
  const logged: SecurityEvent[] = [];
  const unvouched = new McpManager({ log: (e) => logged.push(e) }), vouched = new McpManager();
  beforeAll(async () => {
    await Promise.all([unvouched.start([fixture("rw")], { timeoutMs: 30_000 }), vouched.start([{ ...fixture("ok"), readOnly: true }], { timeoutMs: 30_000 })]);
  }, 60_000);
  afterAll(async () => { await Promise.all([unvouched.stop(), vouched.stop()]); });

  it("runs a tool that declares itself read-only, with no config flag", async () => {
    const r = await unvouched.call({ id: "r1", name: "rw__echo", args: { text: "hi" } });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content).echoed).toBe("hi");
  });

  it("refuses a tool that does not, and never reaches the server", async () => {
    const r = await unvouched.call({ id: "r2", name: "rw__fail", args: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not run/);
    expect(r.content).toMatch(/readOnly/);
    expect(r.content).not.toContain("fixture upstream 503");
  });

  it("RED LEG: a refused call is logged as a security event (ASVS V16.3.3); a run call is not", () => {
    expect(logged).toEqual([{ event: "tool_refused", tool: "rw__fail", reason: "the tool does not declare itself read-only and the config does not vouch for its server" }]);
  });

  it("runs it when the config vouches for the server", async () => {
    const r = await vouched.call({ id: "r3", name: "ok__fail", args: {} });
    expect(r.content).toBe("fixture upstream 503");
  });
});

// Secrets migration (workspace tools/secrets/PLAN.md): mcp-chat may be started with a model key in its own
// environment (secret.py run). That is safe only because a server it starts never inherits that environment:
// a server gets the platform basics plus the env its config entry gives it, nothing else.
describe("a server never inherits mcp-chat's secrets", () => {
  const mgr = new McpManager();
  const planted = "MCP_CHAT_PLANTED_API_KEY";
  beforeAll(async () => {
    process.env[planted] = "must-not-reach-the-server";
    await mgr.start([{ ...fixture("envcheck"), env: { MCP_FIXTURE_ENV_TOOL: "1", OWN_TOKEN: "this-servers-own" } }], { timeoutMs: 30_000 });
  }, 60_000);
  afterAll(async () => { delete process.env[planted]; await mgr.stop(); });

  it("passes the config's own env and none of the parent's secrets", async () => {
    const r = await mgr.call({ id: "e1", name: "envcheck__env_names", args: {} });
    expect(r.isError).toBe(false);
    const names: string[] = JSON.parse(r.content);
    expect(names).toContain("OWN_TOKEN");
    expect(names).not.toContain(planted);
    expect(names.filter((n) => /ANTHROPIC|OPENAI|_API_KEY$/.test(n) && n !== "OWN_TOKEN")).toEqual([]);
  });
});
