/**
 * HTTP entry point. Three routes, no framework:
 *
 *   GET  /api/health   servers up/failed, provider, model
 *   GET  /api/tools    the qualified tool list the model sees
 *   POST /api/chat     { messages } -> text/event-stream of AgentEvent frames
 *
 * Config: mcp-chat.config.json (see mcp-chat.config.example.json). Provider is
 * chosen by env, first match wins:
 *   OPENAI_BASE_URL set    -> any OpenAI-compatible server (OPENAI_MODEL, OPENAI_API_KEY optional)
 *   ANTHROPIC_API_KEY set  -> Anthropic (ANTHROPIC_MODEL)
 *   otherwise              -> Ollama at OLLAMA_BASE_URL (default 127.0.0.1:11434) with OLLAMA_MODEL
 * MCP_CHAT_PORT overrides 8731. Binds 127.0.0.1 only; this is a local tool.
 *
 * Debug surface (this is a testbed):
 *   MCP_CHAT_THINK=1              ask Ollama for the model's reasoning (probed; models without it fall back)
 *   ANTHROPIC_THINKING_BUDGET=N   enable extended thinking on the Anthropic provider with an N-token budget
 *   MCP_CHAT_TRACE=1|<dir>        enable writing request frames to traces/<id>.jsonl
 *   GET  /api/traces              list recent traces
 *   GET  /api/trace/:id           one trace's frames
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgent, type AgentEvent, type Model } from "./agent.js";
import { parseChatBody } from "./api.js";
import { McpManager, type ServerConfig } from "./mcp.js";
import { TraceStore } from "./trace.js";
import { OllamaModel } from "./providers/ollama.js";
import { AnthropicModel } from "./providers/anthropic.js";
import { OpenAIModel } from "./providers/openai.js";

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
  const oai = process.env.OPENAI_BASE_URL;
  if (oai) {
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const apiKey = process.env.OPENAI_API_KEY;
    return {
      model: new OpenAIModel({ baseUrl: oai, model, ...(apiKey ? { apiKey } : {}), ...(cfg.system ? { system: cfg.system } : {}) }),
      label: `openai-compatible:${model} @ ${oai.replace(/^https?:\/\//, "")}`,
    };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    const budget = Number(process.env.ANTHROPIC_THINKING_BUDGET ?? 0);
    return {
      model: new AnthropicModel({ apiKey: key, model, ...(cfg.system ? { system: cfg.system } : {}), ...(budget > 0 ? { thinkingBudget: budget } : {}) }),
      label: `anthropic:${model}${budget > 0 ? ` (thinking ${budget})` : ""}`,
    };
  }
  const model = process.env.OLLAMA_MODEL ?? "qwen3-coder:30b";
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const think = process.env.MCP_CHAT_THINK === "1";
  return { model: new OllamaModel({ model, baseUrl, think, ...(cfg.system ? { system: cfg.system } : {}) }), label: `ollama:${model}${think ? " (think)" : ""}` };
}

class BadRequest extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new BadRequest(415, "Send the chat as application/json.");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new BadRequest(413, "Chat body exceeds 8 MiB.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      throw new BadRequest(413, "Chat body exceeds 8 MiB.");
    }
    chunks.push(c);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new BadRequest(400, "Send valid UTF-8 JSON."); }
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
  const traces = new TraceStore(process.env.MCP_CHAT_TRACE);
  console.error(`[mcp-chat] traces: ${traces.dir ?? "off (MCP_CHAT_TRACE=1 to enable)"}`);

  const port = Number(process.env.MCP_CHAT_PORT ?? 8731);
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) {
        return json(res, 403, { error: "Local host required." });
      }
      const origin = req.headers.origin;
      if ((origin !== undefined && origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") {
        return json(res, 403, { error: "Same-origin access required." });
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { ok: true, model: label, servers: mcp.status(), traces: traces.enabled });
      }
      if (req.method === "GET" && url.pathname === "/api/traces") {
        return json(res, 200, { enabled: traces.enabled, traces: traces.list() });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/trace/")) {
        const frames = traces.read(url.pathname.slice("/api/trace/".length));
        return frames ? json(res, 200, { frames }) : json(res, 404, { error: "no such trace" });
      }
      if (req.method === "GET" && url.pathname === "/api/tools") {
        return json(res, 200, { tools: mcp.tools() });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const parsed = parseChatBody(await readJson(req));
        if (!parsed.ok) return json(res, 400, { error: parsed.error });
        const last = parsed.messages[parsed.messages.length - 1]!;
        const trace = traces.begin({ model: label, messages: parsed.messages.length, question: last.content.slice(0, 200) });
        const controller = new AbortController();
        res.once("close", () => { if (!res.writableEnded) controller.abort(); });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...(trace ? { "x-mcp-chat-trace": trace.id } : {}),
        });
        res.flushHeaders();
        const emit = (e: AgentEvent) => {
          trace?.write(e);
          if (!res.destroyed) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        await runAgent({
          model, tools: mcp.tools(), messages: parsed.messages, emit,
          signal: controller.signal,
          callTool: (c) => mcp.call(c, controller.signal),
          ...(cfg.maxIterations ? { maxIterations: cfg.maxIterations } : {}),
        });
        return res.end();
      }
      json(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : `non-Error value (${typeof err})`;
      if (res.destroyed) return;
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ type: "done", iterations: 0, stoppedBy: "error" })}\n\n`);
        res.end();
      } else {
        json(res, err instanceof BadRequest ? err.status : 500, { error: message });
      }
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.error(`[mcp-chat] http://127.0.0.1:${address.port}`);
  });

  const stop = async () => { await mcp.stop(); server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`[mcp-chat] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
