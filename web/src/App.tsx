import { useEffect, useRef, useState, type FormEvent } from "react";
import { Markdown } from "./markdown";
import { ToolCallCard } from "./ToolCallCard";
import { useChat, type Turn, type TurnInfo } from "./useChat";

type Health = { ok: boolean; model: string; servers: Array<{ name: string; state: "up" | "failed"; tools: number; error?: string }>; traces?: boolean };

const DEBUG_KEY = "mcp-chat.debug";

export function App() {
  const { turns, busy, send, stop, reset } = useChat();
  const [draft, setDraft] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [debug, setDebug] = useState<boolean>(() => { try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; } });
  const endRef = useRef<HTMLDivElement>(null);

  const toggleDebug = () => setDebug((d) => { try { localStorage.setItem(DEBUG_KEY, d ? "0" : "1"); } catch {} return !d; });

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
            <span key={s.name} className={`pill pill--${s.state}`} title={s.state === "up" ? `MCP server "${s.name}" is up with ${s.tools} tools; the model sees them as ${s.name}__<tool>` : `MCP server "${s.name}" failed to start: ${s.error ?? "unknown error"}. The assistant runs with the servers that came up.`}>
              {s.name}{s.state === "up" ? ` ${s.tools}` : " ✗"}
            </span>
          ))}
        </span>
        <button className={`bar__debug${debug ? " bar__debug--on" : ""}`} onClick={toggleDebug} title="show the model's thinking, each turn's prompt, tokens and timing" aria-pressed={debug}>debug</button>
        <button className="bar__reset" onClick={reset} disabled={!turns.length}>new chat</button>
      </header>

      <main className="log">
        {turns.map((t, i) => <TurnView key={i} turn={t} debug={debug} />)}
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

export function TurnView({ turn, debug = false }: { turn: Turn; debug?: boolean }) {
  if (turn.role === "user") return <div className="turn turn--user">{turn.text}</div>;
  // Debug view: each model iteration's strip sits where that iteration ended —
  // after its tokens and calls, before the tool results the next one saw.
  // Parts are in arrival order; a turn strip belongs after the last part that
  // arrived before its `turn` frame, which the transcript does not record, so
  // the strips are rendered as a block after the parts, in iteration order.
  return (
    <div className="turn turn--assistant">
      {turn.parts.map((p, i) => {
        if (p.kind === "text") return <div key={i} className="text"><Markdown text={p.text} /></div>;
        if (p.kind === "thinking") return debug ? <Thinking key={i} text={p.text} /> : null;
        return <ToolCallCard key={p.call.id} call={p.call} />;
      })}
      {debug && turn.turns.map((t) => <TurnStrip key={t.iteration} info={t} />)}
      {debug && turn.traceId && <div className="turn__trace">trace <code>{turn.traceId}</code> · <a href={`/api/trace/${turn.traceId}`} target="_blank" rel="noopener noreferrer">frames</a></div>}
      {turn.errors.map((e, i) => <div key={`e${i}`} className="turn__error" role="alert">{e}</div>)}
      {turn.stoppedBy === "cap" && <div className="turn__note">Stopped at the tool-call limit without a final answer.</div>}
      {!turn.parts.length && !turn.errors.length && !turn.stoppedBy && <div className="text text--pending">…</div>}
    </div>
  );
}

/** The model's reasoning, when the provider exposes it. Collapsed by default; never styled as answer text. */
function Thinking({ text }: { text: string }) {
  return (
    <details className="thinking">
      <summary>thinking · {text.length.toLocaleString()} chars</summary>
      <pre>{text}</pre>
    </details>
  );
}

const fmt = (n: number | undefined) => (n === undefined ? "?" : n.toLocaleString());

/** One iteration's timing, finish state and conversation before provider formatting. */
function TurnStrip({ info }: { info: TurnInfo }) {
  const u = info.usage;
  return (
    <details className="turnstrip">
      <summary>
        <span className="turnstrip__n">turn {info.iteration}</span>
        <span className="turnstrip__stat">{fmt(u.promptTokens)} in</span>
        <span className="turnstrip__stat">{fmt(u.outputTokens)} out</span>
        <span className="turnstrip__stat">{fmt(u.ms ?? info.ms)} ms</span>
        <span className="turnstrip__stat">{info.messages.length} msgs · {info.tools.length} tools</span>
        <span className={`turnstrip__end turnstrip__end--${info.endedWith}`}>{info.endedWith}</span>
      </summary>
      <div className="turnstrip__body">
        <div className="turnstrip__label">Conversation messages, oldest first</div>
        {info.messages.map((m, i) => (
          <div key={i} className={`msg msg--${m.role}`}>
            <span className="msg__role">{m.role}{m.name ? ` › ${m.name}` : ""}{m.isError ? " (error)" : ""}</span>
            <pre className="msg__body">{m.content || (m.toolCalls ? JSON.stringify(m.toolCalls, null, 2) : "(empty)")}</pre>
          </div>
        ))}
        <div className="turnstrip__label">tools offered</div>
        <pre className="msg__body">{info.tools.join("\n")}</pre>
      </div>
    </details>
  );
}
