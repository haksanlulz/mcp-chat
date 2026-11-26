/**
 * The markdown subset models actually emit, rendered to React elements.
 * Headings, bullet and numbered lists (nested by indent), paragraphs, fenced
 * and inline code, **bold**, and [text](url) links to http(s) only. Nothing
 * else: no raw HTML ever reaches the page, because every string here becomes
 * a text node. A refused link keeps its text. Kept small on purpose — a
 * dependency here would be the second one in the runtime, for a formatter.
 */
import type { ReactNode } from "react";

type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; lines: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] };

type ListItem = { text: string; children?: Block[] };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const FENCE = /^```\s*(\S*)\s*$/;

export function parse(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines: string[], baseIndent: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i]!), i++;
      i++; // closing fence (or EOF)
      out.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") + (body.length ? "\n" : "") });
      continue;
    }

    const h = HEADING.exec(line.trim());
    if (h) { out.push({ kind: "h", level: h[1]!.length, text: h[2]! }); i++; continue; }

    const li = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (li && indentOf(line) >= baseIndent) {
      const ordered = !BULLET.test(line);
      const indent = indentOf(line);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? NUMBERED.exec(l) : BULLET.exec(l);
        if (!m || indentOf(l) !== indent) {
          // a deeper-indented run belongs to the previous item
          if (items.length && l.trim() && indentOf(l) > indent) {
            const sub: string[] = [];
            while (i < lines.length && (indentOf(lines[i]!) > indent || !lines[i]!.trim())) {
              if (!lines[i]!.trim() && (i + 1 >= lines.length || indentOf(lines[i + 1]!) <= indent)) break;
              sub.push(lines[i]!); i++;
            }
            items[items.length - 1]!.children = parseBlocks(sub, indent + 1);
            continue;
          }
          break;
        }
        items.push({ text: m[2]! });
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }

    // paragraph: consecutive non-blank lines that start no other block
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim() || HEADING.test(l.trim()) || FENCE.test(l.trim()) || BULLET.test(l) || NUMBERED.test(l)) break;
      para.push(l.trim()); i++;
    }
    out.push({ kind: "p", lines: para });
  }
  return out;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// ---- inline ---------------------------------------------------------------

// Order matters: code and [text](url) are matched before a bare URL so a URL
// inside either is never linked twice. A bare URL stops at whitespace; the
// trailing punctuation a sentence leaves on it (".", ")", ",") is peeled off
// below so the anchor ends where the URL does.
//
// Emphasis: `**bold**`, `*italic*` and `_italic_`. Bold is matched before
// italic so `**x**` is never read as an empty italic wrapping `*x*`, and the
// contents of either are parsed again so `**bold *and italic***` nests. A
// single `*` or `_` that is not closed on the same line, or that sits inside a
// word (`snake_case`, `2 * 3`), stays text: the italic delimiters must open
// after a non-word character and close before one.
const INLINE = /(`[^`]+`)|(\*\*(.+?)\*\*(?!\*))|(\[([^\]]+)\]\(([^)\s]+)\))|(https?:\/\/[^\s<]+)|(?<![\w*])\*(?!\s)((?:[^*]|\*\*)+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_]+?)(?<!\s)_(?![\w_])/g;
const TRAILING = /[.,;:!?)\]]+$/;

// A link's text can name one site while it points at another; an injected instruction uses that to send
// data out in a query string (MCP security audit 2026-11-25). The real host is shown beside any link whose
// text does not already show it, as a whole name (so "mybank.example" does not pass for "bank.example").
function hostOf(href: string): string | undefined {
  try { return new URL(href).host.toLowerCase() || undefined; } catch { return undefined; }
}
function showsHost(text: string, host: string): boolean {
  const t = text.toLowerCase();
  for (const h of new Set([host, host.replace(/^www\./, "")])) {
    for (let i = t.indexOf(h); i !== -1; i = t.indexOf(h, i + 1)) {
      if (!/[a-z0-9.-]/.test(t[i - 1] ?? "") && !/[a-z0-9-]/.test(t[i + h.length] ?? "")) return true;
    }
  }
  return false;
}

/** Inline markdown -> nodes. Bold, italic, code, links; everything else is text. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, bold, boldInner, , linkText, href, bare, starInner, underInner] = m;
    if (bare) {
      const trail = TRAILING.exec(bare)?.[0] ?? "";
      const url = trail ? bare.slice(0, -trail.length) : bare;
      out.push(<a key={k++} href={url} target="_blank" rel="noopener noreferrer">{url}</a>);
      if (trail) out.push(trail);
    }
    else if (code) out.push(<code key={k++}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<b key={k++}>{inline(boldInner ?? "")}</b>);
    else if (starInner !== undefined || underInner !== undefined) out.push(<i key={k++}>{inline(starInner ?? underInner ?? "")}</i>);
    else if (linkText !== undefined && href !== undefined) {
      if (/^https?:\/\//i.test(href)) {
        out.push(<a key={k++} href={href} target="_blank" rel="noopener noreferrer">{linkText}</a>);
        const host = hostOf(href);
        if (host && !showsHost(linkText, host)) out.push(<span key={k++} className="link__host">({host})</span>);
      }
      // models write [tool_name](link) for a tool they mean, not a URL: show the name as code
      else if (/^[a-z0-9_]+$/i.test(linkText)) out.push(<code key={k++}>{linkText}</code>);
      else out.push(linkText);
    } else out.push(whole);
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---- render ---------------------------------------------------------------

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.kind) {
      case "h": {
        const level = Math.min(Math.max(b.level, 1), 6);
        const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        return <Tag key={i}>{inline(b.text)}</Tag>;
      }
      case "code":
        return <pre key={i}><code>{b.text}</code></pre>;
      case "list": {
        const items = b.items.map((it, j) => (
          <li key={j}>{inline(it.text)}{it.children ? renderBlocks(it.children) : null}</li>
        ));
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
      case "p":
        return (
          <p key={i}>
            {b.lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l)] : inline(l)))}
          </p>
        );
    }
  });
}

export function Markdown({ text }: { text: string }) {
  return <>{renderBlocks(parse(text))}</>;
}
