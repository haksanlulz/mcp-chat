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

  it("an unbalanced ** is left alone", () => {
    expect(html("a ** b")).toBe("<p>a ** b</p>");
  });
});
