import MarkdownIt from "markdown-it";
import {
  escapeTaskFileHtml,
  highlightMarkdownFence,
  highlightTaskFileSource
} from "./taskFileSyntaxHighlight";

export type TaskFilePreviewMode = "rendered" | "raw";

export const MAX_RENDERED_MARKDOWN_CHARACTERS = 128 * 1024;
export const MAX_RENDERED_MARKDOWN_LINES = 5_000;
export const MAX_RENDERED_MARKDOWN_MARKERS = 10_000;
export const MAX_RENDERED_MARKDOWN_TOKENS = 10_000;

const preparedMarkdownBrand = Symbol("prepared-task-file-markdown");

export interface PreparedTaskFileMarkdown {
  readonly [preparedMarkdownBrand]: true;
  readonly html: string;
  readonly source: string;
}

interface TaskFilePreviewDocumentOptions {
  path: string;
  content: string;
  mode: TaskFilePreviewMode;
  initialLine?: number;
  preparedMarkdown?: PreparedTaskFileMarkdown | null;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  highlight(content, info) {
    return highlightMarkdownFence(content, info);
  }
});

type MarkdownTokens = ReturnType<typeof markdown.parse>;

interface ParsedMarkdown {
  environment: Record<string, unknown>;
  tokens: MarkdownTokens;
}

function parseTaskFileMarkdown(content: string): ParsedMarkdown | null {
  if (content.length > MAX_RENDERED_MARKDOWN_CHARACTERS) return null;

  let lineCount = 1;
  let markerCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      lineCount += 1;
      if (lineCount > MAX_RENDERED_MARKDOWN_LINES) return null;
      continue;
    }

    if (
      character === "*" ||
      character === "_" ||
      character === "`" ||
      character === "[" ||
      character === "]" ||
      character === "&" ||
      character === "<" ||
      character === ">" ||
      character === "~" ||
      character === "\\" ||
      character === "|"
    ) {
      markerCount += 1;
      if (markerCount > MAX_RENDERED_MARKDOWN_MARKERS) return null;
    }
  }

  try {
    const environment: Record<string, unknown> = {};
    const tokens = markdown.parse(content, environment);
    const pending = [...tokens];
    let tokenCount = 0;

    while (pending.length > 0) {
      const token = pending.pop()!;
      tokenCount += 1;
      if (tokenCount > MAX_RENDERED_MARKDOWN_TOKENS) return null;
      if (token.children) pending.push(...token.children);
    }

    return { environment, tokens };
  } catch {
    return null;
  }
}

export function prepareTaskFileMarkdown(
  content: string
): PreparedTaskFileMarkdown | null {
  const parsed = parseTaskFileMarkdown(content);
  if (!parsed) return null;

  try {
    const html = markdown.renderer.render(
      parsed.tokens,
      markdown.options,
      parsed.environment
    );
    return Object.freeze({
      [preparedMarkdownBrand]: true as const,
      html,
      source: content
    });
  } catch {
    return null;
  }
}

markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const hrefIndex = tokens[index].attrIndex("href");
  if (hrefIndex >= 0) {
    tokens[index].attrs?.splice(hrefIndex, 1);
  }
  return renderer.renderToken(tokens, index, options);
};

function buildRawContent(content: string, path: string): string {
  return highlightTaskFileSource(content, path);
}

function buildLineTargetScript(mode: TaskFilePreviewMode, initialLine?: number): string {
  if (
    mode !== "raw" ||
    !Number.isInteger(initialLine) ||
    (initialLine ?? 0) <= 0
  ) {
    return "";
  }

  return `<script>
    (() => {
      const root = document.querySelector(".raw");
      if (!root) return;
      const targetLine = ${initialLine};
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let currentLine = 1;
      let startNode = null;
      let startOffset = 0;
      let endNode = null;
      let endOffset = 0;
      let node;

      outer: while ((node = walker.nextNode())) {
        const text = node.data;
        for (let offset = 0; offset < text.length; offset += 1) {
          if (currentLine === targetLine && startNode === null) {
            startNode = node;
            startOffset = offset;
          }
          if (text[offset] !== "\\n" && text[offset] !== "\\r") continue;
          if (currentLine === targetLine) {
            endNode = node;
            endOffset = offset;
            break outer;
          }
          if (text[offset] === "\\r" && text[offset + 1] === "\\n") offset += 1;
          currentLine += 1;
          if (currentLine === targetLine) {
            startNode = node;
            startOffset = offset + 1;
            endNode = node;
            endOffset = offset + 1;
          }
        }
        if (currentLine === targetLine && startNode !== null) {
          endNode = node;
          endOffset = text.length;
        }
      }

      if (startNode === null || endNode === null) return;
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      let bounds = range.getBoundingClientRect();
      let anchor = null;
      if (bounds.height === 0) {
        anchor = document.createElement("span");
        anchor.textContent = "\u200b";
        range.insertNode(anchor);
        bounds = anchor.getBoundingClientRect();
      }

      const rootBounds = root.getBoundingClientRect();
      const computedLineHeight = parseFloat(getComputedStyle(root).lineHeight);
      const minimumHeight = Number.isFinite(computedLineHeight)
        ? computedLineHeight
        : bounds.height || 1;
      const line = document.createElement("span");
      line.className = "raw-line";
      line.dataset.line = String(targetLine);
      line.setAttribute("aria-hidden", "true");
      line.style.height = Math.max(bounds.height, minimumHeight) + "px";
      line.style.top = bounds.top - rootBounds.top + "px";
      root.appendChild(line);
      if (anchor) anchor.remove();
      line.scrollIntoView({ block: "center" });
      line.classList.add("line-flash");
      setTimeout(() => line.classList.remove("line-flash"), 1600);
    })();
  </script>`;
}

export function buildTaskFilePreviewDocument({
  path,
  content,
  mode,
  initialLine,
  preparedMarkdown
}: TaskFilePreviewDocumentOptions): string {
  const renderedMarkdown =
    mode !== "rendered"
      ? null
      : preparedMarkdown === undefined
        ? prepareTaskFileMarkdown(content)
        : preparedMarkdown?.[preparedMarkdownBrand] === true &&
            preparedMarkdown.source === content
          ? preparedMarkdown
          : null;
  const effectiveMode =
    mode === "rendered" && renderedMarkdown !== null ? "rendered" : "raw";
  const body =
    renderedMarkdown !== null
      ? `<main class="markdown">${renderedMarkdown.html}</main>`
      : `<pre class="raw">${buildRawContent(content, path)}</pre>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: #050b14; color: #d7e2f0; }
    body {
      padding: 18px 18px 40px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .document-path {
      margin: 0 0 18px;
      color: #8292a9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    h1, h2, h3, h4, h5, h6 { color: #f4f8ff; line-height: 1.25; margin: 1.35em 0 0.55em; }
    h1 { font-size: 1.8rem; }
    h2 { border-bottom: 1px solid #24344d; font-size: 1.45rem; padding-bottom: 0.3em; }
    h3 { font-size: 1.2rem; }
    p, ul, ol, pre, table, blockquote { margin: 0 0 1em; }
    ul, ol { padding-left: 1.55em; }
    li + li { margin-top: 0.3em; }
    code, pre, .raw {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    code { border-radius: 4px; background: #111c2e; color: #e6edf7; padding: 0.12em 0.35em; }
    pre { border: 1px solid #24344d; border-radius: 10px; background: #0b1422; overflow-x: auto; padding: 14px; }
    pre code { background: transparent; padding: 0; }
    .hljs-comment, .hljs-quote { color: #7f8da3; font-style: italic; }
    .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #ff7ab2; }
    .hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition { color: #a8e6a3; }
    .hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #d9a8ff; }
    .hljs-variable, .hljs-template-variable, .hljs-selector-id, .hljs-selector-class { color: #73b7ff; }
    .hljs-regexp, .hljs-deletion { color: #ff9f92; }
    .hljs-attr, .hljs-property { color: #8bd5ff; }
    .hljs-emphasis { font-style: italic; }
    .hljs-strong { font-weight: 700; }
    table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; }
    th, td { border: 1px solid #31415b; padding: 7px 10px; text-align: left; }
    th { background: #111c2e; color: #f4f8ff; }
    blockquote { border-left: 3px solid #4b78b8; color: #aebdd0; padding-left: 14px; }
    a { color: #73b7ff; text-decoration: underline; text-underline-offset: 2px; }
    hr { border: 0; border-top: 1px solid #24344d; margin: 1.5em 0; }
    img { display: none; }
    .raw {
      border: 0;
      border-radius: 0;
      background: transparent;
      margin: 0;
      min-width: 100%;
      overflow: visible;
      padding: 0;
      position: relative;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .raw-line { border-radius: 3px; left: -2px; pointer-events: none; position: absolute; right: -2px; }
    .raw-line.line-flash { animation: line-flash 1.6s ease-out; background: rgba(90, 155, 255, 0.28); }
    @keyframes line-flash {
      0%, 45% { background: rgba(90, 155, 255, 0.38); }
      100% { background: transparent; }
    }
  </style>
</head>
<body>
  <div class="document-path">${escapeTaskFileHtml(path)}</div>
  ${body}
  ${buildLineTargetScript(effectiveMode, initialLine)}
</body>
</html>`;
}
