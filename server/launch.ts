/**
 * `npm start`: the runtime with its model keys read from a secret store (app standard WEB-1, ASVS V13.3.1).
 *
 * MCP_CHAT_SECRET_GET is the store's read command as a JSON array; the key name is appended as its last
 * argument and the value is read from stdout. For example, with a keyring CLI:
 *
 *   MCP_CHAT_SECRET_GET='["uv","run","--script","/path/to/secret.py","get"]' npm start
 *
 * The runtime gets this process's environment minus every secret-named variable, plus only the keys the store
 * returned, so a stale key in the shell never reaches it. There is no fallback to the environment: a key the
 * store lacks is absent, and the runtime falls back to Ollama, which needs none. `npm run dev:server` still
 * reads keys from its own environment, for a clone with no store; the runtime says so when it does.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|CREDENTIALS?|COOKIE)$/;
const NOT_SECRET = /MAX_TOKENS$/;

export function isSecretName(name: string): boolean {
  const n = name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  return SECRET_NAME.test(n) && !NOT_SECRET.test(n);
}

/** The getter command, or null unless it is a non-empty JSON array of strings. */
export function parseGetter(raw: string | undefined): string[] | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0) ? v as string[] : null;
}

/** The stored value, or null. A failed launch, a non-zero exit or an empty answer is null. */
export function readKey(getter: string[], name: string, run: typeof spawnSync = spawnSync): string | null {
  try {
    const r = run(getter[0]!, [...getter.slice(1), name], { encoding: "utf-8", windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
    if (!r || r.error || r.status !== 0) return null;
    return String(r.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

export function childEnv(parent: NodeJS.ProcessEnv | Record<string, string>, keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (typeof v === "string" && !isSecretName(k)) out[k] = v;
  return { ...out, ...keys, MCP_CHAT_KEY_SOURCE: "store" };
}

function main(): void {
  const getter = parseGetter(process.env.MCP_CHAT_SECRET_GET);
  if (!getter) {
    process.stderr.write("[mcp-chat] npm start reads model keys from a secret store. Set MCP_CHAT_SECRET_GET to the store's read " +
      "command as a JSON array (the key name is appended), or run npm run dev:server to read keys from the environment.\n");
    process.exit(2);
  }
  const keys: Record<string, string> = {};
  for (const name of KEY_NAMES) { const v = readKey(getter, name); if (v) keys[name] = v; }
  process.stderr.write(`[mcp-chat] keys from the store: ${Object.keys(keys).join(", ") || "none (Ollama needs none)"}\n`);
  const entry = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry], { env: childEnv(process.env, keys), stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
