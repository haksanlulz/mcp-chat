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

export type ToolCallView = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result?: string;
};

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; parts: Array<{ kind: "text"; text: string } | { kind: "tool"; call: ToolCallView }>; errors: string[]; stoppedBy?: "answer" | "cap" | "error" };

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
      const copy = { ...last, parts: last.parts.slice(), errors: last.errors.slice() };
      fn(copy);
      next[next.length - 1] = copy;
      return next;
    });
  }, []);

  const send = useCallback(async (text: string) => {
    if (busy || !text.trim()) return;
    const userTurn: Turn = { role: "user", text };
    const history = [...turns, userTurn];
    setTurns([...history, { role: "assistant", parts: [], errors: [] }]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: toWire(history) }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        patchLast((a) => { a.errors.push(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`); a.stoppedBy = "error"; });
        return;
      }
      for await (const frame of sse(res.body)) {
        const e = frame as { type: string; [k: string]: unknown };
        if (e.type === "token") {
          patchLast((a) => {
            const last = a.parts[a.parts.length - 1];
            if (last && last.kind === "text") a.parts[a.parts.length - 1] = { kind: "text", text: last.text + String(e.text) };
            else a.parts.push({ kind: "text", text: String(e.text) });
          });
        } else if (e.type === "tool_call") {
          const call = e.call as { id: string; name: string; args: Record<string, unknown> };
          patchLast((a) => a.parts.push({ kind: "tool", call: { id: call.id, name: call.name, args: call.args, status: "running" } }));
        } else if (e.type === "tool_result") {
          patchLast((a) => {
            const i = a.parts.findIndex((p) => p.kind === "tool" && p.call.id === e.callId);
            if (i >= 0) {
              const p = a.parts[i] as { kind: "tool"; call: ToolCallView };
              a.parts[i] = { kind: "tool", call: { ...p.call, status: e.isError ? "error" : "ok", result: String(e.content) } };
            }
          });
        } else if (e.type === "error") {
          // Tool errors already show on their card; loop-level errors get a line.
          if (!e.callId) patchLast((a) => a.errors.push(String(e.message)));
        } else if (e.type === "done") {
          patchLast((a) => { a.stoppedBy = e.stoppedBy as "answer" | "cap" | "error"; });
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        patchLast((a) => { a.errors.push(err instanceof Error ? err.message : String(err)); a.stoppedBy = "error"; });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, turns, patchLast]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => { abortRef.current?.abort(); setTurns([]); }, []);

  return { turns, busy, send, stop, reset };
}

export async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
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
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data) yield JSON.parse(data);
    }
  }
}
