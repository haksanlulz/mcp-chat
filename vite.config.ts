// vitest/config, not vite: vitest 5 types the `test` block only through its own entry.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Front end lives in web/; the agent runtime in server/ is run with tsx, not
// bundled. Vitest reads this file too, so the test block sits here rather than
// in a second config that could drift from it.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    // The runtime serves /api on 8731; the dev server proxies so the front end
    // needs no hardcoded origin.
    // POST /api/chat is a long SSE stream with silent stretches (the model is
    // prefilling a large tool result and sends no bytes). The proxy's default
    // socket timeout closed those as "network error" in the UI while the same
    // request straight to :8731 completed (2026-09-20, 841 frames in 59 s).
    // No timeout on the proxied socket; the runtime owns the request's life.
    proxy: { "/api": { target: "http://127.0.0.1:8731", timeout: 0, proxyTimeout: 0 } },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
  test: {
    root: ".",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
