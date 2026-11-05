/**
 * Request traces: every frame of every /api/chat request, as JSONL, one file
 * per request under the trace directory. This is the testbed's log — the
 * thing to open when a model did something odd. Each line is a frame with a
 * timestamp; the `turn` frames contain the loop's conversation and tool
 * names. Provider-specific instructions and serialized schemas are separate.
 *
 * Off by default. Enable with MCP_CHAT_TRACE=1 (or a directory path).
 * Trace frames contain unredacted conversation and tool results.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentEvent } from "./agent.js";

export type TraceMeta = { id: string; startedAt: string; model: string; messages: number; question: string };

export class TraceStore {
  readonly dir: string | null;
  constructor(setting: string | undefined) {
    if (!setting || setting === "0" || setting.toLowerCase() === "false") { this.dir = null; return; }
    this.dir = resolve(setting === "1" || setting.toLowerCase() === "true" ? "traces" : setting);
    mkdirSync(this.dir, { recursive: true });
  }

  get enabled(): boolean { return this.dir !== null; }

  /** Start a trace; returns a writer that appends one frame per call, or null when tracing is off. */
  begin(meta: Omit<TraceMeta, "id" | "startedAt">): { id: string; write: (e: AgentEvent) => void } | null {
    if (!this.dir) return null;
    const startedAt = new Date();
    const id = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const path = join(this.dir, `${id}.jsonl`);
    const head: TraceMeta = { id, startedAt: startedAt.toISOString(), ...meta };
    appendFileSync(path, JSON.stringify({ type: "meta", ...head }) + "\n");
    return {
      id,
      write: (e) => { appendFileSync(path, JSON.stringify({ t: Date.now() - startedAt.getTime(), ...e }) + "\n"); },
    };
  }

  list(limit = 50): TraceMeta[] {
    if (!this.dir || !existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => {
        const first = readFileSync(join(this.dir!, f), "utf-8").split("\n", 1)[0] ?? "";
        try { const { type: _t, ...meta } = JSON.parse(first); return meta as TraceMeta; }
        catch { return { id: f.replace(/\.jsonl$/, ""), startedAt: "", model: "", messages: 0, question: "(unreadable)" }; }
      });
  }

  /** The frames of one trace, or null if there is no such trace. Ids are validated so a path never escapes the directory. */
  read(id: string): Array<Record<string, unknown>> | null {
    if (!this.dir || !/^[\w-]+$/.test(id)) return null;
    const path = join(this.dir, `${id}.jsonl`);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
