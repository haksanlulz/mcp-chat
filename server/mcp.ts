/**
 * MCP client manager: spawns each configured server over stdio, lists its
 * tools under a `<server>__<tool>` prefix so two servers can both have a
 * `search`, and routes a call back to the right client.
 *
 * Failure shape, on purpose: a server that fails to start is reported in
 * `status()` and its tools are simply absent — the assistant runs with what
 * came up, and the front end shows which servers did not. A tool call that
 * comes back `isError` is passed through as such; nothing here rewrites an
 * error into text.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolCall, ToolResult, ToolSpec } from "./agent.js";
import { logSecurity, type SecurityEvent } from "./log.js";

export type ServerConfig = {
  /** Short handle used as the tool-name prefix, e.g. "housing". [a-z0-9_-] only. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** The config's author vouches that every tool on this server only reads. Without it, only tools that declare
   *  `annotations.readOnlyHint: true` are run (MCP security audit 2026-11-25). */
  readOnly?: boolean;
};

export type ServerStatus = {
  name: string;
  state: "up" | "failed";
  tools: number;
  error?: string;
};

const SEP = "__";

export function qualify(server: string, tool: string): string {
  return `${server}${SEP}${tool}`;
}

export function split(qualified: string): { server: string; tool: string } | null {
  const i = qualified.indexOf(SEP);
  if (i <= 0) return null;
  return { server: qualified.slice(0, i), tool: qualified.slice(i + SEP.length) };
}

type Live = { config: ServerConfig; client: Client; tools: ToolSpec[]; readOnlyTools: Set<string> };

export class McpManager {
  private live = new Map<string, Live>();
  private failed = new Map<string, string>();
  private log: (e: SecurityEvent) => void;

  /** `log` receives security events (a refused call); the default writes them to stderr (server/log.ts). */
  constructor(opts: { log?: (e: SecurityEvent) => void } = {}) {
    this.log = opts.log ?? ((e) => logSecurity(e));
  }

  /** Start every server; never throws for one bad server. */
  async start(configs: ServerConfig[], opts: { timeoutMs?: number } = {}): Promise<ServerStatus[]> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    await Promise.all(configs.map(async (config) => {
      if (!/^[a-z0-9_-]+$/i.test(config.name) || config.name.includes(SEP) || config.name.endsWith("_")) {
        this.failed.set(config.name, `server name "${config.name}" must be [a-z0-9_-] without a trailing underscore or __`);
        return;
      }
      if (configs.filter(c => c.name === config.name).length > 1) {
        this.failed.set(config.name, `Duplicate server name: ${config.name}`);
        return;
      }
      const client = new Client({ name: "mcp-chat", version: "0.1.0" }, { capabilities: {} });
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...filteredEnv(), ...(config.env ?? {}) },
          ...(config.cwd ? { cwd: config.cwd } : {}),
          stderr: "pipe",
        });
        // Drain diagnostics so a verbose child cannot block on a full stderr pipe.
        transport.stderr?.on('data', () => {});
        await withTimeout(client.connect(transport), timeoutMs, `connect to "${config.name}"`);
        const tools: ToolSpec[] = [];
        const readOnlyTools = new Set<string>();
        const names = new Set<string>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const listed = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
          for (const tool of listed.tools) {
            if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
            names.add(tool.name);
            if ((tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true) readOnlyTools.add(tool.name);
            tools.push({ name: qualify(config.name, tool.name), description: tool.description ?? "", inputSchema: tool.inputSchema as ToolSpec["inputSchema"] });
          }
          cursor = listed.nextCursor;
          if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("Invalid or excessive tools/list pagination");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        this.live.set(config.name, { config, client, tools, readOnlyTools });
      } catch (err) {
        await client.close().catch(() => undefined);
        this.failed.set(config.name, err instanceof Error ? err.message : String(err));
      }
    }));
    return this.status();
  }

  status(): ServerStatus[] {
    const out: ServerStatus[] = [];
    for (const [name, l] of this.live) out.push({ name, state: "up", tools: l.tools.length });
    for (const [name, error] of this.failed) out.push({ name, state: "failed", tools: 0, error });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  tools(): ToolSpec[] {
    return [...this.live.values()].flatMap((l) => l.tools);
  }

  /** Execute one qualified call. Returns isError rather than throwing for anything the server reported. */
  async call(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const parts = split(call.name);
    const l = parts ? this.live.get(parts.server) : undefined;
    if (!parts || !l) return { content: `no running server for tool "${call.name}"`, isError: true };
    // Nothing here asks the person first, so only reading is allowed: a tool that declares itself read-only, or a
    // server the config vouches for. Anything else is refused before the server sees it.
    if (l.config.readOnly !== true && !l.readOnlyTools.has(parts.tool)) {
      this.log({ event: "tool_refused", tool: call.name, reason: "the tool does not declare itself read-only and the config does not vouch for its server" });
      return {
        content: `${call.name} was not run: this app runs only read-only tools, and this tool does not declare itself read-only. ` +
          `If every tool on "${parts.server}" only reads, the person who runs this app can set "readOnly": true on that server in the config.`,
        isError: true,
      };
    }
    const res = await l.client.callTool({ name: parts.tool, arguments: call.args }, undefined, signal ? { signal } : undefined);
    const content = (res.content as Array<{ type: string; text?: string }> | undefined ?? [])
      .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : `[${c.type}]`))
      .join("\n");
    return { content, isError: res.isError === true };
  }

  async stop(): Promise<void> {
    await Promise.all([...this.live.values()].map((l) => l.client.close().catch(() => undefined)));
    this.live.clear();
  }
}

/** The child gets PATH and the platform basics, not every secret in this shell. */
function filteredEnv(): Record<string, string> {
  const keep = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT", "LANG"];
  const out: Record<string, string> = {};
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k]!;
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
