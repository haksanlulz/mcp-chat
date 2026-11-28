// App standard WEB-2 on the dev page: the Vite dev server sends a nonce CSP too, so a page that only works
// with inline script or eval fails in development, not first in the built page. The nonce is per dev-server
// start (Vite stamps one value into every page it serves), never baked into the build: the runtime gives the
// built page a fresh nonce per response (server/web.ts), and a fixed one in dist/web would defeat it.
import { describe, expect, it } from "vitest";
import config from "../vite.config";

type Env = { command: "serve" | "build"; mode: string };
const resolve = (env: Env) => (typeof config === "function" ? (config as (e: Env) => any)(env) : config) as any;

describe("vite dev page CSP", () => {
  it("serve: one nonce, stamped into the page and named in the CSP header", () => {
    const c = resolve({ command: "serve", mode: "development" });
    const nonce: string = c.html?.cspNonce;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const csp: string = c.server?.headers?.["Content-Security-Policy"];
    for (const part of [
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      `style-src 'self' 'nonce-${nonce}'`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ]) expect(csp).toContain(part);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("serve: Trusted Types is reported, not enforced (Vite's error overlay writes innerHTML)", () => {
    const c = resolve({ command: "serve", mode: "development" });
    expect(c.server.headers["Content-Security-Policy"]).not.toContain("require-trusted-types-for");
    expect(c.server.headers["Content-Security-Policy-Report-Only"]).toContain("require-trusted-types-for 'script'");
  });

  it("serve: a new nonce per dev-server start", () => {
    const a = resolve({ command: "serve", mode: "development" }).html.cspNonce;
    const b = resolve({ command: "serve", mode: "development" }).html.cspNonce;
    expect(a).not.toBe(b);
  });

  it("build: no nonce baked into dist/web", () => {
    const c = resolve({ command: "build", mode: "production" });
    expect(c.html?.cspNonce).toBeUndefined();
  });
});
