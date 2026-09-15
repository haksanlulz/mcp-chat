/**
 * Anthropic provider: POST /v1/messages with `stream: true` and `tools`.
 * Text arrives as `text_delta`, a tool call as a `tool_use` content block
 * whose JSON input streams in `input_json_delta` pieces until
 * `content_block_stop`. Tool results go back as `tool_result` blocks on a
 * user turn, with `is_error` preserved.
 *
 * No SDK: the wire format is small and a raw fetch keeps the dependency list
 * at the MCP SDK alone (the same reason the operator's servers are stdio-only).
 */
import type { Message, Model, ModelEvent, ToolSpec } from "../agent.js";

export type AnthropicOptions = {
  apiKey: string;
  model?: string;      // default: claude-sonnet-5
  baseUrl?: string;    // default https://api.anthropic.com
  maxTokens?: number;  // default 2048
  system?: string;
  timeoutMs?: number;
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export class AnthropicModel implements Model {
  private readonly base: string;
  constructor(private readonly opts: AnthropicOptions) {
    this.base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async *turn(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent> {
    const body = {
      model: this.opts.model ?? "claude-sonnet-5",
      max_tokens: this.opts.maxTokens ?? 2048,
      stream: true,
      ...(this.opts.system ? { system: this.opts.system } : {}),
      messages: toAnthropic(messages),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Anthropic API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic /v1/messages returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    // One in-flight tool_use block at a time; its JSON input streams in pieces.
    let pending: { id: string; name: string; json: string } | null = null;
    try {
      for await (const ev of sse(res.body)) {
        const data = ev.data as Record<string, any>;
        switch (ev.event) {
          case "content_block_start": {
            const cb = data.content_block;
            if (cb?.type === "tool_use") pending = { id: cb.id, name: cb.name, json: "" };
            break;
          }
          case "content_block_delta": {
            const d = data.delta;
            if (d?.type === "text_delta" && d.text) yield { type: "token", text: d.text };
            else if (d?.type === "input_json_delta" && pending) pending.json += d.partial_json ?? "";
            break;
          }
          case "content_block_stop": {
            if (pending) {
              let args: Record<string, unknown> = {};
              try { args = pending.json.trim() ? (JSON.parse(pending.json) as Record<string, unknown>) : {}; }
              catch { throw new Error(`Anthropic streamed non-JSON tool input for ${pending.name}: ${pending.json.slice(0, 120)}`); }
              yield { type: "tool_call", call: { id: pending.id, name: pending.name, args } };
              pending = null;
            }
            break;
          }
          case "error":
            throw new Error(`Anthropic stream error: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
          case "message_stop":
            break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    yield { type: "end" };
  }
}

/** Loop messages -> Anthropic turns. Consecutive tool results fold into one user turn, as the API requires. */
function toAnthropic(messages: Message[]): Array<{ role: "user" | "assistant"; content: string | Block[] }> {
  const out: Array<{ role: "user" | "assistant"; content: string | Block[] }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content: blocks.length ? blocks : "" });
    } else {
      const block: Block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: unknown }> {
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
      let event = "message";
      const datas: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) datas.push(line.slice(5).trim());
      }
      if (!datas.length) continue;
      const raw = datas.join("\n");
      try { yield { event, data: JSON.parse(raw) }; }
      catch { throw new Error(`Anthropic sent a non-JSON SSE frame (${event}): ${raw.slice(0, 120)}`); }
    }
  }
}
