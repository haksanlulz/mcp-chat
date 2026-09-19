/**
 * HTTP entry point. Three routes, no framework:
 *
 *   GET  /api/health   servers up/failed, provider, model
 *   GET  /api/tools    the qualified tool list the model sees
 *   POST /api/chat     { messages } -> text/event-stream of AgentEvent frames
 *
 * Config: mcp-chat.config.json (see mcp-chat.config.example.json). Provider is
 * chosen by env: ANTHROPIC_API_KEY set -> Anthropic; otherwise Ollama at
 * OLLAMA_BASE_URL (default 127.0.0.1:11434) with OLLAMA_MODEL. MCP_CHAT_PORT
 * overrides 8731. Binds 127.0.0.1 only; this is a local tool.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgent, type AgentEvent, type Model } from "./agent.js";
import { parseChatBody } from "./api.js";
import { McpManager, type ServerConfig } from "./mcp.js";
import { OllamaModel } from "./providers/ollama.js";
import { AnthropicModel } from "./providers/anthropic.js";

type Config = { servers: ServerConfig[]; system?: string; maxIterations?: number };

function loadConfig(): Config {
  const path = resolve(process.env.MCP_CHAT_CONFIG ?? "mcp-chat.config.json");
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); }
  catch { throw new Error(`no config at ${path} — copy mcp-chat.config.example.json to mcp-chat.config.json`); }
  const cfg = JSON.parse(raw) as Config;
  if (!Array.isArray(cfg.servers)) throw new Error(`${path}: "servers" must be an array`);
  return cfg;
}

function pickModel(cfg: Config): { model: Model; label: string } {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    return { model: new AnthropicModel({ apiKey: key, model, ...(cfg.system ? { system: cfg.system } : {}) }), label: `anthropic:${model}` };
  }
  const model = process.env.OLLAMA_MODEL ?? "qwen3-coder:30b";
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  return { model: new OllamaModel({ model, baseUrl }), label: `ollama:${model}` };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const mcp = new McpManager();
  const status = await mcp.start(cfg.servers);
  for (const s of status) console.error(`[mcp-chat] ${s.name}: ${s.state}${s.state === "up" ? ` (${s.tools} tools)` : ` — ${s.error}`}`);
  const { model, label } = pickModel(cfg);
  console.error(`[mcp-chat] model: ${label}`);

  const port = Number(process.env.MCP_CHAT_PORT ?? 8731);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, model: label, servers: mcp.status() });
      }
      if (req.method === "GET" && url.pathname === "/api/tools") {
        return json(res, 200, { tools: mcp.tools() });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const parsed = parseChatBody(await readJson(req));
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const emit = (e: AgentEvent) => { res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); };
        await runAgent({
          model, tools: mcp.tools(), messages: parsed.messages, emit,
          callTool: (c) => mcp.call(c),
          ...(cfg.maxIterations ? { maxIterations: cfg.maxIterations } : {}),
        });
        return res.end();
      }
      json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : `non-Error value (${typeof err})`;
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ type: "done", iterations: 0, stoppedBy: "error" })}\n\n`);
        res.end();
      } else {
        json(res, 500, { error: message });
      }
    }
  });
  server.listen(port, "127.0.0.1", () => console.error(`[mcp-chat] http://127.0.0.1:${port}`));

  const stop = async () => { await mcp.stop(); server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`[mcp-chat] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
