/**
 * The provider wire, offline. `fetch` is stubbed with a Response whose body is
 * a ReadableStream fed in deliberately awkward chunks, so the parsers are
 * tested where they break: a frame split mid-line, a tool call whose JSON
 * input streams in pieces, an error frame, a non-2xx status. The request
 * body each provider builds is captured and asserted too — the transcript
 * mapping is half of what a provider is for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaModel } from "../server/providers/ollama";
import { AnthropicModel } from "../server/providers/anthropic";
import type { Message, ModelEvent, ToolSpec } from "../server/agent";

const TOOL: ToolSpec = { name: "housing__who_owns", description: "HPD registration", inputSchema: { type: "object", properties: { house_number: { type: "string" } }, required: ["house_number"] } };

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) { for (const c of chunks) ctrl.enqueue(enc.encode(c)); ctrl.close(); },
  });
}

/** Stub fetch once; returns the captured request for assertions. */
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
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("OllamaModel", () => {
  const model = new OllamaModel({ model: "qwen-test", baseUrl: "http://ollama.test/" });

  it("RED LEG: an NDJSON frame split across chunks is one frame, and tokens keep order", async () => {
    stubFetch(200, [
      '{"message":{"role":"assistant","content":"Hel"},"done":false}\n{"message":{"role":"assistant","con',
      'tent":"lo"},"done":false}\n{"message":{"role":"assistant","content":""},"done":true}\n',
    ]);
    const ev = await collect(model.turn([{ role: "user", content: "hi" }], []));
    expect(ev).toEqual([{ type: "token", text: "Hel" }, { type: "token", text: "lo" }, { type: "end" }]);
  });

  it("turns message.tool_calls into tool_call events with the arguments intact", async () => {
    stubFetch(200, ['{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"housing__who_owns","arguments":{"house_number":"1520"}}}]},"done":true}\n']);
    const ev = await collect(model.turn([{ role: "user", content: "who owns it" }], [TOOL]));
    expect(ev[0]).toMatchObject({ type: "tool_call", call: { name: "housing__who_owns", args: { house_number: "1520" } } });
    expect(ev.at(-1)).toEqual({ type: "end" });
  });

  it("RED LEG: sends the loop's transcript in Ollama's shape — tool results as role tool with tool_name, assistant tool_calls carried", async () => {
    const cap = stubFetch(200, ['{"message":{"content":"ok"},"done":true}\n']);
    const history: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: TOOL.name, args: { house_number: "1520" } }] },
      { role: "tool", toolCallId: "c1", name: TOOL.name, content: '{"owner":"X"}', isError: false },
    ];
    await collect(model.turn(history, [TOOL]));
    expect(cap.url).toBe("http://ollama.test/api/chat");
    expect(cap.body.model).toBe("qwen-test");
    expect(cap.body.stream).toBe(true);
    expect(cap.body.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: TOOL.name, arguments: { house_number: "1520" } } }] },
      { role: "tool", content: '{"owner":"X"}', tool_name: TOOL.name },
    ]);
    expect(cap.body.tools[0]).toEqual({ type: "function", function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema } });
  });

  it("RED LEG: an error frame throws instead of ending as a clean answer", async () => {
    stubFetch(200, ['{"error":"model not found"}\n']);
    await expect(collect(model.turn([{ role: "user", content: "hi" }], []))).rejects.toThrow(/model not found/);
  });

  it("a non-2xx status throws with the status and body, and a non-JSON frame throws", async () => {
    stubFetch(500, ["boom"]);
    await expect(collect(model.turn([{ role: "user", content: "hi" }], []))).rejects.toThrow(/HTTP 500.*boom/);
    stubFetch(200, ["not json\n"]);
    await expect(collect(model.turn([{ role: "user", content: "hi" }], []))).rejects.toThrow(/non-JSON frame/);
  });
});

describe("AnthropicModel", () => {
  const model = new AnthropicModel({ apiKey: "sk-test", model: "claude-test", baseUrl: "https://anthropic.test", system: "be careful" });
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  it("RED LEG: a tool_use block whose input streams in input_json_delta pieces becomes ONE tool_call with assembled args", async () => {
    const frames = [
      sse("message_start", { type: "message_start" }),
      sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Looking. " } }),
      sse("content_block_stop", { index: 0 }),
      sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "housing__who_owns", input: {} } }),
      sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"house_' } }),
      sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: 'number": "15' } }),
      sse("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '20"}' } }),
      sse("content_block_stop", { index: 1 }),
      sse("message_delta", { delta: { stop_reason: "tool_use" } }),
      sse("message_stop", {}),
    ].join("");
    // split at an ugly place: inside the second delta's JSON
    const cut = frames.indexOf('number": "15') + 4;
    stubFetch(200, [frames.slice(0, cut), frames.slice(cut)]);
    const ev = await collect(model.turn([{ role: "user", content: "who owns 1520" }], [TOOL]));
    expect(ev).toEqual([
      { type: "token", text: "Looking. " },
      { type: "tool_call", call: { id: "toolu_1", name: "housing__who_owns", args: { house_number: "1520" } } },
      { type: "end" },
    ]);
  });

  it("RED LEG: the request carries the key, version, system and tools, and folds consecutive tool results into ONE user turn with is_error preserved", async () => {
    const cap = stubFetch(200, [sse("message_stop", {})]);
    const history: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "two calls", toolCalls: [{ id: "a", name: TOOL.name, args: { house_number: "1" } }, { id: "b", name: TOOL.name, args: { house_number: "2" } }] },
      { role: "tool", toolCallId: "a", name: TOOL.name, content: "owner A", isError: false },
      { role: "tool", toolCallId: "b", name: TOOL.name, content: "HPD 503", isError: true },
    ];
    await collect(model.turn(history, [TOOL]));
    const h = cap.init!.headers as Record<string, string>;
    expect(cap.url).toBe("https://anthropic.test/v1/messages");
    expect(h["x-api-key"]).toBe("sk-test");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(cap.body.model).toBe("claude-test");
    expect(cap.body.system).toBe("be careful");
    expect(cap.body.stream).toBe(true);
    expect(cap.body.tools).toEqual([{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.inputSchema }]);
    expect(cap.body.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: [
        { type: "text", text: "two calls" },
        { type: "tool_use", id: "a", name: TOOL.name, input: { house_number: "1" } },
        { type: "tool_use", id: "b", name: TOOL.name, input: { house_number: "2" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: "owner A" },
        { type: "tool_result", tool_use_id: "b", content: "HPD 503", is_error: true },
      ] },
    ]);
  });

  it("RED LEG: a stream error event throws, so the loop reports error rather than an empty answer", async () => {
    stubFetch(200, [sse("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })]);
    await expect(collect(model.turn([{ role: "user", content: "hi" }], []))).rejects.toThrow(/overloaded_error/);
  });

  it("a non-2xx status throws with the status and the API's message", async () => {
    stubFetch(401, ['{"error":{"message":"invalid x-api-key"}}']);
    await expect(collect(model.turn([{ role: "user", content: "hi" }], []))).rejects.toThrow(/HTTP 401.*invalid x-api-key/);
  });
});
