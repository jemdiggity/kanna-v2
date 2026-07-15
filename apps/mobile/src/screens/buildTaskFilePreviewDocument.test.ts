import { describe, expect, it } from "vitest";
import {
  buildTaskFilePreviewDocument,
  prepareTaskFileMarkdown
} from "./buildTaskFilePreviewDocument";

describe("buildTaskFilePreviewDocument", () => {
  it("renders Markdown headings, fenced code, and tables", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/spec.md",
      content: [
        "# Heading",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| answer | 42 |"
      ].join("\n"),
      mode: "rendered"
    });

    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain('<code class="language-ts">const answer = 42;');
    expect(html).toContain("<table>");
    expect(html).toContain("<td>answer</td>");
  });

  it("reuses a prepared Markdown result only for its exact source", () => {
    const preparedMarkdown = prepareTaskFileMarkdown("# Prepared");
    expect(preparedMarkdown).not.toBeNull();

    const preparedHtml = buildTaskFilePreviewDocument({
      path: "docs/spec.md",
      content: "# Prepared",
      mode: "rendered",
      preparedMarkdown
    });
    expect(preparedHtml).toContain("<h1>Prepared</h1>");

    const mismatchedHtml = buildTaskFilePreviewDocument({
      path: "docs/spec.md",
      content: "# Different",
      mode: "rendered",
      preparedMarkdown
    });
    expect(mismatchedHtml).toContain('<pre class="raw"># Different</pre>');
    expect(mismatchedHtml).not.toContain("<h1>Prepared</h1>");
  });

  it("disables raw HTML in rendered Markdown", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/spec.md",
      content: "<table><tr><td>unsafe</td></tr></table>",
      mode: "rendered"
    });

    expect(html).toContain("&lt;table&gt;");
    expect(html).not.toContain("<table><tr>");
  });

  it("renders explicit Markdown links as inert and leaves bare URLs as text", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/spec.md",
      content: [
        "[blank](about:blank)",
        "",
        "[web](https://example.com)",
        "",
        "https://linkified.example"
      ].join("\n"),
      mode: "rendered"
    });

    expect(html).toContain("<a>blank</a>");
    expect(html).toContain("<a>web</a>");
    expect(html).toContain("https://linkified.example");
    expect(html).not.toContain("<a>https://linkified.example</a>");
    expect(html).not.toMatch(/<a[^>]*\bhref=/i);
    expect(html).not.toMatch(/<a[^>]*\btarget=/i);
  });

  it("keeps a maximum-size email-heavy document out of linkification", () => {
    const content = "a@b.co "
      .repeat(Math.ceil((128 * 1024) / 7))
      .slice(0, 128 * 1024);
    const html = buildTaskFilePreviewDocument({
      path: "docs/emails.md",
      content,
      mode: "rendered"
    });

    expect(html).toContain('<main class="markdown"><p>a@b.co');
    expect(html).not.toContain("<a>");
    expect(html.length).toBeLessThan(content.length + 10_000);
  });

  it("falls back to constant-complexity raw source for oversized rendered Markdown", () => {
    const content = "x".repeat(128 * 1024 + 1);
    const html = buildTaskFilePreviewDocument({
      path: "docs/large-spec.md",
      content,
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
    expect(html.length).toBeLessThan(content.length + 10_000);
  });

  it("falls back before rendering highly fragmented Markdown", () => {
    const content = "x\n\n".repeat(2_501);
    const html = buildTaskFilePreviewDocument({
      path: "docs/fragmented-spec.md",
      content,
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
  });

  it("counts carriage-return line endings in the fragmentation limit", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/carriage-returns.md",
      content: "x\r\r".repeat(2_501),
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
  });

  it("falls back before rendering token-heavy single-line Markdown", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/inline-heavy.md",
      content: "*x* ".repeat(4_000),
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
  });

  it("preflights table delimiters before parsing a wide Markdown table", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/wide-table.md",
      content: `${"|x".repeat(10_001)}\n${"|-".repeat(10_001)}`,
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
  });

  it("preflights entity delimiters before Markdown entity expansion", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/entities.md",
      content: "&amp;".repeat(10_001),
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
  });

  it("escapes every HTML-sensitive character in the displayed path", () => {
    const html = buildTaskFilePreviewDocument({
      path: `docs/&<>"'.md`,
      content: "safe",
      mode: "rendered"
    });

    expect(html).toContain("docs/&amp;&lt;&gt;&quot;&#39;.md");
    expect(html).not.toContain(`docs/&<>"'.md`);
  });

  it("escapes raw source without expanding every line into a DOM node", () => {
    const html = buildTaskFilePreviewDocument({
      path: "src/file.ts",
      content: "first\n<script>alert(1)</script>\nthird",
      mode: "raw"
    });

    expect(html).toContain("first\n&lt;script&gt;alert(1)&lt;/script&gt;\nthird");
    expect(html).not.toContain("data-line=");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("preserves blank and trailing raw source lines without wrapper spans", () => {
    const html = buildTaskFilePreviewDocument({
      path: "notes.txt",
      content: "first\n\n",
      mode: "raw"
    });

    expect(html).toContain('<pre class="raw">first\n\n</pre>');
    expect(html).not.toContain("data-line=");
  });

  it("scrolls to and highlights an exact positive raw line", () => {
    const html = buildTaskFilePreviewDocument({
      path: "src/file.ts",
      content: "first\nsecond\nthird",
      mode: "raw",
      initialLine: 2
    });

    expect(html).toContain('querySelector(\'[data-line="2"]\')');
    expect(html).toContain('scrollIntoView({ block: "center" })');
    expect(html).toContain('classList.add("line-flash")');
    expect(html).toContain(
      'first\n<span class="raw-line" data-line="2">second</span>\nthird'
    );
    expect(html.match(/<span class="raw-line" data-line="\d+"/g)).toEqual([
      '<span class="raw-line" data-line="2"'
    ]);
  });

  it("keeps worst-case newline-heavy files at constant DOM complexity", () => {
    const content = "\n".repeat(1024 * 1024);
    const html = buildTaskFilePreviewDocument({
      path: "logs/newlines.txt",
      content,
      mode: "raw",
      initialLine: 524_288
    });

    expect(html.match(/<span\b/g)).toHaveLength(1);
    expect(html.match(/<span class="raw-line" data-line=/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(content.length + 10_000);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])(
    "omits line-targeting script for invalid initial line %s",
    (initialLine) => {
      const html = buildTaskFilePreviewDocument({
        path: "src/file.ts",
        content: "first\nsecond",
        mode: "raw",
        initialLine
      });

      expect(html).not.toContain("scrollIntoView");
      expect(html).not.toContain("querySelector('[data-line=");
    }
  );

  it("uses a restrictive content security policy", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/spec.md",
      content: "[external](https://example.com)",
      mode: "rendered"
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("navigate-to 'none'");
  });
});
