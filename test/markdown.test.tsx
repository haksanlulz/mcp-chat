/**
 * The model's text is markdown whether the system prompt asks for it or not;
 * a local model was told "plain prose, no markdown" and answered with `###`
 * headings, `- ` bullets and `[tool](link)` pseudo-links, all shown literally
 * (2026-09-20, operator: "the site doesn't format the chat stuff well").
 * This renders the subset models actually emit, to React elements only —
 * there is still no HTML path from the model to the page.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../web/src/markdown";

const html = (s: string) => renderToStaticMarkup(<Markdown text={s} />);

describe("Markdown", () => {
  it("RED LEG: headings, bullets and bold render as elements, not literal marks", () => {
    const out = html("### Violations:\n- **Total**: 117\n- Class A: 23\n\nDone.");
    expect(out).toContain("<h3>Violations:</h3>");
    expect(out).toContain("<ul><li><b>Total</b>: 117</li><li>Class A: 23</li></ul>");
    expect(out).toContain("<p>Done.</p>");
    expect(out).not.toContain("###");
    expect(out).not.toContain("- ");
  });

  it("nested bullets and numbered lists", () => {
    const out = html("- Matched Addresses:\n  - 1520 SEDGWICK AVE (1)\n  - 1520 SEDGWICK AVENUE (12)\n1. first\n2. second");
    expect(out).toContain("<ul><li>Matched Addresses:<ul><li>1520 SEDGWICK AVE (1)</li><li>1520 SEDGWICK AVENUE (12)</li></ul></li></ul>");
    expect(out).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("RED LEG: no HTML path — angle brackets and a script tag stay text, and a link never becomes an anchor to javascript:", () => {
    const out = html("a <script>x</script> b [click](javascript:alert(1)) [ok](https://example.com/x?y=1)");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(out).not.toContain("<script");
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('<a href="https://example.com/x?y=1" target="_blank" rel="noopener noreferrer">ok</a>');
    // the refused link keeps its text, so nothing the model said disappears
    expect(out).toContain("click");
  });

  it("WEB-4: data:, vbscript: and protocol-relative links never become anchors", () => {
    const out = html("[a](data:text/html,<b>x</b>) [b](vbscript:msgbox) [c](//evil.example/x) [d](DATA:text/plain,hi)");
    expect(out).not.toMatch(/href="(data|vbscript|DATA):/);
    expect(out).not.toContain('href="//');
    for (const t of ["a", "b", "c", "d"]) expect(out).toContain(t);
  });

  // MCP security audit 2026-11-25 (lower-severity): a link's text can name one site while it points at
  // another, which is how an injected instruction smuggles data out in a query string. The real host is
  // shown beside any link whose text does not already show it.
  it("RED LEG: a link whose text hides its destination shows the real host beside it", () => {
    const out = html("Pay here: [your bank](https://evil.example/collect?d=secret)");
    expect(out).toContain('<a href="https://evil.example/collect?d=secret" target="_blank" rel="noopener noreferrer">your bank</a>');
    expect(out).toContain('<span class="link__host">(evil.example)</span>');
    // a name inside a longer name is not the host
    expect(html("[bank.example](https://mybank.example/)")).toContain('<span class="link__host">(mybank.example)</span>');
    expect(html("[mybank.example](https://bank.example/)")).toContain('<span class="link__host">(bank.example)</span>');
  });

  it("no host label when the text already shows the host, or for a bare URL", () => {
    expect(html("[example.com docs](https://example.com/a)")).not.toContain("link__host");
    expect(html("[https://www.example.com/a](https://www.example.com/a)")).not.toContain("link__host");
    expect(html("see https://example.com/a")).not.toContain("link__host");
  });

  it("the pseudo-links a model writes for tool names are shown as code, not as links", () => {
    const out = html("Tools: [building_violations](link) / [who_owns](link)");
    expect(out).toContain("<code>building_violations</code>");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("(link)");
  });

  it("inline code and fenced code, with the fence's content untouched", () => {
    const out = html("Run `npm test`.\n```json\n{ \"a\": 1 }\n```");
    expect(out).toContain("<code>npm test</code>");
    expect(out).toContain('<pre><code>{ &quot;a&quot;: 1 }\n</code></pre>');
  });

  it("paragraphs split on blank lines; single newlines inside a paragraph are kept as line breaks", () => {
    const out = html("line one\nline two\n\nnext");
    expect(out).toBe("<p>line one<br/>line two</p><p>next</p>");
  });

  it("RED LEG: a bare http(s) URL autolinks, trailing punctuation stays outside the anchor, and nothing else does", () => {
    const out = html("See https://scryfall.com/card/msc/806?utm_source=api. Also (http://example.com/a_b) and ftp://nope and www.no.com");
    expect(out).toContain('<a href="https://scryfall.com/card/msc/806?utm_source=api" target="_blank" rel="noopener noreferrer">https://scryfall.com/card/msc/806?utm_source=api</a>.');
    expect(out).toContain('<a href="http://example.com/a_b" target="_blank" rel="noopener noreferrer">http://example.com/a_b</a>)');
    expect(out).not.toContain('href="ftp:');
    expect(out).not.toContain('href="www');
    expect(out).toContain("ftp://nope");
  });

  it("a URL inside inline code or a markdown link is not double-linked", () => {
    const out = html("`https://a.example` and [x](https://b.example)");
    expect(out).toContain("<code>https://a.example</code>");
    expect((out.match(/<a /g) ?? []).length).toBe(1);
  });

  it("an unbalanced ** is left alone", () => {
    expect(html("a ** b")).toBe("<p>a ** b</p>");
  });

  it("RED LEG: *italic* and _italic_ render as <i>; a bare * or a * inside a word stays text", () => {
    expect(html("printed in *Limited Edition Alpha* (1993) and _Beta_")).toBe("<p>printed in <i>Limited Edition Alpha</i> (1993) and <i>Beta</i></p>");
    expect(html("2 * 3 = 6 and snake_case_name")).toBe("<p>2 * 3 = 6 and snake_case_name</p>");
    // bold and italic together, either nesting
    expect(html("**bold *and italic***")).toBe("<p><b>bold <i>and italic</i></b></p>");
    expect(html("*it **bold** it*")).toBe("<p><i>it <b>bold</b> it</i></p>");
  });

  it("a * that starts a line is a bullet, not italics", () => {
    expect(html("* one\n* two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });
});
