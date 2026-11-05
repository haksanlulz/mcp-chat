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
import { providerState } from "../agent.js";
import { readSse } from "./stream.js";

export type AnthropicOptions = {
  apiKey: string;
  model?: string;      // default: claude-sonnet-5
  baseUrl?: string;    // default https://api.anthropic.com
  maxTokens?: number;  // default 2048
  system?: string;
  timeoutMs?: number;
  /**
   * Extended thinking budget in tokens. When set, the request enables
   * thinking and `thinking_delta` events stream as `thinking` frames. The API
   * requires max_tokens > budget, so max_tokens is raised to cover it.
   */
  thinkingBudget?: number;
};

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };


export class AnthropicModel implements Model {
  private readonly base: string;
  constructor(private readonly opts: AnthropicOptions) {
    this.base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  }

  async *turn(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ModelEvent> {
    signal?.throwIfAborted();
    const budget = this.opts.thinkingBudget;
    const maxTokens = this.opts.maxTokens ?? 2048;
    const body = {
      model: this.opts.model ?? "claude-sonnet-5",
      // extended thinking requires max_tokens > budget_tokens
      max_tokens: budget ? Math.max(maxTokens, budget + 1024) : maxTokens,
      stream: true,
      ...(budget ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
      ...(this.opts.system ? { system: this.opts.system } : {}),
      messages: toAnthropic(messages),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 120_000);
    const requestSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
    const started = Date.now();
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
        signal: requestSignal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`Anthropic API unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok || !res.body) {
      let text: string;
      try { text = await res.text().catch(() => ""); }
      finally { clearTimeout(timer); }
      throw new Error(`Anthropic /v1/messages returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    // One in-flight tool_use block at a time; its JSON input streams in pieces.
    let pending: { id: string; name: string; json: string } | null = null;
    const blocks = new Map<number, Block>();
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    let complete = false;
    let finish: string | undefined;
    try {
      for await (const ev of readSse(res.body, requestSignal)) {
        let data: Record<string, any>;
        try { data = JSON.parse(ev.data); }
        catch { throw new Error(`Anthropic sent a non-JSON SSE frame (${ev.event}): ${ev.data.slice(0, 120)}`); }
        switch (ev.event) {
          case "message_start": {
            const u = data.message?.usage;
            if (typeof u?.input_tokens === "number") promptTokens = u.input_tokens;
            break;
          }
          case "content_block_start": {
            const cb = data.content_block;
            if (cb?.type === "tool_use") pending = { id: cb.id, name: cb.name, json: "" };
            if (cb && ["text", "thinking", "redacted_thinking", "tool_use"].includes(cb.type)) {
              blocks.set(data.index, structuredClone(cb) as Block);
            }
            break;
          }
          case "content_block_delta": {
            const d = data.delta;
            const block = blocks.get(data.index);
            if (block?.type === "text" && d?.type === "text_delta") block.text += d.text ?? "";
            if (block?.type === "thinking" && d?.type === "thinking_delta") block.thinking += d.thinking ?? "";
            if (block?.type === "thinking" && d?.type === "signature_delta") block.signature = (block.signature ?? "") + (d.signature ?? "");
            if (d?.type === "text_delta" && d.text) yield { type: "token", text: d.text };
            else if (d?.type === "thinking_delta" && d.thinking) yield { type: "thinking", text: d.thinking };
            else if (d?.type === "input_json_delta" && pending) pending.json += d.partial_json ?? "";
            break;
          }
          case "message_delta": {
            if (data.delta?.stop_reason != null) {
              finish = data.delta.stop_reason;
              if (!["end_turn", "tool_use", "stop_sequence"].includes(finish!)) throw new Error(`Anthropic turn stopped with ${finish}`);
            }
            const u = data.usage;
            if (typeof u?.output_tokens === "number") outputTokens = u.output_tokens;
            break;
          }
          case "content_block_stop": {
            if (pending) {
              let args: Record<string, unknown> = {};
              let argumentError: string | undefined;
              try { args = pending.json.trim() ? (JSON.parse(pending.json) as Record<string, unknown>) : {}; }
              catch { args = { _raw: pending.json }; argumentError = `${pending.name}: tool arguments are not valid JSON`; }
              const block = blocks.get(data.index);
              if (block?.type === "tool_use") block.input = args;
              yield { type: "tool_call", call: { id: pending.id, name: pending.name, args, ...(argumentError ? { argumentError } : {}) } };
              pending = null;
            }
            break;
          }
          case "error":
            throw new Error(`Anthropic stream error: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
          case "message_stop":
            complete = true;
            break;
        }
        if (complete) break;
      }
      if (!complete || !finish || pending) throw new Error("Anthropic stream ended before its terminal stop reason and message_stop");
    } finally {
      clearTimeout(timer);
    }
    if (finish === "tool_use" && [...blocks.values()].some((b) => b.type === "thinking" || b.type === "redacted_thinking")) {
      yield { type: "provider_state", state: { provider: "anthropic", blocks: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b) } };
    }
    yield { type: "usage", ...(promptTokens !== undefined ? { promptTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ms: Date.now() - started };
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
      const state = providerState(m) as { provider?: string; blocks?: Block[] } | undefined;
      if (state?.provider === "anthropic" && state.blocks) {
        out.push({ role: "assistant", content: state.blocks });
        continue;
      }
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
