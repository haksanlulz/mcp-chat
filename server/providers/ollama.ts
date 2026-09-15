/**
 * Ollama provider: POST /api/chat with `stream: true` and `tools`. Ollama
 * streams NDJSON; a tool-capable model returns `message.tool_calls` on one
 * of the frames (usually with empty content), text otherwise.
 *
 * The transcript is rebuilt in Ollama's shape on every turn: assistant turns
 * carry `tool_calls`, tool results go back as `role: "tool"` messages. Ollama
 * has no per-call id, so the ids the loop assigned are kept only on our side.
 */
import type { Message, Model, ModelEvent, ToolSpec } from "../agent.js";

export type OllamaOptions = {
  baseUrl?: string;   // default http://127.0.0.1:11434
  model: string;      // e.g. "qwen3-coder:30b"
  timeoutMs?: number; // per-turn wall clock; default 120 s
};

type OllamaMsg =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
  | { role: "tool"; content: string; tool_name?: string };

export class OllamaModel implements Model {
  private readonly base: string;
  constructor(private readonly opts: OllamaOptions) {
    this.base = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  }

  async *turn(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent> {
    const body = {
      model: this.opts.model,
      stream: true,
      messages: messages.map(toOllama),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Ollama unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    try {
      let n = 0;
      for await (const frame of ndjson(res.body)) {
        const msg = frame.message as { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> } | undefined;
        if (msg?.content) yield { type: "token", text: msg.content };
        for (const tc of msg?.tool_calls ?? []) {
          n++;
          yield { type: "tool_call", call: { id: `ollama-${Date.now()}-${n}`, name: tc.function.name, args: tc.function.arguments ?? {} } };
        }
        if (frame.error) throw new Error(`Ollama: ${String(frame.error)}`);
        if (frame.done === true) break;
      }
    } finally {
      clearTimeout(timer);
    }
    yield { type: "end" };
  }
}

function toOllama(m: Message): OllamaMsg {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "tool") return { role: "tool", content: m.content, tool_name: m.name };
  const out: OllamaMsg = { role: "assistant", content: m.content };
  if (m.toolCalls?.length) (out as Extract<OllamaMsg, { role: "assistant" }>).tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
  return out;
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line) as Record<string, unknown>; }
      catch { throw new Error(`Ollama sent a non-JSON frame: ${line.slice(0, 120)}`); }
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf) as Record<string, unknown>; }
    catch { throw new Error(`Ollama sent a truncated frame: ${buf.slice(0, 120)}`); }
  }
}
