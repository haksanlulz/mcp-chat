/**
 * Request parsing for POST /api/chat, kept pure so it can be tested without a
 * socket. The client sends the human-readable transcript only; `tool` turns
 * are built inside one request by the loop and never accepted from outside —
 * a client that could inject a "tool" message could forge a tool result.
 */
import type { Message } from "./agent.js";

export type ChatMessage = Extract<Message, { role: "user" | "assistant" }>;

const MAX_MESSAGES = 200;
const MAX_CONTENT = 32_000;

export type Parsed = { ok: true; messages: ChatMessage[] } | { ok: false; error: string };

export function parseChatBody(body: unknown): Parsed {
  const shape = 'body must be { messages: [{ role: "user" | "assistant", content: string }, ...] } with at least one message';
  if (!body || typeof body !== "object" || !("messages" in body)) return { ok: false, error: shape };
  const raw = (body as { messages: unknown }).messages;
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: shape };
  if (raw.length > MAX_MESSAGES) return { ok: false, error: `at most ${MAX_MESSAGES} messages per request` };
  const messages: ChatMessage[] = [];
  for (const [i, m] of raw.entries()) {
    if (!m || typeof m !== "object") return { ok: false, error: `messages[${i}]: ${shape}` };
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return { ok: false, error: `messages[${i}].role must be "user" or "assistant", got ${JSON.stringify(role)}` };
    if (typeof content !== "string") return { ok: false, error: `messages[${i}].content must be a string` };
    if (content.length > MAX_CONTENT) return { ok: false, error: `messages[${i}].content exceeds ${MAX_CONTENT} characters` };
    messages.push({ role, content });
  }
  const last = messages[messages.length - 1]!;
  if (last.role !== "user") return { ok: false, error: "the last message must be from the user" };
  return { ok: true, messages };
}
