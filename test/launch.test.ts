// App standard WEB-1, ASVS V13.3.1: `npm start` reads the model keys from a secret store through a getter
// command, and hands them to the runtime alone. The parent's own copies of secret-named variables never pass
// through, so a key cannot come from a stale environment variable by accident.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv, isSecretName, KEY_NAMES, parseGetter, readKey } from "../server/launch";

const here = fileURLToPath(new URL("..", import.meta.url));

describe("the getter command", () => {
  it("is a JSON array of strings, and anything else is refused", () => {
    expect(parseGetter('["uv","run","--script","secret.py","get"]')).toEqual(["uv", "run", "--script", "secret.py", "get"]);
    for (const bad of [undefined, "", "uv run secret.py get", "[]", '["uv", 3]', '{"cmd":"uv"}']) expect(parseGetter(bad), String(bad)).toBeNull();
  });

  it("RED LEG: gets the name as its last argument, and returns the trimmed value", () => {
    const calls: string[][] = [];
    const run = ((cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { status: 0, stdout: "sk-value\n" }; }) as unknown as typeof spawnSync;
    expect(readKey(["uv", "run", "s.py", "get"], "ANTHROPIC_API_KEY", run)).toBe("sk-value");
    expect(calls).toEqual([["uv", "run", "s.py", "get", "ANTHROPIC_API_KEY"]]);
  });

  it("RED LEG: a missing key, an empty answer or a failed launch is null, never an environment fallback", () => {
    const fails = [{ status: 1, stdout: "" }, { status: 0, stdout: "  \n" }, { status: null, stdout: "", error: new Error("ENOENT") }];
    for (const r of fails) expect(readKey(["x"], "ANTHROPIC_API_KEY", (() => r) as unknown as typeof spawnSync)).toBeNull();
    expect(readKey(["x"], "ANTHROPIC_API_KEY", (() => { throw new Error("spawn"); }) as unknown as typeof spawnSync)).toBeNull();
  });
});

describe("the runtime's environment", () => {
  it("RED LEG: secret-named variables from the parent are stripped; only the store's keys go in", () => {
    const env = childEnv({ PATH: "p", ANTHROPIC_API_KEY: "stale-env", GITHUB_TOKEN: "leak", OLLAMA_MODEL: "m", OPENAI_BASE_URL: "u" }, { OPENAI_API_KEY: "from-store" });
    expect(env).toEqual({ PATH: "p", OLLAMA_MODEL: "m", OPENAI_BASE_URL: "u", OPENAI_API_KEY: "from-store", MCP_CHAT_KEY_SOURCE: "store" });
  });

  it("the secret-name rule: suffixes, camelCase, and MAX_TOKENS is not a secret", () => {
    for (const n of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "apiKey", "AWS_SECRET"]) expect(isSecretName(n), n).toBe(true);
    for (const n of ["PATH", "OLLAMA_MAX_TOKENS", "OPENAI_BASE_URL", "ANTHROPIC_THINKING_BUDGET"]) expect(isSecretName(n), n).toBe(false);
    expect(KEY_NAMES).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  });

  it("RED LEG: npm start without a getter refuses to start, exit 2, and says what to set", () => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.MCP_CHAT_SECRET_GET;
    const r = spawnSync(process.execPath, ["--import", "tsx", "server/launch.ts"], { cwd: here, env, encoding: "utf-8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("MCP_CHAT_SECRET_GET");
  });
});
