#!/usr/bin/env -S node --import tsx
/**
 * A real MCP server over stdio, for testing the manager through its real
 * channel rather than a mock. Two tools: `echo` returns its argument as text,
 * `fail` returns an isError result. Same low-level Server the civic servers
 * use, so what passes here is what passes against them.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo-fixture", version: "0.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async req => {
  if (process.env.MCP_FIXTURE_PAGES && !req.params?.cursor) return {tools:[],nextCursor:"second"};
  return { tools: [
    { name: "echo", description: "returns text back", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
    { name: "fail", description: "always returns isError", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "echo") {
    const text = String((req.params.arguments as { text?: unknown } | undefined)?.text ?? "");
    return { content: [{ type: "text", text: JSON.stringify({ echoed: text, record_scope: "a fixture, not data" }) }] };
  }
  if (req.params.name === "fail") {
    return { content: [{ type: "text", text: "fixture upstream 503" }], isError: true };
  }
  return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
});

await server.connect(new StdioServerTransport());
