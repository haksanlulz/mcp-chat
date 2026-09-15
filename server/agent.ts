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

export type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
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

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

/** What a provider yields for one model turn. */
export type ModelEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "end" };

export interface Model {
  /** One model turn. Yields tokens and tool calls, then `end`. */
  turn(messages: Message[], tools: ToolSpec[]): AsyncIterable<ModelEvent>;
}

export type ToolResult = { content: string; isError: boolean };
export type CallTool = (call: ToolCall) => Promise<ToolResult>;

/** Frames the HTTP layer forwards over SSE, in this order. */
export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; callId: string; name: string; content: string; isError: boolean }
  | { type: "error"; message: string; callId?: string }
  | { type: "done"; iterations: number; stoppedBy: "answer" | "cap" | "error" };

export type RunOptions = {
  model: Model;
  tools: ToolSpec[];
  messages: Message[];
  callTool: CallTool;
  maxIterations?: number;
  emit: (e: AgentEvent) => void;
};

/**
 * Validate a call's arguments against the tool's declared schema. The MCP
 * SDK's low-level Server does not do this, so a misspelled key would be
 * dropped silently on the far side; the same guard the operator's servers
 * carry, applied on the calling side too.
 */
export function validateArgs(tool: ToolSpec, args: Record<string, unknown>): string | null {
  const props = tool.inputSchema.properties ?? {};
  const accepted = Object.keys(props);
  const required = tool.inputSchema.required ?? [];
  const given = Object.keys(args);
  const missing = required.filter((k) => !(k in args));
  if (missing.length) {
    return `${tool.name}: missing required argument${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")}`;
  }
  const unknown = given.filter((k) => !accepted.includes(k));
  if (unknown.length && tool.inputSchema.additionalProperties !== true) {
    const described = unknown.map((k) => {
      const near = nearestArg(k, accepted);
      return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
    });
    return `${tool.name} does not accept ${described.join(", ")}. Accepted arguments: ${accepted.join(", ") || "(none)"}.`;
  }
  for (const [k, v] of Object.entries(args)) {
    const spec = props[k] as { type?: string } | undefined;
    if (!spec?.type) continue;
    const t = jsonType(v);
    if (spec.type !== t && !(spec.type === "number" && t === "integer")) {
      return `${tool.name}: argument "${k}" must be ${spec.type}, got ${t}`;
    }
  }
  return null;
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

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let text = "";
    const calls: ToolCall[] = [];
    try {
      for await (const ev of model.turn(messages, tools)) {
        if (ev.type === "token") {
          text += ev.text;
          out({ type: "token", text: ev.text });
        } else if (ev.type === "tool_call") {
          calls.push(ev.call);
          out({ type: "tool_call", call: ev.call });
        }
      }
    } catch (err) {
      out({ type: "error", message: `model failed: ${describe(err)}` });
      out({ type: "done", iterations: iteration, stoppedBy: "error" });
      return log;
    }

    messages.push(calls.length ? { role: "assistant", content: text, toolCalls: calls } : { role: "assistant", content: text });
    if (!calls.length) {
      out({ type: "done", iterations: iteration, stoppedBy: "answer" });
      return log;
    }

    for (const call of calls) {
      const spec = byName.get(call.name);
      const problem = spec ? validateArgs(spec, call.args) : `unknown tool "${call.name}"`;
      let result: ToolResult;
      if (problem) {
        result = { content: problem, isError: true };
      } else {
        try {
          result = await callTool(call);
        } catch (err) {
          result = { content: `${call.name}: ${describe(err)}`, isError: true };
        }
      }
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
