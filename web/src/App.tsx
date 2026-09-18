import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ToolCallCard } from "./ToolCallCard";
import { useChat, type Turn } from "./useChat";

type Health = { ok: boolean; model: string; servers: Array<{ name: string; state: "up" | "failed"; tools: number; error?: string }> };

export function App() {
  const { turns, busy, send, stop, reset } = useChat();
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/health").then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setHealth((await r.json()) as Health);
    }).catch((e) => setHealthErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft;
    setDraft("");
    void send(text);
  };

  return (
    <div className="app">
      <header className="bar">
        <strong>mcp-chat</strong>
        <span className="bar__model">{health ? health.model : healthErr ? `runtime unreachable: ${healthErr}` : "…"}</span>
        <span className="bar__servers">
          {health?.servers.map((s) => (
            <span key={s.name} className={`pill pill--${s.state}`} title={s.error ?? `${s.tools} tools`}>
              {s.name}{s.state === "up" ? ` ${s.tools}` : " ✗"}
            </span>
          ))}
        </span>
        <button className="bar__reset" onClick={reset} disabled={!turns.length}>new chat</button>
      </header>

      <main className="log">
        {turns.map((t, i) => <TurnView key={i} turn={t} />)}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(e); } }}
          placeholder={health?.servers.some((s) => s.state === "up") ? "Ask about a building, a case, a rent figure…" : "No MCP servers are up; check the runtime log."}
          rows={2}
          disabled={busy}
        />
        {busy ? <button type="button" onClick={stop}>stop</button> : <button type="submit" disabled={!draft.trim()}>send</button>}
      </form>
    </div>
  );
}

/**
 * The one piece of markdown models emit constantly even when told not to:
 * `**bold**`. Rendered as <b>; everything else stays literal text, so there is
 * no HTML path from the model to the page. Odd asterisk counts are left as-is.
 */
export function emphasis(text: string): ReactNode[] {
  const parts = text.split("**");
  if (parts.length % 2 === 0) return [text];
  return parts.map((s, i) => (i % 2 ? <b key={i}>{s}</b> : s));
}

export function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === "user") return <div className="turn turn--user">{turn.text}</div>;
  return (
    <div className="turn turn--assistant">
      {turn.parts.map((p, i) => p.kind === "text"
        ? <div key={i} className="text">{emphasis(p.text)}</div>
        : <ToolCallCard key={p.call.id} call={p.call} />)}
      {turn.errors.map((e, i) => <div key={`e${i}`} className="turn__error" role="alert">{e}</div>)}
      {turn.stoppedBy === "cap" && <div className="turn__note">Stopped at the tool-call limit without a final answer.</div>}
      {!turn.parts.length && !turn.errors.length && !turn.stoppedBy && <div className="text text--pending">…</div>}
    </div>
  );
}
