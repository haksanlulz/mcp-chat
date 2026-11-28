/**
 * App standard ALL-6: where the model provider may be reached. The address comes from the
 * environment and the API key goes with every request, so it is checked once at startup,
 * before any request is made:
 *   - https to a known hosted provider, or to a host the operator names in MCP_CHAT_PROVIDER_HOSTS;
 *   - plain http only to this machine (loopback) or the tailnet (100.64.0.0/10), where local
 *     servers (llama-server, Ollama, LM Studio) listen;
 *   - no other scheme, and no user or password inside the address.
 */
export const KNOWN_PROVIDER_HOSTS = ["api.openai.com", "openrouter.ai", "api.anthropic.com"] as const;

function isLocal(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

/** Returns the address without a trailing slash, or throws an error naming the variable and the fix. */
export function checkProviderUrl(raw: string, variable: string, extraHosts = process.env.MCP_CHAT_PROVIDER_HOSTS ?? ""): string {
  let u: URL;
  try { u = new URL(raw); }
  catch { throw new Error(`${variable}="${raw}" is not an address: give a whole URL such as https://openrouter.ai/api/v1 or http://127.0.0.1:8080/v1`); }
  if (u.username || u.password) throw new Error(`${variable} carries a user or password inside the address: remove it and pass the key in its own variable`);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${variable} uses ${u.protocol}: only https, or http to this machine or the tailnet`);
  const host = u.hostname.toLowerCase();
  if (isLocal(host)) return raw.replace(/\/+$/, "");
  if (u.protocol === "http:") throw new Error(`${variable} sends to ${host} over plain http, which would carry the key in clear: use https`);
  const allowed = new Set<string>([...KNOWN_PROVIDER_HOSTS, ...extraHosts.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);
  if (!allowed.has(host)) {
    throw new Error(`${variable} points at ${host}, which is not a known provider: if you trust it, add it to MCP_CHAT_PROVIDER_HOSTS (comma-separated host names) and start again`);
  }
  return raw.replace(/\/+$/, "");
}
