import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent, type Model, type ModelEvent, type ToolSpec } from "../server/agent";
import { OpenAIModel } from "../server/providers/openai";
import { AnthropicModel } from "../server/providers/anthropic";
import { OllamaModel } from "../server/providers/ollama";
import { sse } from "../web/src/useChat";

const stream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const text of chunks) c.enqueue(new TextEncoder().encode(text)); c.close(); } });
const collect = async <T,>(values: AsyncIterable<T>) => { const out: T[] = []; for await (const value of values) out.push(value); return out; };
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const event = (name: string, value: unknown) => `event: ${name}\n${data(value)}`;
const oaFinish = (reason = "stop") => data({ choices: [{ delta: {}, finish_reason: reason }] }) + "data: [DONE]\n\n";
const anFinish = (reason = "end_turn") => event("message_delta", { delta: { stop_reason: reason } }) + event("message_stop", {});
const tool: ToolSpec = { name: "fx__echo", description: "", inputSchema: { type: "object", additionalProperties: true } };
const factories: Record<string, () => Model> = {
  openai: () => new OpenAIModel({ baseUrl: "http://fake.invalid", model: "fake", timeoutMs: 200 }),
  anthropic: () => new AnthropicModel({ baseUrl: "http://fake.invalid", apiKey: "fake", timeoutMs: 200 }),
  ollama: () => new OllamaModel({ baseUrl: "http://fake.invalid", model: "fake", timeoutMs: 200 }),
};
const good: Record<string, string> = {
  openai: data({ choices: [{ delta: { content: "answer" } }] }) + oaFinish(),
  anthropic: event("content_block_delta", { delta: { type: "text_delta", text: "answer" } }) + anFinish(),
  ollama: '{"message":{"content":"answer"},"done":true,"done_reason":"stop"}\n',
};
const calls: Record<string, string> = {
  openai: data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: tool.name, arguments: "{}" } }] } }] }),
  anthropic: event("content_block_start", { content_block: { type: "tool_use", id: "1", name: tool.name, input: {} } }) + event("content_block_delta", { delta: { type: "input_json_delta", partial_json: "{}" } }) + event("content_block_stop", {}),
  ollama: JSON.stringify({ message: { tool_calls: [{ function: { name: tool.name, arguments: {} } }] }, done: false }) + "\n",
};
const messages = [{ role: "user" as const, content: "probe" }];
afterEach(() => vi.unstubAllGlobals());

describe("provider framing and completion boundaries", () => {
  it.each(Object.keys(factories))("%s accepts CRLF framing even split between CR and LF", async (name) => {
    const text = good[name]!.replace(/\n/g, "\r\n");
    const chunks = [...text]; // includes byte/chunk boundaries inside CRLF
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream(chunks))));
    const frames = await collect(factories[name]!().turn(messages, []));
    expect(frames.filter((e) => e.type === "token")).toEqual([{ type: "token", text: "answer" }]);
    expect(frames.at(-1)).toEqual({ type: "end" });
  });

  it.each(Object.keys(factories))("%s fails on EOF before completion and never invokes a partial tool call", async (name) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(calls[name])));
    let invoked = 0;
    const frames = await runAgent({ model: factories[name]!(), tools: [tool], messages, emit() {}, callTool: async () => { invoked++; return { content: "wrong", isError: false }; } });
    expect(invoked).toBe(0);
    expect(frames.at(-1)).toMatchObject({ type: "done", stoppedBy: "error" });
    expect(frames.some((e) => e.type === "error")).toBe(true);
  });

  it.each([
    ["openai", "length"], ["openai", "content_filter"],
    ["anthropic", "max_tokens"], ["anthropic", "refusal"], ["anthropic", "pause_turn"],
    ["ollama", "length"],
  ])("%s rejects stop reason %s before executing a tool", async (name, reason) => {
    const finish = name === "openai" ? oaFinish(reason) : name === "anthropic" ? anFinish(reason) : JSON.stringify({ done: true, done_reason: reason }) + "\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(calls[name!]! + finish)));
    let invoked = 0;
    const frames = await runAgent({ model: factories[name!]!(), tools: [tool], messages, emit() {}, callTool: async () => { invoked++; return { content: "wrong", isError: false }; } });
    expect(invoked).toBe(0);
    expect(frames.at(-1)).toMatchObject({ type: "done", stoppedBy: "error" });
    expect(frames.some((e) => e.type === "error" && e.message.includes(reason!))).toBe(true);
  });

  it.each(Object.keys(factories))("%s propagates cancellation to fetch and cancels a blocked response reader", async (name) => {
    const controller = new AbortController(); let requestSignal: AbortSignal | undefined; let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Response(new ReadableStream({ start() { setTimeout(() => controller.abort(), 5); }, cancel() { cancelled = true; } }));
    }));
    await expect(collect(factories[name]!().turn(messages, [], controller.signal))).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("Ollama sends its configured system prompt before the human transcript", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(good.ollama); }));
    await collect(new OllamaModel({ model: "fake", system: "never guess a borough" }).turn(messages, []));
    expect(sent.messages).toEqual([{ role: "system", content: "never guess a borough" }, ...messages]);
  });

  it.each(["null", "[]", "17", "{bad"])("OpenAI malformed arguments %s become a tool error the model can recover from", async (input) => {
    let requests = 0; let feedback: any; let invoked = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      requests++;
      if (requests === 1) return new Response(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: tool.name, arguments: input } }] } }] }) + oaFinish("tool_calls"));
      feedback = JSON.parse(String(init.body)); return new Response(good.openai);
    }));
    const frames = await runAgent({ model: factories.openai!(), tools: [tool], messages, emit() {}, callTool: async () => { invoked++; return { content: "wrong", isError: false }; } });
    expect(invoked).toBe(0); expect(requests).toBe(2);
    expect(feedback.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "bad" });
    expect(frames.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    expect(frames.at(-1)).toMatchObject({ type: "done", stoppedBy: "answer" });
  });
});

describe("browser SSE boundary", () => {
  it("accepts CRLF and CR-only event delimiters", async () => {
    const frames = 'data: {"type":"token","text":"hi"}\r\n\r\ndata: {"type":"done"}\r\r';
    expect(await collect(sse(stream([...frames])))).toEqual([{ type: "token", text: "hi" }, { type: "done" }]);
  });
  it("rejects a truncated last frame rather than silently dropping it", async () => {
    await expect(collect(sse(stream(['data: {"type":"token"}'])))).rejects.toThrow(/truncated SSE frame/);
  });
  it("preserves split multibyte UTF-8", async () => {
    const bytes = new TextEncoder().encode('data: {"type":"token","text":"🗽"}\n\n');
    const response = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    expect(await collect(sse(response))).toEqual([{ type: "token", text: "🗽" }]);
  });
});
