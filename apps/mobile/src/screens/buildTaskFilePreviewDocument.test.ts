import { describe, expect, it } from "vitest";
import {
  buildTaskFilePreviewDocument,
  prepareTaskFileMarkdown
} from "./buildTaskFilePreviewDocument";

function contentBetween(html: string, start: string, end: string): string {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Expected document to contain ${start}...${end}`);
  }
  return html.slice(startIndex + start.length, endIndex);
}

function rawContent(html: string): string {
  return contentBetween(html, '<pre class="raw">', "</pre>");
}

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
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
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
    expect(rawContent(mismatchedHtml)).toContain("# Different");
    expect(rawContent(mismatchedHtml)).toContain("hljs-section");
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
    const content = "*x* ".repeat(4_000);
    const html = buildTaskFilePreviewDocument({
      path: "docs/inline-heavy.md",
      content,
      mode: "rendered"
    });

    expect(html).toContain('<pre class="raw">');
    expect(html).not.toContain('<main class="markdown">');
    expect(rawContent(html)).not.toContain("<span");
    expect(rawContent(html).length).toBeLessThan(content.length + 10_000);
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

    expect(rawContent(html)).toContain("first\n&lt;script&gt;");
    expect(rawContent(html)).toContain("&lt;/script&gt;\nthird");
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

    expect(html).toContain("document.createTreeWalker");
    expect(html).toContain("document.createRange");
    expect(html).toContain('scrollIntoView({ block: "center" })');
    expect(html).toContain('classList.add("line-flash")');
    expect(rawContent(html)).toBe("first\nsecond\nthird");
    expect(html).not.toContain('<span class="raw-line" data-line="2">');
  });

  it.each([
    ["LF", "first\nsecond\nthird"],
    ["CRLF", "first\r\nsecond\r\nthird"],
    ["bare CR", "first\rsecond\rthird"]
  ])(
    "preserves raw source separated by %s while targeting its line",
    (_label, content) => {
      const html = buildTaskFilePreviewDocument({
        path: "src/file.ts",
        content,
        mode: "raw",
        initialLine: 2
      });

      expect(rawContent(html)).toBe(content);
      expect(html).toContain("const targetLine = 2");
      expect(html).toContain("document.createRange");
    }
  );

  it("keeps worst-case newline-heavy files at constant DOM complexity", () => {
    const content = "\n".repeat(1024 * 1024);
    const html = buildTaskFilePreviewDocument({
      path: "logs/newlines.txt",
      content,
      mode: "raw",
      initialLine: 524_288
    });

    expect(rawContent(html)).toBe(content);
    expect(rawContent(html)).not.toContain("<span");
    expect(html).toContain('document.createElement("span")');
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

describe("mobile file syntax highlighting", () => {
  it("highlights a raw TypeScript file from its path", () => {
    const html = buildTaskFilePreviewDocument({
      path: "src/example.ts",
      content: "const answer: number = 42;",
      mode: "raw"
    });

    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toMatch(/<span class="hljs-(?:built_in|type)">number<\/span>/);
  });

  it("uses Python-compatible highlighting for Bazel files", () => {
    const html = buildTaskFilePreviewDocument({
      path: "BUILD.bazel",
      content: "def build_rule(ctx):\n    return ctx.files.srcs",
      mode: "raw"
    });

    expect(html).toContain('<span class="hljs-keyword">def</span>');
  });

  it("highlights supported fenced code in rendered Markdown", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/example.md",
      content: "```ts\nconst answer = 42;\n```",
      mode: "rendered"
    });

    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("keeps unknown raw files escaped and unhighlighted", () => {
    const html = buildTaskFilePreviewDocument({
      path: "notes.unknown",
      content: '<script data-value="unsafe">alert(1)</script>',
      mode: "raw"
    });

    expect(html).toContain(
      '&lt;script data-value=&quot;unsafe&quot;&gt;alert(1)&lt;/script&gt;'
    );
    expect(rawContent(html)).not.toContain("hljs-");
    expect(html).not.toContain('<script data-value="unsafe">');
  });

  it("keeps unknown Markdown fences escaped and unhighlighted", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/example.md",
      content: "```unknown-language\n<tag>\n```",
      mode: "rendered"
    });

    expect(html).toContain("&lt;tag&gt;");
    const fence = contentBetween(
      html,
      '<code class="language-unknown-language">',
      "</code>"
    );
    expect(fence).not.toContain("hljs-");
  });

  it("keeps oversized supported files escaped and unhighlighted", () => {
    const content = `const value = 1;\n${"x".repeat(256 * 1024)}`;
    const html = buildTaskFilePreviewDocument({
      path: "src/large.ts",
      content,
      mode: "raw"
    });

    expect(html).toContain("const value = 1;");
    expect(rawContent(html)).not.toContain("hljs-");
    expect(html.length).toBeLessThan(content.length + 10_000);
  });

  it("targets an exact highlighted line through a DOM Range", () => {
    const html = buildTaskFilePreviewDocument({
      path: "src/example.ts",
      content: "const first = 1;\nconst second = 2;",
      mode: "raw",
      initialLine: 2
    });

    expect(html).toContain("document.createTreeWalker");
    expect(html).toContain("document.createRange");
    expect(html).toContain("range.getBoundingClientRect()");
    expect(html).toContain("Number.isFinite(computedLineHeight)");
    expect(html).not.toContain("range.extractContents()");
    expect(html).toContain('line.classList.add("line-flash")');
    expect(html).not.toContain('<span class="raw-line" data-line="2">');
  });
});
