import { useState } from "react";
import type { ToolCallView } from "./useChat";

/**
 * One tool call, as the model made it and as the server answered it.
 * The result is collapsed by default; the record_scope line, if the server
 * sent one, is pulled out and shown open because it is the sentence that says
 * what the data does and does not establish.
 */
export function ToolCallCard({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const scope = recordScope(call.result);
  const [server, tool] = call.name.includes("__") ? call.name.split("__", 2) : ["", call.name];
  return (
    <div className={`tool tool--${call.status}`}>
      <button className="tool__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool__status" aria-label={call.status}>
          {call.status === "running" ? "…" : call.status === "ok" ? "✓" : "✗"}
        </span>
        <span className="tool__name">
          {server && <span className="tool__server">{server}</span>}
          {tool}
        </span>
        <code className="tool__args">{summarizeArgs(call.args)}</code>
      </button>
      {call.status === "error" && (
        <div className="tool__error" role="alert">
          Tool call failed — the assistant was told, and this is not an answer.
        </div>
      )}
      {scope && <div className="tool__scope">{scope}</div>}
      {open && (
        <pre className="tool__body">
          <b>arguments</b>{"\n"}{JSON.stringify(call.args, null, 2)}
          {call.result !== undefined && (<>{"\n\n"}<b>result</b>{"\n"}{pretty(call.result)}</>)}
        </pre>
      )}
    </div>
  );
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`);
  const s = parts.join(" ");
  return s.length > 90 ? s.slice(0, 87) + "…" : s;
}

function pretty(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

function recordScope(result: string | undefined): string | null {
  if (!result) return null;
  try {
    const j = JSON.parse(result) as { record_scope?: unknown };
    return typeof j.record_scope === "string" ? j.record_scope : null;
  } catch { return null; }
}
