/**
 * The built page (npm run build:web -> dist/web), served by the runtime so it gets the page half of app
 * standard WEB-2: a per-response nonce CSP with strict-dynamic, and Trusted Types with no policy allowed
 * (the front end builds DOM through React only; nothing writes an HTML string to a sink).
 *
 *   GET /, /index.html   index.html, every <script> tag given this response's nonce
 *   GET /assets/<file>   a file under <webDir>/assets with a known type; anything else is not served
 *
 * The Vite dev server (npm run dev:web) still serves its own page for development; its HMR needs inline
 * script, so it does not get this CSP.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function pageCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

/** Serve the page or one of its assets; false when the request is not for either (the caller 404s). */
export function serveWeb(webDir: string, method: string | undefined, pathname: string, res: ServerResponse): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname === "/" || pathname === "/index.html") {
    let html: string;
    try { html = readFileSync(resolve(webDir, "index.html"), "utf-8"); }
    catch {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no built page in ${webDir}: run npm run build:web, or use npm run dev:web` }));
      return true;
    }
    const nonce = randomBytes(18).toString("base64");
    res.setHeader("content-security-policy", pageCsp(nonce));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html.replace(/<script\b/g, `<script nonce="${nonce}"`));
    return true;
  }
  if (!pathname.startsWith("/assets/")) return false;
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  const root = resolve(webDir, "assets");
  const file = resolve(root, "." + rel.slice("/assets".length));
  if (!file.startsWith(root + sep)) return false;
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return false;
  try { if (!statSync(file).isFile()) return false; } catch { return false; }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(readFileSync(file));
  return true;
}
