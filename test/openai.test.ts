/**
 * The OpenAI-compatible wire: POST /v1/chat/completions with stream:true and
 * tools. This is the one most servers speak — OpenRouter, LM Studio,
 * llama.cpp's server, vLLM, LiteLLM, Ollama's /v1 — so it is what makes "any
 * model" true. Tested offline on the parts that break: tool_calls whose
 * arguments arrive as JSON fragments across many chunks (and across several
 * concurrent calls by index), reasoning_content / reasoning deltas, usage on
 * the final chunk, [DONE], and the transcript mapping back to the wire.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIModel } from "../server/providers/openai";
import type { Message, ModelEvent, ToolSpec } from "../server/agent";

const TOOL: ToolSpec = { name: "housing__who_owns", description: "HPD registration", inputSchema: { type: "object", properties: { house_number: { type: "string" } }, required: ["house_number"] } };

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); } });
}
function stubFetch(status: number, chunks: string[]) {
  const captured: { url?: string; init?: RequestInit | undefined; body?: any } = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    captured.url = url; captured.init = init;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(status === 200 ? streamOf(chunks) : chunks.join(""), { status });
  }));
  return captured;
}
async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []; for await (const e of it) out.push(e); return out;
}
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: Record<string, unknown>, extra: Record<string, unknown> = {}) => sse({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: null }], ...extra });
const finish = (reason = "stop") => sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + "data: [DONE]\n\n";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAIModel", () => {
  const model = new OpenAIModel({ baseUrl: "http://o.test/v1", model: "m", apiKey: "k" });

  it("RED LEG: content deltas stream as tokens, split across chunks mid-frame, and [DONE] ends the turn", async () => {
    const frames = delta({ role: "assistant", content: "Hel" }) + delta({ content: "lo" }) + finish();
    const cut = frames.indexOf("lo") + 1;
    stubFetch(200, [frames.slice(0, cut), frames.slice(cut)]);
    const ev = await collect(model.turn([{ role: "user", content: "hi" }], []));
    expect(ev.filter((e) => e.type !== "usage")).toEqual([{ type: "token", text: "Hel" }, { type: "token", text: "lo" }, { type: "end" }]);
  });

  it("RED LEG: a tool call whose arguments stream as fragments becomes ONE tool_call with assembled args, emitted at the end of the turn", async () => {
    const frames =
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "housing__who_owns", arguments: "" } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"house_' } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: 'number": "15' } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: '20"}' } }] }) +
      finish("tool_calls");
    stubFetch(200, [frames]);
    const ev = await collect(model.turn([{ role: "user", content: "who owns 1520" }], [TOOL]));
    expect(ev.filter((e) => e.type === "tool_call")).toEqual([{ type: "tool_call", call: { id: "call_1", name: "housing__who_owns", args: { house_number: "1520" } } }]);
    expect(ev.at(-1)).toEqual({ type: "end" });
  });

  it("RED LEG: two concurrent tool calls interleaved by index are kept apart", async () => {
    const frames =
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "housing__who_owns", arguments: "" } }, { index: 1, id: "b", function: { name: "housing__who_owns", arguments: "" } }] }) +
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"house_number":"1"}' } }] }) +
      delta({ tool_calls: [{ index: 1, function: { arguments: '{"house_number":"2"}' } }] }) +
      finish("tool_calls");
    stubFetch(200, [frames]);
    const ev = await collect(model.turn([{ role: "user", content: "q" }], [TOOL]));
    expect(ev.filter((e) => e.type === "tool_call").map((e) => (e as any).call)).toEqual([
      { id: "a", name: "housing__who_owns", args: { house_number: "1" } },
      { id: "b", name: "housing__who_owns", args: { house_number: "2" } },
    ]);
  });

  it("RED LEG: reasoning_content (and reasoning) deltas stream as thinking frames, never tokens", async () => {
    const frames = delta({ reasoning_content: "need the " }) + delta({ reasoning: "tool" }) + delta({ content: "ok" }) + finish();
    stubFetch(200, [frames]);
    const ev = await collect(model.turn([{ role: "user", content: "q" }], []));
    expect(ev.filter((e) => e.type === "thinking").map((e) => (e as any).text)).toEqual(["need the ", "tool"]);
    expect(ev.filter((e) => e.type === "token")).toEqual([{ type: "token", text: "ok" }]);
  });

  it("RED LEG: usage on the final chunk becomes a usage event, and stream_options asks for it", async () => {
    const cap = stubFetch(200, [delta({ content: "x" }) + sse({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 321, completion_tokens: 7 } }) + finish()]);
    const ev = await collect(model.turn([{ role: "user", content: "q" }], []));
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ promptTokens: 321, outputTokens: 7 });
    expect(cap.body.stream_options).toEqual({ include_usage: true });
  });

  it("RED LEG: the request carries the key, model, tools, and the transcript in the wire's shape — tool results as role tool with tool_call_id", async () => {
    const cap = stubFetch(200, [finish()]);
    const history: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: TOOL.name, args: { house_number: "1520" } }] },
      { role: "tool", toolCallId: "call_1", name: TOOL.name, content: '{"owner":"X"}', isError: false },
    ];
    await collect(new OpenAIModel({ baseUrl: "http://o.test/v1/", model: "m", apiKey: "k", system: "be careful" }).turn(history, [TOOL]));
    expect(cap.url).toBe("http://o.test/v1/chat/completions");
    expect((cap.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(cap.body.model).toBe("m");
    expect(cap.body.stream).toBe(true);
    expect(cap.body.tools).toEqual([{ type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema } }]);
    expect(cap.body.messages).toEqual([
      { role: "system", content: "be careful" },
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: TOOL.name, arguments: '{"house_number":"1520"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"owner":"X"}' },
    ]);
  });

  it("no key means no authorization header (local servers), and a non-2xx throws with the body", async () => {
    const cap = stubFetch(200, [finish()]);
    await collect(new OpenAIModel({ baseUrl: "http://o.test/v1", model: "m" }).turn([{ role: "user", content: "q" }], []));
    expect((cap.init!.headers as Record<string, string>).authorization).toBeUndefined();
    stubFetch(401, ['{"error":{"message":"bad key"}}']);
    await expect(collect(model.turn([{ role: "user", content: "q" }], []))).rejects.toThrow(/HTTP 401.*bad key/);
  });

  it("RED LEG: malformed tool arguments are surfaced as a tool_call with the raw string, so the loop's validator rejects it loudly instead of the turn crashing", async () => {
    const frames = delta({ tool_calls: [{ index: 0, id: "c", function: { name: "housing__who_owns", arguments: "{not json" } }] }) + finish("tool_calls");
    stubFetch(200, [frames]);
    const ev = await collect(model.turn([{ role: "user", content: "q" }], [TOOL]));
    const call = (ev.find((e) => e.type === "tool_call") as any).call;
    expect(call.name).toBe("housing__who_owns");
    expect(call.args).toEqual({ _raw: "{not json" });
  });
});
