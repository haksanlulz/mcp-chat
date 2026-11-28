import { describe, expect, it } from "vitest";
import { checkProviderUrl, KNOWN_PROVIDER_HOSTS } from "../server/egress.js";

// App standard ALL-6: the model provider's address comes from an allowlist, checked before any request.
describe("checkProviderUrl", () => {
  it("takes the known hosted providers over https", () => {
    for (const host of KNOWN_PROVIDER_HOSTS) expect(() => checkProviderUrl(`https://${host}/v1`, "OPENAI_BASE_URL")).not.toThrow();
    expect(checkProviderUrl("https://openrouter.ai/api/v1/", "OPENAI_BASE_URL")).toBe("https://openrouter.ai/api/v1");
  });

  it("takes a local server over plain http: loopback and the tailnet", () => {
    for (const u of ["http://127.0.0.1:8080/v1", "http://localhost:11434", "http://[::1]:1234/v1", "http://100.115.101.124:8080/v1"])
      expect(() => checkProviderUrl(u, "OPENAI_BASE_URL")).not.toThrow();
  });

  it("refuses a host outside the list, and names how to add one", () => {
    expect(() => checkProviderUrl("https://evil.example/v1", "OPENAI_BASE_URL"))
      .toThrow(/OPENAI_BASE_URL.*evil\.example.*MCP_CHAT_PROVIDER_HOSTS/);
  });

  it("takes a host the operator added, and only that host", () => {
    const extra = "llm.example.org, other.example";
    expect(() => checkProviderUrl("https://llm.example.org/v1", "OPENAI_BASE_URL", extra)).not.toThrow();
    expect(() => checkProviderUrl("https://sub.llm.example.org/v1", "OPENAI_BASE_URL", extra)).toThrow();
    expect(() => checkProviderUrl("https://llm.example.org.evil.example/v1", "OPENAI_BASE_URL", extra)).toThrow();
  });

  it("refuses plain http to anything not local: the key would cross the network in clear", () => {
    expect(() => checkProviderUrl("http://openrouter.ai/api/v1", "OPENAI_BASE_URL")).toThrow(/https/);
    expect(() => checkProviderUrl("http://192.168.1.20:8080/v1", "OPENAI_BASE_URL")).toThrow();
    expect(() => checkProviderUrl("http://100.128.0.1:8080/v1", "OPENAI_BASE_URL")).toThrow();
  });

  it("refuses other schemes, credentials in the address, and what is not an address", () => {
    for (const u of ["file:///etc/passwd", "ftp://openrouter.ai/", "https://user:pw@openrouter.ai/v1", "openrouter.ai/v1", ""])
      expect(() => checkProviderUrl(u, "OPENAI_BASE_URL")).toThrow(/OPENAI_BASE_URL/);
  });
});
