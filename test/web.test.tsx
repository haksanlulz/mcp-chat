/**
 * The web side, rendered to static markup. No DOM, no browser: react-dom/server
 * is enough to assert the one property the UI owns — a failed tool call is a
 * failed CARD, never answer text — and to pin the SSE parser the transcript
 * depends on.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallCard } from "../web/src/ToolCallCard";
import { TurnView } from "../web/src/App";
import { inline } from "../web/src/markdown";
import { sse, type ToolCallView, type Turn } from "../web/src/useChat";

const FAILED: ToolCallView = {
  id: "c1",
  name: "housing__building_violations",
  args: { house_number: "1520", street: "Sedgwick Avenue" },
  status: "error",
  result: "HPD upstream 503",
};

const OK: ToolCallView = { ...FAILED, id: "c2", status: "ok", result: '{"total":128,"record_scope":"open violations only"}' };

/** Text inside `.text` nodes only — what a reader takes as the assistant's answer. */
function answerText(html: string): string {
  return [...html.matchAll(/<div class="text[^"]*">(.*?)<\/div>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "")).join("");
}

describe("ToolCallCard", () => {
  it.each([null, [], 17, "bad"])("renders malformed argument shapes without crashing: %j", (args) => {
    const html = renderToStaticMarkup(<ToolCallCard call={{ ...FAILED, args: args as unknown as Record<string, unknown> }} />);
    expect(html).toContain('class="tool tool--error"');
    expect(html).toContain("Tool call failed");
  });
  it("RED LEG: a failed call renders as an error card that says it is not an answer", () => {
    const html = renderToStaticMarkup(<ToolCallCard call={FAILED} />);
    expect(html).toContain('class="tool tool--error"');
    expect(html).toMatch(/role="alert"[^>]*>Tool call failed[^<]*not an answer/);
    // the raw error body is collapsed, not shown as prose
    expect(html).not.toContain("HPD upstream 503");
  });

  it("an ok call renders green, with server › tool and the record_scope pulled out", () => {
    const html = renderToStaticMarkup(<ToolCallCard call={OK} />);
    expect(html).toContain('class="tool tool--ok"');
    expect(html).toContain('class="tool__server">housing</span>building_violations');
    expect(html).toContain('class="tool__scope">open violations only');
    expect(html).not.toContain('role="alert"');
  });
});

describe("TurnView", () => {
  it("RED LEG: an assistant turn whose only tool call failed carries no answer text", () => {
    const turn: Turn = { role: "assistant", parts: [{ kind: "tool", call: FAILED }], errors: [], turns: [], stoppedBy: "answer" };
    const html = renderToStaticMarkup(<TurnView turn={turn} />);
    expect(answerText(html)).toBe("");
    expect(html).toContain("tool--error");
  });

  it("RED LEG: done(cap) is announced, not silent", () => {
    const turn: Turn = { role: "assistant", parts: [{ kind: "tool", call: OK }], errors: [], turns: [], stoppedBy: "cap" };
    const html = renderToStaticMarkup(<TurnView turn={turn} />);
    expect(html).toContain("Stopped at the tool-call limit without a final answer.");
  });

  it("streamed text and cards keep arrival order", () => {
    const turn: Turn = {
      role: "assistant",
      parts: [{ kind: "text", text: "Looking that up. " }, { kind: "tool", call: OK }, { kind: "text", text: "128 open violations." }],
      errors: [],
      turns: [],
      stoppedBy: "answer",
    };
    const html = renderToStaticMarkup(<TurnView turn={turn} />);
    const a = html.indexOf("Looking that up.");
    const b = html.indexOf("tool--ok");
    const c = html.indexOf("128 open violations.");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(answerText(html)).toBe("Looking that up.128 open violations."); // paragraphs trim; the card sits between them
  });
});

describe("debug view (testbed surface)", () => {
  const TURN_INFO = { iteration: 1, messages: [{ role: "user" as const, content: "who owns 1520 Sedgwick" }], tools: ["housing__who_owns"], usage: { promptTokens: 1200, outputTokens: 40, ms: 812 }, endedWith: "tool_calls" as const, ms: 812 };

  it("RED LEG: thinking renders in its own block, never inside answer text, and only when debug is on", () => {
    const turn: Turn = { role: "assistant", parts: [{ kind: "thinking", text: "need the borough first" }, { kind: "text", text: "Bronx." }], errors: [], turns: [], stoppedBy: "answer" };
    const on = renderToStaticMarkup(<TurnView turn={turn} debug />);
    expect(on).toContain('class="thinking"');
    expect(on).toContain("need the borough first");
    expect(answerText(on)).toBe("Bronx.");
    const off = renderToStaticMarkup(<TurnView turn={turn} debug={false} />);
    expect(off).not.toContain("need the borough first");
    expect(answerText(off)).toBe("Bronx.");
  });

  it("RED LEG: each model turn shows a strip with iteration, tokens and ms, and expands to the exact prompt the model was sent", () => {
    const turn: Turn = { role: "assistant", parts: [{ kind: "tool", call: OK }], errors: [], turns: [TURN_INFO], stoppedBy: "answer" };
    const html = renderToStaticMarkup(<TurnView turn={turn} debug />);
    expect(html).toContain('class="turnstrip"');
    expect(html).toMatch(/turn 1/);
    expect(html).toMatch(/1,?200 in/);
    expect(html).toMatch(/40 out/);
    expect(html).toMatch(/812 ms/);
    expect(html).toMatch(/tool_calls/);
    // the prompt is in the document (inside a <details>), verbatim
    expect(html).toContain("who owns 1520 Sedgwick");
    expect(html).toContain("housing__who_owns");
    expect(html).toContain("<details");
  });

  it("with debug off, no strip and no prompt", () => {
    const turn: Turn = { role: "assistant", parts: [{ kind: "tool", call: OK }], errors: [], turns: [TURN_INFO], stoppedBy: "answer" };
    const html = renderToStaticMarkup(<TurnView turn={turn} debug={false} />);
    expect(html).not.toContain("turnstrip");
    expect(html).not.toContain("who owns 1520 Sedgwick");
  });
});

describe("inline emphasis", () => {
  it("RED LEG: **bold** renders as <b>, never as literal asterisks", () => {
    const html = renderToStaticMarkup(<div>{inline("owner is **WFHA 1520 SEDGWICK LP**, agent **MHR**.")}</div>);
    expect(html).toBe("<div>owner is <b>WFHA 1520 SEDGWICK LP</b>, agent <b>MHR</b>.</div>");
  });
  it("leaves an unbalanced marker alone and never opens an HTML path", () => {
    expect(renderToStaticMarkup(<div>{inline("a ** b <script>x</script>")}</div>))
      .toBe("<div>a ** b &lt;script&gt;x&lt;/script&gt;</div>");
  });
});

describe("sse", () => {
  function stream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(enc.encode(c));
        ctrl.close();
      },
    });
  }

  it("RED LEG: a frame split across two chunks is one frame, not two or none", async () => {
    const frames: unknown[] = [];
    for await (const f of sse(stream(['data: {"type":"tok', 'en","text":"hi"}\n\n', 'data: {"type":"done","stoppedBy":"answer"}\n\n'])))
      frames.push(f);
    expect(frames).toEqual([{ type: "token", text: "hi" }, { type: "done", stoppedBy: "answer" }]);
  });

  it("ignores comment and event lines, keeps multi-line data", async () => {
    const frames: unknown[] = [];
    for await (const f of sse(stream([': keepalive\nevent: x\ndata: {"a":\ndata: 1}\n\n']))) frames.push(f);
    expect(frames).toEqual([{ a: 1 }]);
  });
});
