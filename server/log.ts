/**
 * The runtime's own log lines, all on stderr (the inventory is GAUNTLET.md §8).
 *
 * Security events (app standard WEB-1, ASVS V16.2-V16.4): one JSON object per line, so a reader can parse
 * them and no field can start a new line. `t` is UTC. The actor is always the local user, so there is no
 * "who"; `origin` and `site` say which page, if any, sent the request. Paths are logged without their query.
 *
 * Status lines are for a person reading the terminal. Text from a server (its name, its error) is escaped,
 * so a newline in it cannot forge a line.
 */
import type { ServerStatus } from "./mcp.js";

export type SecurityEvent = {
  /** refused: the request guard said no. rejected: the body was refused. tool_refused: a non-read-only call.
   *  error: something failed that no rule expected. */
  event: "refused" | "rejected" | "tool_refused" | "error";
  reason: string;
  status?: number;
  method?: string;
  path?: string;
  origin?: string;
  site?: string;
  tool?: string;
};

export type LogWriter = (line: string) => void;

const toStderr: LogWriter = (line) => { process.stderr.write(line + "\n"); };

export function securityLine(e: SecurityEvent, now = new Date()): string {
  // A reason can quote a client's own value (an unexpected role, say); 500 characters is enough to read it.
  return JSON.stringify({ t: now.toISOString(), log: "security", ...e, reason: e.reason.slice(0, 500) });
}

export function logSecurity(e: SecurityEvent, write: LogWriter = toStderr): void {
  write(securityLine(e));
}

/** A string with every control character, quote and backslash escaped, without the surrounding quotes. */
export function oneLine(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

export function statusLine(s: ServerStatus): string {
  return `[mcp-chat] ${oneLine(s.name)}: ${s.state}${s.state === "up" ? ` (${s.tools} tools)` : ` — ${oneLine(s.error ?? "")}`}`;
}
