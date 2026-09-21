/**
 * OpenAI-compatible provider: POST {baseUrl}/chat/completions with
 * `stream: true` and `tools`. The wire most servers speak — OpenRouter, LM
 * Studio, llama.cpp's server, vLLM, LiteLLM, Ollama's own /v1 — so this is
 * what lets "any model" mean any model, not two vendors.
 *
 * Streaming shape: SSE, each `data:` a chat.completion.chunk whose
 * choices[0].delta carries `content`, and/or `tool_calls` — an array of
 * partial calls keyed by `index`, whose `function.arguments` arrive as JSON
 * fragments over many chunks. A call is complete only at the end of the turn,
 * so tool_call events are emitted then, in index order. `reasoning_content`
 * (DeepSeek, vLLM) or `reasoning` (OpenRouter) deltas are thinking. Usage
 * arrives on a final chunk with empty choices when `stream_options.include_usage`
 * is set; not every server honours it, so its absence is not an error.
 * `data: [DONE]` ends the stream.
 *
 * No SDK, same as the other two providers.
 */
import type { Message, Model, ModelEvent, ToolSpec } from "../agent.js";

export type OpenAIOptions = {
  baseUrl: string;      // e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:8080/v1
  model: string;
  apiKey?: string;      // omitted for local servers that take none
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Extra headers some gateways want (OpenRouter's HTTP-Referer / X-Title). */
  headers?: Record<string, string>;
};

type WireMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export class OpenAIModel implements Model {
  private readonly base: string;
  constructor(private readonly opts: OpenAIOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async *turn(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent> {
    const body = {
      model: this.opts.model,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.opts.maxTokens ? { max_tokens: this.opts.maxTokens } : {}),
      messages: toWire(messages, this.opts.system),
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
    };
    const headers: Record<string, string> = { "content-type": "application/json", ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`OpenAI-compatible endpoint unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`${this.base}/chat/completions returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }

    // partial tool calls by index; complete only when the stream ends
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const data of sse(res.body)) {
        if (data === "[DONE]") break;
        let chunk: any;
        try { chunk = JSON.parse(data); }
        catch { throw new Error(`OpenAI-compatible stream sent a non-JSON frame: ${data.slice(0, 120)}`); }
        if (chunk.error) throw new Error(`OpenAI-compatible stream error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
        const u = chunk.usage;
        if (u) {
          if (typeof u.prompt_tokens === "number") promptTokens = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") outputTokens = u.completion_tokens;
        }
        const d = chunk.choices?.[0]?.delta;
        if (!d) continue;
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (typeof reasoning === "string" && reasoning) yield { type: "thinking", text: reasoning };
        if (typeof d.content === "string" && d.content) yield { type: "token", text: d.content };
        for (const tc of d.tool_calls ?? []) {
          const i = typeof tc.index === "number" ? tc.index : 0;
          const cur = pending.get(i) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
          pending.set(i, cur);
        }
      }
    } finally {
      clearTimeout(timer);
    }
    for (const [i, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      // Malformed JSON is handed to the loop as {_raw}, so its validator
      // rejects the call with a message the model can read; never a crash.
      let args: Record<string, unknown>;
      try { args = c.args.trim() ? (JSON.parse(c.args) as Record<string, unknown>) : {}; }
      catch { args = { _raw: c.args }; }
      yield { type: "tool_call", call: { id: c.id || `oai-${started}-${i}`, name: c.name, args } };
    }
    yield { type: "usage", ...(promptTokens !== undefined ? { promptTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ms: Date.now() - started };
    yield { type: "end" };
  }
}

function toWire(messages: Message[], system?: string): WireMsg[] {
  const out: WireMsg[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const calls = m.toolCalls?.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      out.push({ role: "assistant", content: m.content || null, ...(calls?.length ? { tool_calls: calls } : {}) });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

/** SSE `data:` payloads, frames reassembled across chunk boundaries. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const datas = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (datas.length) yield datas.join("\n");
    }
  }
}
