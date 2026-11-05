/**
 * McpManager against a REAL stdio server (test/fixtures/echo-server.ts), the
 * channel it runs on in production. A mock here would test the mock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { McpManager, qualify, split } from "../server/mcp";

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
      fixture("fx"),
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
