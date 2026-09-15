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

export type ServerConfig = {
  /** Short handle used as the tool-name prefix, e.g. "housing". [a-z0-9_-] only. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
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

type Live = { config: ServerConfig; client: Client; tools: ToolSpec[] };

export class McpManager {
  private live = new Map<string, Live>();
  private failed = new Map<string, string>();

  /** Start every server; never throws for one bad server. */
  async start(configs: ServerConfig[], opts: { timeoutMs?: number } = {}): Promise<ServerStatus[]> {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    await Promise.all(configs.map(async (config) => {
      if (!/^[a-z0-9_-]+$/i.test(config.name)) {
        this.failed.set(config.name, `server name "${config.name}" must be [a-z0-9_-]`);
        return;
      }
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: { ...filteredEnv(), ...(config.env ?? {}) },
          ...(config.cwd ? { cwd: config.cwd } : {}),
          stderr: "pipe",
        });
        const client = new Client({ name: "mcp-chat", version: "0.1.0" }, { capabilities: {} });
        await withTimeout(client.connect(transport), timeoutMs, `connect to "${config.name}"`);
        const listed = await withTimeout(client.listTools(), timeoutMs, `tools/list on "${config.name}"`);
        const tools: ToolSpec[] = listed.tools.map((t) => ({
          name: qualify(config.name, t.name),
          description: t.description ?? "",
          inputSchema: (t.inputSchema ?? { type: "object" }) as ToolSpec["inputSchema"],
        }));
        this.live.set(config.name, { config, client, tools });
      } catch (err) {
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
  async call(call: ToolCall): Promise<ToolResult> {
    const parts = split(call.name);
    const l = parts ? this.live.get(parts.server) : undefined;
    if (!parts || !l) return { content: `no running server for tool "${call.name}"`, isError: true };
    const res = await l.client.callTool({ name: parts.tool, arguments: call.args });
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
