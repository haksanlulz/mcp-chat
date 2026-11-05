import { describe, expect, it } from "vitest";
import { runAgent, validateArgs, type AgentEvent, type Message, type Model, type ModelEvent, type ToolSpec } from "../server/agent";

const LOOKUP: ToolSpec = {
  name: "civic__building_violations",
  description: "HPD violations for one address",
  inputSchema: {
    type: "object",
    properties: { house_number: { type: "string" }, street: { type: "string" }, limit: { type: "integer" } },
    required: ["house_number", "street"],
    additionalProperties: false,
  },
};

/** A scripted model: each turn yields the next script entry. */
function scripted(turns: ModelEvent[][]): Model & { turnsTaken: number; lastMessages: Message[] } {
  const m = {
    turnsTaken: 0,
    lastMessages: [] as Message[],
    async *turn(messages: Message[]): AsyncIterable<ModelEvent> {
      m.lastMessages = messages;
      const script = turns[m.turnsTaken++] ?? [{ type: "end" as const }];
      for (const ev of script) yield ev;
    },
  };
  return m;
}

function collect() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
}

describe("validateArgs runs before any call", () => {
  it("names a missing required argument", () => {
    expect(validateArgs(LOOKUP, { street: "Sedgwick Avenue" })).toMatch(/missing required argument "house_number"/);
  });
  it("rejects an unknown key with a near-miss", () => {
    expect(validateArgs(LOOKUP, { house_number: "1", street: "X", limt: 5 })).toMatch(/"limt" \(did you mean "limit"\?\)/);
  });
  it("rejects a wrong type", () => {
    expect(validateArgs(LOOKUP, { house_number: 1520, street: "X" })).toMatch(/"house_number" must be string, got integer/);
  });
  it("passes a well-formed call", () => {
    expect(validateArgs(LOOKUP, { house_number: "1520", street: "Sedgwick Avenue", limit: 3 })).toBeNull();
  });
});

describe("JSON Schema argument boundary", () => {
  const tool: ToolSpec = {
    name: "fx__schema", description: "schema probe",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        borough: { type: "string", enum: ["BRONX"] },
        limit: { type: "integer", minimum: 1, maximum: 3 },
        nested: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
        values: { type: "array", items: { type: "integer" }, minItems: 1 },
      }, required: ["borough"],
    },
  };
  const badArgs = [null, [], 17, "text", { borough: "BROOKLYN" }, { borough: "BRONX", limit: -9 },
    { borough: "BRONX", nested: { typo: "x" } }, { borough: "BRONX", values: ["wrong"] }];
  it.each(badArgs)("refuses malformed or schema-invalid arguments before invocation: %j", async (args) => {
    const model = scripted([[{ type: "tool_call", call: { id: "invalid", name: tool.name, args: args as Record<string, unknown> } }, { type: "end" }], [{ type: "end" }]]);
    let invoked = 0;
    const frames = await runAgent({ model, tools: [tool], messages: [{ role: "user", content: "probe" }], emit() {}, callTool: async () => { invoked++; return { content: "wrong", isError: false }; } });
    expect(invoked).toBe(0);
    expect(frames.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    expect(frames.at(-1)).toMatchObject({ type: "done" });
    expect(frames.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("supports local refs, unions, pattern properties, schema-valued extras and composition without flattening them", () => {
    const spec: ToolSpec = { name: "fx__rich", description: "", inputSchema: {
      type: "object", $defs: { value: { type: ["string", "null"], pattern: "^ok" } },
      properties: { primary: { $ref: "#/$defs/value" } }, patternProperties: { "^extra_": { type: "integer" } },
      additionalProperties: { type: "boolean" }, anyOf: [{ required: ["primary"] }, { required: ["extra_one"] }],
    } };
    expect(validateArgs(spec, { primary: "okay", extra_one: 1, enabled: true })).toBeNull();
    expect(validateArgs(spec, { primary: null })).toBeNull();
    expect(validateArgs(spec, { primary: "bad" })).not.toBeNull();
    expect(validateArgs(spec, { primary: "okay", extra_one: "wrong" })).not.toBeNull();
    expect(validateArgs(spec, { primary: "okay", enabled: 1 })).not.toBeNull();
  });

  it("enforces conditional, format and draft-07 schemas and fails closed for unsupported or remote schemas", () => {
    const spec: ToolSpec = { name: "fx__conditional", description: "", inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false,
      properties: { mode: { enum: ["email", "none"] }, address: { type: "string", format: "email" } },
      if: { properties: { mode: { const: "email" } }, required: ["mode"] }, then: { required: ["address"] },
    } };
    expect(validateArgs(spec, { mode: "none" })).toBeNull();
    expect(validateArgs(spec, { mode: "email" })).not.toBeNull();
    expect(validateArgs(spec, { mode: "email", address: "bad" })).not.toBeNull();
    expect(validateArgs(spec, { mode: "email", address: "a@example.com" })).toBeNull();
    for (const schema of [{ $ref: "https://example.com/schema" }, { type: "object", unknownValidationKeyword: true }, { type: "object", $async: true }]) {
      expect(validateArgs({ ...spec, inputSchema: schema }, {})).toMatch(/cannot validate inputSchema/);
    }
  });

  it("does not reuse a different tool's schema with the same $id", () => {
    const a = { ...tool, inputSchema: { $id: "urn:probe:duplicate", type: "object", properties: { value: { const: 1 } }, required: ["value"] } };
    const b = { ...tool, inputSchema: { $id: "urn:probe:duplicate", type: "object", properties: { value: { const: 2 } }, required: ["value"] } };
    expect(validateArgs(a, { value: 1 })).toBeNull();
    expect(validateArgs(b, { value: 1 })).not.toBeNull();
    expect(validateArgs(b, { value: 2 })).toBeNull();
  });

  it("rejects a provider argument parse error even for an open-ended tool", async () => {
    const model = scripted([[{ type: "tool_call", call: { id: "raw", name: tool.name, args: { _raw: "{bad" }, argumentError: "invalid JSON" } }, { type: "end" }], [{ type: "end" }]]);
    let invoked = 0;
    const frames = await runAgent({ model, tools: [{ ...tool, inputSchema: { type: "object", additionalProperties: true } }], messages: [{ role: "user", content: "x" }], emit() {}, callTool: async () => { invoked++; return { content: "wrong", isError: false }; } });
    expect(invoked).toBe(0);
    expect(frames.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, content: "invalid JSON" });
  });
});

describe("cooperative cancellation", () => {
  it("does not start a model when already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    const model = scripted([[{ type: "token", text: "wrong" }, { type: "end" }]]);
    const frames = await runAgent({ model, signal: controller.signal, tools: [], messages: [], emit() {}, callTool: async () => ({ content: "", isError: false }) });
    expect(model.turnsTaken).toBe(0);
    expect(frames.at(-1)).toMatchObject({ type: "done", stoppedBy: "error" });
  });
  it("passes the signal and stops before tools, later calls and the next model turn", async () => {
    const controller = new AbortController(); let models = 0; let calls = 0;
    const model: Model = { async *turn(_m, _t, signal) {
      models++; expect(signal).toBe(controller.signal);
      yield { type: "tool_call", call: { id: "1", name: LOOKUP.name, args: { house_number: "1", street: "X" } } };
      yield { type: "tool_call", call: { id: "2", name: LOOKUP.name, args: { house_number: "2", street: "X" } } };
      yield { type: "end" };
    } };
    const frames = await runAgent({ model, signal: controller.signal, tools: [LOOKUP], messages: [], emit() {}, callTool: async (_call, signal) => {
      calls++; expect(signal).toBe(controller.signal); controller.abort(); return { content: "ran once", isError: false };
    } });
    expect(calls).toBe(1); expect(models).toBe(1);
    expect(frames.at(-1)).toMatchObject({ type: "done", stoppedBy: "error" });
    expect(frames.filter((e) => e.type === "done")).toHaveLength(1);
  });
  it("does not execute calls if cancellation happens as the model turn completes", async () => {
    const controller = new AbortController(); let calls = 0;
    const model: Model = { async *turn() {
      yield { type: "tool_call", call: { id: "1", name: LOOKUP.name, args: { house_number: "1", street: "X" } } };
      controller.abort();
    } };
    const frames = await runAgent({ model, signal: controller.signal, tools: [LOOKUP], messages: [], emit() {}, callTool: async () => { calls++; return { content: "wrong", isError: false }; } });
    expect(calls).toBe(0); expect(frames.at(-1)).toMatchObject({ type: "done", stoppedBy: "error" });
  });
});

describe("runAgent", () => {
  it("streams tokens, then done(answer), exactly one done, last", async () => {
    const model = scripted([[{ type: "token", text: "Hel" }, { type: "token", text: "lo" }, { type: "end" }]]);
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "hi" }], callTool: async () => ({ content: "", isError: false }), emit });
    expect(events.map((e) => e.type)).toEqual(["token", "token", "turn", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", iterations: 1, stoppedBy: "answer" });
  });

  it("executes a valid tool call and feeds the result back as a tool message", async () => {
    const call = { id: "c1", name: LOOKUP.name, args: { house_number: "1520", street: "Sedgwick Avenue" } };
    const model = scripted([
      [{ type: "tool_call", call }, { type: "end" }],
      [{ type: "token", text: "128 open." }, { type: "end" }],
    ]);
    const seen: unknown[] = [];
    const { events, emit } = collect();
    await runAgent({
      model, tools: [LOOKUP], messages: [{ role: "user", content: "violations?" }], emit,
      callTool: async (c) => { seen.push(c.args); return { content: '{"total":128}', isError: false }; },
    });
    expect(seen).toEqual([call.args]);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "turn", "tool_result", "token", "turn", "done"]);
    const toolMsg = model.lastMessages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ toolCallId: "c1", isError: false, content: '{"total":128}' });
  });

  it("RED LEG: a misspelled argument never reaches the tool; it comes back as an error the model can read", async () => {
    const bad = { id: "c2", name: LOOKUP.name, args: { house_number: "1520", street: "X", limt: 5 } };
    const model = scripted([
      [{ type: "tool_call", call: bad }, { type: "end" }],
      [{ type: "token", text: "Sorry, let me fix that." }, { type: "end" }],
    ]);
    let called = 0;
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "x" }], emit, callTool: async () => { called++; return { content: "", isError: false }; } });
    expect(called).toBe(0);
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toMatch(/did you mean "limit"/);
    expect(events.some((e) => e.type === "error" && "callId" in e && e.callId === "c2")).toBe(true);
    const toolMsg = model.lastMessages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ isError: true });
  });

  it("RED LEG: a tool that returns isError is surfaced as an error frame, never rendered as a plain answer", async () => {
    const call = { id: "c3", name: LOOKUP.name, args: { house_number: "1520", street: "X" } };
    const model = scripted([[{ type: "tool_call", call }, { type: "end" }], [{ type: "end" }]]);
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "x" }], emit, callTool: async () => ({ content: "HPD upstream 503", isError: true }) });
    expect(events.filter((e) => e.type === "error").map((e) => (e as { message: string }).message)).toEqual(["HPD upstream 503"]);
    expect(events.filter((e) => e.type === "token")).toHaveLength(0);
  });

  it("RED LEG: a thrown tool becomes an isError result, not a crash", async () => {
    const call = { id: "c4", name: LOOKUP.name, args: { house_number: "1", street: "X" } };
    const model = scripted([[{ type: "tool_call", call }, { type: "end" }], [{ type: "token", text: "ok" }, { type: "end" }]]);
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "x" }], emit, callTool: async () => { throw new Error("spawn failed"); } });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, content: expect.stringContaining("spawn failed") });
    expect(events.at(-1)).toMatchObject({ type: "done", stoppedBy: "answer" });
  });

  it("RED LEG: the iteration cap fires as an error + done(cap), never a silent truncation", async () => {
    const call = { id: "loop", name: LOOKUP.name, args: { house_number: "1", street: "X" } };
    const forever = scripted(Array.from({ length: 50 }, () => [{ type: "tool_call" as const, call }, { type: "end" as const }]));
    const { events, emit } = collect();
    await runAgent({ model: forever, tools: [LOOKUP], messages: [{ role: "user", content: "x" }], emit, maxIterations: 3, callTool: async () => ({ content: "{}", isError: false }) });
    expect(forever.turnsTaken).toBe(3);
    expect(events.at(-2)).toMatchObject({ type: "error", message: expect.stringContaining("stopped after 3") });
    expect(events.at(-1)).toEqual({ type: "done", iterations: 3, stoppedBy: "cap" });
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("RED LEG: an unknown tool name is refused before any call", async () => {
    const call = { id: "c5", name: "nope__tool", args: {} };
    const model = scripted([[{ type: "tool_call", call }, { type: "end" }], [{ type: "end" }]]);
    let called = 0;
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "x" }], emit, callTool: async () => { called++; return { content: "", isError: false }; } });
    expect(called).toBe(0);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, content: expect.stringContaining('unknown tool "nope__tool"') });
  });

  // Debug layer (2026-09-20, operator: "as a testing bed its not that great —
  // there's no log or ability to see the model thinking"). Two new frames:
  // `thinking` (the model's reasoning, when the provider exposes it) and
  // `turn` (one per model iteration: what the model was sent, how long it
  // took, what it cost, how it ended). Both are for the reader of a trace;
  // neither may leak into the answer.
  it("RED LEG: thinking is its own frame, never a token, and never enters the transcript the model is re-sent", async () => {
    const model = scripted([[{ type: "thinking", text: "the user wants violations; " }, { type: "thinking", text: "call the tool" }, { type: "token", text: "ok" }, { type: "end" }]]);
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "x" }], callTool: async () => ({ content: "", isError: false }), emit });
    expect(events.filter((e) => e.type === "thinking").map((e) => (e as { text: string }).text)).toEqual(["the user wants violations; ", "call the tool"]);
    expect(events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text)).toEqual(["ok"]);
    // the transcript the loop keeps (and would re-send) holds the answer only
    const assistant = model.lastMessages.find((m) => m.role === "assistant") as { content: string } | undefined;
    expect(assistant?.content).toBe("ok");
    expect(JSON.stringify(model.lastMessages)).not.toContain("call the tool");
  });

  it("RED LEG: every model iteration emits a turn frame carrying the messages it was sent, its number, timing and usage", async () => {
    const call = { id: "c1", name: LOOKUP.name, args: { house_number: "1", street: "X" } };
    const model = scripted([
      [{ type: "tool_call", call }, { type: "usage", promptTokens: 120, outputTokens: 8, ms: 40 }, { type: "end" }],
      [{ type: "token", text: "done" }, { type: "usage", promptTokens: 200, outputTokens: 3, ms: 25 }, { type: "end" }],
    ]);
    const { events, emit } = collect();
    await runAgent({ model, tools: [LOOKUP], messages: [{ role: "user", content: "q" }], emit, callTool: async () => ({ content: "{}", isError: false }) });
    const turns = events.filter((e) => e.type === "turn") as Array<Extract<AgentEvent, { type: "turn" }>>;
    expect(turns.map((t) => t.iteration)).toEqual([1, 2]);
    expect(turns[0]!.messages).toEqual([{ role: "user", content: "q" }]);
    expect(turns[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(turns[0]!.tools).toEqual([LOOKUP.name]);
    expect(turns[0]!.usage).toEqual({ promptTokens: 120, outputTokens: 8, ms: 40 });
    expect(turns[0]!.endedWith).toBe("tool_calls");
    expect(turns[1]!.endedWith).toBe("text");
    // the turn frame arrives AFTER that iteration's tokens/calls and BEFORE the next iteration begins
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("turn")).toBeGreaterThan(kinds.indexOf("tool_call"));
    expect(kinds.indexOf("turn")).toBeLessThan(kinds.indexOf("tool_result"));
  });

  it("a model that throws mid-turn ends with error + done(error)", async () => {
    const model: Model = { async *turn() { yield { type: "token", text: "par" }; throw new Error("connection reset"); } };
    const { events, emit } = collect();
    await runAgent({ model, tools: [], messages: [{ role: "user", content: "x" }], emit, callTool: async () => ({ content: "", isError: false }) });
    expect(events.map((e) => e.type)).toEqual(["token", "error", "done"]);
    expect(events.at(-1)).toMatchObject({ stoppedBy: "error" });
  });
});
