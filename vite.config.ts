// vitest/config, not vite: vitest 5 types the `test` block only through its own entry.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { devPageCsp, newNonce } from "./server/web";

// Front end lives in web/; the agent runtime in server/ is run with tsx, not
// bundled. Vitest reads this file too, so the test block sits here rather than
// in a second config that could drift from it.
export default defineConfig(({ command, isPreview }) => {
  // App standard WEB-2 on the dev page (test/vite-dev-csp.test.ts): one nonce per dev-server start,
  // stamped by Vite into every script and style it serves. Never set for a build: the runtime gives the
  // built page a fresh nonce per response, and a fixed one baked into dist/web would defeat that. Not for
  // `vite preview` either: it reuses server.headers, and the built page it serves carries no nonce, so the
  // dev CSP blocked every script there (found by the WEB-5 axe run, 2026-11-27).
  const nonce = command === "serve" && !isPreview ? newNonce() : undefined;
  const csp = nonce ? devPageCsp(nonce) : undefined;
  return {
    root: "web",
    plugins: [react()],
    ...(nonce ? { html: { cspNonce: nonce } } : {}),
    server: {
      port: 5173,
      ...(csp ? { headers: { "Content-Security-Policy": csp.enforce, "Content-Security-Policy-Report-Only": csp.reportOnly } } : {}),
      // The runtime serves /api on 8731; the dev server proxies so the front end
      // needs no hardcoded origin.
      // POST /api/chat is a long SSE stream with silent stretches (the model is
      // prefilling a large tool result and sends no bytes). The proxy's default
      // socket timeout closed those as "network error" in the UI while the same
      // request straight to :8731 completed (2026-09-20, 841 frames in 59 s).
      // No timeout on the proxied socket; the runtime owns the request's life.
      proxy: { "/api": { target: `http://127.0.0.1:${process.env.MCP_CHAT_PORT ?? 8731}`, changeOrigin: false, timeout: 0, proxyTimeout: 0 } },
    },
    build: { outDir: "../dist/web", emptyOutDir: true },
    test: {
      root: ".",
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      environment: "node",
    },
  };
});
