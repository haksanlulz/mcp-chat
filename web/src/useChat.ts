/**
 * The client half of the SSE contract. POST /api/chat, read the event stream,
 * fold frames into a transcript the UI can render while it grows.
 *
 * Shape of a turn in the transcript, in arrival order:
 *   assistant text (streamed) · tool-call cards (each with its result and
 *   isError) · more text · done | error
 * A tool error is a card state, never text — the UI cannot mistake it for an
 * answer because it never arrives as one.
 */
import { useCallback, useRef, useState } from "react";
import { readSse } from "../../server/providers/stream.js";

export type ToolCallView = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: string;
};

/** One model iteration, as the runtime reported it: the debug record. */
export type TurnInfo = {
  iteration: number;
  messages: Array<{ role: string; content: string; toolCalls?: unknown; name?: string; isError?: boolean }>;
  tools: string[];
  usage: { promptTokens?: number; outputTokens?: number; ms?: number };
  endedWith: "text" | "tool_calls" | "empty";
  ms: number;
};

export type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; call: ToolCallView };

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: Part[]; errors: string[]; turns: TurnInfo[]; traceId?: string; stoppedBy?: "answer" | "cap" | "error" };

type WireMessage = { role: "user" | "assistant"; content: string };

function toWire(turns: Turn[]): WireMessage[] {
  // The runtime keeps tool messages inside a single request; across requests
  // we send the human-readable transcript only. Good enough for a chat; a
  // later version can round-trip tool history.
  return turns.map((t) => t.role === "user"
    ? { role: "user", content: t.text }
    : { role: "assistant", content: t.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") });
}

export function useChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patchLast = useCallback((fn: (a: Extract<Turn, { role: "assistant" }>) => void) => {
    setTurns((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (!last || last.role !== "assistant") return prev;
      const copy = { ...last, parts: last.parts.slice(), errors: last.errors.slice(), turns: last.turns.slice() };
      fn(copy);
      next[next.length - 1] = copy;
      return next;
    });
  }, []);

  const send = useCallback(async (text: string) => {
    if (abortRef.current || busy || !text.trim()) return;
    const userTurn: Turn = { role: "user", text };
    const history = [...turns, userTurn];
    setTurns([...history, { role: "assistant", parts: [], errors: [], turns: [] }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const patch = (fn: Parameters<typeof patchLast>[0]) => {
      if (abortRef.current === ctrl) patchLast(fn);
    };
    const fail = (message: string) => patch((a) => {
      a.errors.push(message);
      a.stoppedBy = "error";
      a.parts = a.parts.map((p) => p.kind === "tool" && p.call.status === "running"
        ? { kind: "tool", call: { ...p.call, status: "error", result: message } } : p);
    });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: toWire(history) }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        fail(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        return;
      }
      const traceId = res.headers.get("x-mcp-chat-trace");
      if (traceId) patch((a) => { a.traceId = traceId; });
      let complete = false;
      for await (const frame of sse(res.body, ctrl.signal)) {
        if (complete) throw new Error("event received after done");
        const e = frame as { type: string; [k: string]: unknown };
        if (e.type === "token") {
          patch((a) => {
            const last = a.parts[a.parts.length - 1];
            if (last && last.kind === "text") a.parts[a.parts.length - 1] = { kind: "text", text: last.text + String(e.text) };
            else a.parts.push({ kind: "text", text: String(e.text) });
          });
        } else if (e.type === "thinking") {
          // its own part kind: never merged into text, so it can never read as the answer
          patch((a) => {
            const last = a.parts[a.parts.length - 1];
            if (last && last.kind === "thinking") a.parts[a.parts.length - 1] = { kind: "thinking", text: last.text + String(e.text) };
            else a.parts.push({ kind: "thinking", text: String(e.text) });
          });
        } else if (e.type === "turn") {
          const { type: _t, ...info } = e as unknown as { type: string } & TurnInfo;
          patch((a) => a.turns.push(info));
        } else if (e.type === "tool_call") {
          const call = e.call as { id: string; name: string; args: Record<string, unknown> };
          patch((a) => a.parts.push({ kind: "tool", call: { id: call.id, name: call.name, args: call.args, status: "running" } }));
        } else if (e.type === "tool_result") {
          patch((a) => {
            const i = a.parts.findIndex((p) => p.kind === "tool" && p.call.id === e.callId);
            if (i >= 0) {
              const p = a.parts[i] as { kind: "tool"; call: ToolCallView };
              a.parts[i] = { kind: "tool", call: { ...p.call, status: e.isError ? "error" : "ok", result: String(e.content) } };
            }
          });
        } else if (e.type === "error") {
          // Tool errors already show on their card; loop-level errors get a line.
          if (!e.callId) patch((a) => a.errors.push(String(e.message)));
        } else if (e.type === "done") {
          complete = true;
          patch((a) => {
            a.stoppedBy = e.stoppedBy as "answer" | "cap" | "error";
            if (a.stoppedBy !== "answer") a.parts = a.parts.map((p) => p.kind === "tool" && p.call.status === "running"
              ? { kind: "tool", call: { ...p.call, status: "error", result: "request ended before the tool returned" } } : p);
          });
        }
      }
      if (!complete) throw new Error("response stream ended before done");
    } catch (err) {
      fail(ctrl.signal.aborted ? "request cancelled" : err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === ctrl) {
        setBusy(false);
        abortRef.current = null;
      }
    }
  }, [busy, turns, patchLast]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => { abortRef.current?.abort(); abortRef.current = null; setBusy(false); setTurns([]); }, []);

  return { turns, busy, send, stop, reset };
}

export async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<unknown> {
  for await (const frame of readSse(body, signal)) yield JSON.parse(frame.data);
}
