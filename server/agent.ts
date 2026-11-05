/**
 * The tool loop, provider-agnostic and pure.
 *
 * `runAgent` takes a model that yields events, a set of tools it may call, and
 * a `callTool` that executes one. It returns the full event stream so the HTTP
 * layer can forward frames as they happen and the tests can assert on order.
 *
 * Rules the loop enforces, each with a test in test/agent.test.ts:
 *   1. Every tool call is validated against the tool's declared inputSchema
 *      BEFORE it is executed. A bad call becomes a tool_result with isError,
 *      fed back to the model, never a crash and never a silent drop.
 *   2. A tool result carrying isError is surfaced as an error frame AND fed
 *      back; the loop never turns an error into a plain answer.
 *   3. The loop stops after `maxIterations` model turns. Hitting the cap is an
 *      error frame, not a quiet truncation.
 *   4. `done` is emitted exactly once, last.
 */

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import Ajv2019 from "ajv/dist/2019.js";
import addFormats from "ajv-formats";

export type JsonSchema = Record<string, unknown> & {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
};

export type ToolSpec = {
  /** Fully-qualified name the model sees: `<server>__<tool>`. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean };

export type ToolCall = { id: string; name: string; args: Record<string, unknown>; argumentError?: string };

/** What a provider yields for one model turn. */
export type ModelEvent =
  | { type: "token"; text: string }
  /** The model's reasoning, when the provider exposes it. Never part of the answer. */
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: ToolCall }
  /** Internal continuation data; never emitted to the client or trace. */
  | { type: "provider_state"; state: unknown }
  /** Cost and timing for the turn, when the provider reports them. */
  | { type: "usage"; promptTokens?: number; outputTokens?: number; ms?: number }
  | { type: "end" };

export type Usage = { promptTokens?: number; outputTokens?: number; ms?: number };

export interface Model {
  /** One model turn. Yields tokens and tool calls, then `end`. */
  turn(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

// The assistant message is request-local. Weak keys keep provider data out of
// serialized messages, traces and other adapters' wire formats.
const providerStates = new WeakMap<Message, unknown>();
export function providerState(message: Message): unknown { return providerStates.get(message); }

export type ToolResult = { content: string; isError: boolean };
export type CallTool = (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>;

/** Frames the HTTP layer forwards over SSE, in this order. */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: ToolCall }
  /**
   * One per model iteration, emitted after that iteration's tokens and calls
     * and before any tool runs: the conversation messages and tool names the
     * loop supplied to the adapter, reported usage, and how the iteration ended.
     * The adapter adds provider-specific instructions and wire formatting.
   */
  | { type: "turn"; iteration: number; messages: Message[]; tools: string[]; usage: Usage; endedWith: "text" | "tool_calls" | "empty"; ms: number }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { type: "error"; message: string; callId?: string }
  | { type: "done"; iterations: number; stoppedBy: "answer" | "cap" | "error" };

export type RunOptions = {
  model: Model;
  tools: ToolSpec[];
  messages: Message[];
  callTool: CallTool;
  maxIterations?: number;
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
};

/**
 * Validate a call's arguments against the tool's declared schema. The MCP
 * SDK's low-level Server does not do this, so a misspelled key would be
 * dropped silently on the far side; the same guard the operator's servers
 * carry, applied on the calling side too.
 */
export function validateArgs(tool: ToolSpec, args: unknown): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return tool.name + ": arguments must be an object, got " + jsonType(args);
  }
  try {
    const props = tool.inputSchema.properties ?? {};
    const accepted = Object.keys(props);
    const required = tool.inputSchema.required ?? [];
    const missing = required.filter((k) => !Object.hasOwn(args, k));
    if (missing.length) return tool.name + ": missing required argument" + (missing.length > 1 ? "s " : " ") + missing.map((m) => JSON.stringify(m)).join(", ");

    // Keep the original typo guard for simple schemas. Composed/ref schemas
    // determine their accepted keys through JSON Schema rather than a flat list.
    const simple = !["$ref", "$dynamicRef", "allOf", "anyOf", "oneOf", "if"].some((k) => k in tool.inputSchema);
    const strictKeys = simple && tool.inputSchema.additionalProperties === undefined;
    if ((strictKeys || tool.inputSchema.additionalProperties === false) && !tool.inputSchema.patternProperties && simple) {
      const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
      if (unknown.length) {
        const described = unknown.map((k) => {
          const near = nearestArg(k, accepted);
          return JSON.stringify(k) + (near ? " (did you mean " + JSON.stringify(near) + "?)" : "");
        });
        return tool.name + " does not accept " + described.join(", ") + ". Accepted arguments: " + (accepted.join(", ") || "(none)") + ".";
      }
    }
    for (const [k, v] of Object.entries(args)) {
      const spec = props[k] as { type?: unknown } | undefined;
      const t = jsonType(v);
      if (typeof spec?.type === "string" && spec.type !== t && !(spec.type === "number" && t === "integer")) {
        return tool.name + ': argument "' + k + '" must be ' + spec.type + ", got " + t;
      }
    }
    let check = validators.get(tool.inputSchema);
    if (!check) {
      // A separate compiler per tool prevents an untrusted $id from reusing
      // another server's schema. No async loader exists; external refs fail closed.
      const schema = structuredClone(tool.inputSchema);
      rejectExternalRefs(schema);
      if (strictKeys) schema.additionalProperties = false;
      const dialect = schema.$schema;
      const options = { strict: true, strictTypes: false, strictTuples: false, strictRequired: false, allowUnionTypes: true, allErrors: true };
      const ajv = dialect === "http://json-schema.org/draft-07/schema#" || dialect === "http://json-schema.org/draft-07/schema"
        ? new Ajv(options) : dialect === "https://json-schema.org/draft/2019-09/schema" || dialect === "https://json-schema.org/draft/2019-09/schema#"
        ? new Ajv2019(options) : new Ajv2020(options);
      addFormats(ajv);
      check = ajv.compile(schema);
      if ("$async" in check && check.$async) throw new Error("async schemas are not supported");
      validators.set(tool.inputSchema, check);
    }
    if (!check(args)) return tool.name + ": arguments fail inputSchema: " + JSON.stringify(check.errors);
    return null;
  } catch (err) {
    return tool.name + ": cannot validate inputSchema: " + describe(err);
  }
}

const validators = new WeakMap<JsonSchema, import("ajv").ValidateFunction>();

function rejectExternalRefs(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["const", "enum", "default", "examples"].includes(key)) continue;
    if (key === "$async" && child === true) throw new Error("async schemas are not supported");
    if ((key === "$ref" || key === "$dynamicRef") && typeof child === "string" && !child.startsWith("#")) {
      throw new Error("external schema references are not supported");
    }
    rejectExternalRefs(child);
  }
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  return prev[b.length]!;
}

function nearestArg(key: string, accepted: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : null;
}

export async function runAgent(opts: RunOptions): Promise<AgentEvent[]> {
  const { model, tools, callTool, emit } = opts;
  const maxIterations = opts.maxIterations ?? 8;
  const messages: Message[] = [...opts.messages];
  const log: AgentEvent[] = [];
  const out = (e: AgentEvent) => {
    log.push(e);
    emit(e);
  };
  const byName = new Map(tools.map((t) => [t.name, t]));

  const cancelled = (iteration: number) => {
    if (!opts.signal?.aborted) return false;
    out({ type: "error", message: "request cancelled" });
    out({ type: "done", iterations: iteration, stoppedBy: "error" });
    return true;
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (cancelled(iteration - 1)) return log;
    let text = "";
    const calls: ToolCall[] = [];
    let usage: Usage = {};
    let state: unknown;
    // a copy of what THIS turn was sent, taken before the loop appends to it
    const sent = messages.map((m) => ({ ...m }));
    const started = Date.now();
    try {
      for await (const ev of model.turn(messages, tools, opts.signal)) {
        opts.signal?.throwIfAborted();
        if (ev.type === "token") {
          text += ev.text;
          out({ type: "token", text: ev.text });
        } else if (ev.type === "thinking") {
          out({ type: "thinking", text: ev.text });
        } else if (ev.type === "tool_call") {
          calls.push(ev.call);
          out({ type: "tool_call", call: ev.call });
        } else if (ev.type === "provider_state") {
          state = ev.state;
        } else if (ev.type === "usage") {
          const { type: _t, ...u } = ev;
          usage = { ...usage, ...u };
        }
      }
    } catch (err) {
      out({ type: "error", message: `model failed: ${describe(err)}` });
      out({ type: "done", iterations: iteration, stoppedBy: "error" });
      return log;
    }
    if (cancelled(iteration)) return log;
    out({
      type: "turn", iteration, messages: sent, tools: tools.map((t) => t.name), usage,
      endedWith: calls.length ? "tool_calls" : text ? "text" : "empty", ms: Date.now() - started,
    });

    const assistant: Message = calls.length ? { role: "assistant", content: text, toolCalls: calls } : { role: "assistant", content: text };
    if (state !== undefined) providerStates.set(assistant, state);
    messages.push(assistant);
    if (!calls.length) {
      out({ type: "done", iterations: iteration, stoppedBy: "answer" });
      return log;
    }

    for (const call of calls) {
      if (cancelled(iteration)) return log;
      const spec = byName.get(call.name);
      const problem = spec ? (call.argumentError ?? validateArgs(spec, call.args)) : `unknown tool "${call.name}"`;
      let result: ToolResult;
      if (problem) {
        result = { content: problem, isError: true };
      } else {
        try {
          result = await callTool(call, opts.signal);
        } catch (err) {
          result = { content: `${call.name}: ${describe(err)}`, isError: true };
        }
      }
      if (cancelled(iteration)) return log;
      out({ type: "tool_result", callId: call.id, name: call.name, content: result.content, isError: result.isError });
      if (result.isError) out({ type: "error", message: result.content, callId: call.id });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: result.content, isError: result.isError });
    }
  }

  out({ type: "error", message: `stopped after ${maxIterations} model turns without a final answer` });
  out({ type: "done", iterations: maxIterations, stoppedBy: "cap" });
  return log;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : `non-Error value (${typeof err})`;
}
