// App standard WEB-1, ASVS V16: the runtime's own log lines. Security events are one JSON object per line on
// stderr (V16.2.4), with a UTC time (V16.2.2); text from a server or a request can never start a new line (V16.4.1).
import { describe, expect, it } from "vitest";
import { securityLine, logSecurity, statusLine } from "../server/log";
import { TraceStore } from "../server/trace";

describe("security event lines", () => {
  it("RED LEG: one JSON line with a UTC time, the event and its fields", () => {
    const line = securityLine({ event: "refused", status: 403, method: "GET", path: "/api/tools", reason: "Same-origin access required.", origin: "https://evil.example" },
      new Date("2026-11-28T09:00:00Z"));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ t: "2026-11-28T09:00:00.000Z", log: "security", event: "refused", status: 403, method: "GET",
      path: "/api/tools", reason: "Same-origin access required.", origin: "https://evil.example" });
  });

  it("RED LEG: a newline in a field stays inside the one line", () => {
    const lines: string[] = [];
    logSecurity({ event: "error", reason: "boom\n{\"forged\":true}" }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0]!).reason).toBe("boom\n{\"forged\":true}");
  });

  it("a reason quoting a client's value is cut at 500 characters", () => {
    expect(JSON.parse(securityLine({ event: "rejected", reason: "x".repeat(10_000) })).reason).toHaveLength(500);
  });
});

describe("server status lines", () => {
  it("RED LEG: a failed server's error text cannot forge a second line", () => {
    const line = statusLine({ name: "bad", state: "failed", tools: 0, error: "spawn failed\n[mcp-chat] http://127.0.0.1:1" });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("spawn failed\\n[mcp-chat]");
  });

  it("an up server reads as before", () => {
    expect(statusLine({ name: "fx", state: "up", tools: 3 })).toBe("[mcp-chat] fx: up (3 tools)");
  });
});

describe("traces are opt-in", () => {
  it("no setting, 0 and false write nothing", () => {
    for (const s of [undefined, "", "0", "false", "FALSE"]) expect(new TraceStore(s).enabled, String(s)).toBe(false);
  });
});
