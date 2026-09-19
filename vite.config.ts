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
    proxy: { "/api": "http://127.0.0.1:8731" },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
  test: {
    root: ".",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
