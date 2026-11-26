// The example config is what a new user copies, so its mistakes become theirs.
// MCP security audit 2026-11-25 (#12): it ran each server as an unpinned
// `npx -y <package>`, which installs and runs whatever version is newest on npm
// at that moment. Pinned here, so a later publish is a choice, not a surprise.
// Also guards a slip in 44a0193: "readOnly" written inside "env" for two
// servers, where it is an environment variable and vouches for nothing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = fileURLToPath(new URL("../mcp-chat.config.example.json", import.meta.url));
const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
  servers: { name: string; command: string; args?: string[]; env?: Record<string, unknown>; readOnly?: unknown }[];
};

describe("mcp-chat.config.example.json", () => {
  it("has servers", () => {
    expect(cfg.servers.length).toBeGreaterThan(0);
  });

  for (const s of cfg.servers) {
    it(`${s.name}: every env value is a string, and readOnly is not one of them`, () => {
      for (const [k, v] of Object.entries(s.env ?? {})) {
        expect(typeof v, `${s.name}.env.${k}`).toBe("string");
        expect(k).not.toBe("readOnly");
      }
    });

    it(`${s.name}: readOnly, when set, is a boolean on the server`, () => {
      if ("readOnly" in s) expect(typeof s.readOnly).toBe("boolean");
    });

    if (s.command === "npx") {
      it(`${s.name}: the npm package is pinned to an exact version`, () => {
        const pkg = (s.args ?? []).find((a) => !a.startsWith("-"));
        expect(pkg, `${s.name} has no package argument`).toBeDefined();
        // @scope/name@1.2.3 or name@1.2.3: an exact version, no range, no tag
        expect(pkg).toMatch(/^(@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+$/);
      });
    }
  }
});
