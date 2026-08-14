# Mobile File Preview Syntax Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight raw source files and rendered Markdown fences in mobile task file previews without weakening the offline WebView boundary or regressing exact-line navigation and large-file behavior.

**Architecture:** Add a focused synchronous Highlight.js adapter with statically registered grammars, deterministic path/fence language resolution, and escaped plaintext fallbacks. Feed its safe HTML into the existing document builder, theme the emitted `hljs-*` spans locally, and change line targeting to a DOM Range that works through token spans.

**Tech Stack:** TypeScript, React Native, React Native WebView, MarkdownIt, Highlight.js 11.11.1, Vitest, pnpm

---

## File Structure

- Create `apps/mobile/src/screens/taskFileSyntaxHighlight.ts`: own Highlight.js registration, language aliases, path detection, size limiting, HTML escaping, and safe highlighting.
- Modify `apps/mobile/src/screens/buildTaskFilePreviewDocument.ts`: apply highlighting to raw files and Markdown fences, add token colors, and target linked lines through highlighted DOM.
- Modify `apps/mobile/src/screens/buildTaskFilePreviewDocument.test.ts`: add document-level regression coverage for highlighting, fallbacks, security, and line targeting.
- Modify `apps/mobile/src/screens/TaskFilePreview.test.tsx`: update component assertions for highlighted HTML and runtime-created line targets.
- Modify `apps/mobile/package.json` and `pnpm-lock.yaml`: declare and lock Highlight.js as a direct mobile dependency.

### Task 1: Add Failing Document-Level Regression Tests

**Files:**
- Modify: `apps/mobile/src/screens/buildTaskFilePreviewDocument.test.ts`

- [ ] **Step 1: Add raw-source, Markdown-fence, mapping, fallback, and line-targeting expectations**

Append these tests before changing production code:

```ts
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
    expect(html).not.toContain("hljs-");
    expect(html).not.toContain('<script data-value="unsafe">');
  });

  it("keeps unknown Markdown fences escaped and unhighlighted", () => {
    const html = buildTaskFilePreviewDocument({
      path: "docs/example.md",
      content: "```unknown-language\n<tag>\n```",
      mode: "rendered"
    });

    expect(html).toContain("&lt;tag&gt;");
    expect(html).not.toContain("hljs-");
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
    expect(html).not.toContain("range.extractContents()");
    expect(html).toContain('line.classList.add("line-flash")');
    expect(html).not.toContain('<span class="raw-line" data-line="2">');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTaskFilePreviewDocument.test.ts
```

Expected: FAIL because source and Markdown fences contain no `hljs-*` spans and line targeting contains no DOM TreeWalker or Range.

### Task 2: Add the Bounded Syntax-Highlighting Adapter

**Files:**
- Create: `apps/mobile/src/screens/taskFileSyntaxHighlight.ts`
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add Highlight.js as a direct mobile dependency**

Run:

```bash
pnpm --filter @kanna/mobile add highlight.js@11.11.1
```

Expected: `apps/mobile/package.json` gains `"highlight.js": "11.11.1"` and `pnpm-lock.yaml` records the direct mobile dependency.

- [ ] **Step 2: Create the statically registered highlighter**

Create `apps/mobile/src/screens/taskFileSyntaxHighlight.ts` with:

```ts
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const MAX_SYNTAX_HIGHLIGHT_CHARACTERS = 256 * 1024;
const MAX_SYNTAX_HIGHLIGHT_MARKUP_OVERHEAD = 64 * 1024;

const languageDefinitions = {
  bash, c, cpp, css, go, graphql, ini, java, javascript, json, kotlin,
  markdown, python, ruby, rust, scss, sql, swift, typescript, xml, yaml
} as const;

type TaskSyntaxLanguage = keyof typeof languageDefinitions;

for (const [name, definition] of Object.entries(languageDefinitions)) {
  hljs.registerLanguage(name, definition);
}

const BAZEL_FILENAMES = new Set([
  "BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"
]);

const extensionLanguages: Record<string, TaskSyntaxLanguage> = {
  bash: "bash", c: "c", cpp: "cpp", css: "css", go: "go",
  gql: "graphql", graphql: "graphql", h: "c", hpp: "cpp", html: "xml",
  java: "java", js: "javascript", json: "json", jsx: "javascript",
  kt: "kotlin", md: "markdown", py: "python", rb: "ruby", rs: "rust",
  scss: "scss", sh: "bash", sql: "sql", svg: "xml", swift: "swift",
  toml: "ini", ts: "typescript", tsx: "typescript", vue: "xml", xml: "xml",
  yaml: "yaml", yml: "yaml", zsh: "bash"
};

const fenceLanguages: Record<string, TaskSyntaxLanguage> = {
  ...extensionLanguages,
  cxx: "cpp", javascript: "javascript", markdown: "markdown",
  python: "python", rust: "rust", shell: "bash", typescript: "typescript"
};

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function escapeTaskFileHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

export function getTaskFileSyntaxLanguage(path: string): TaskSyntaxLanguage | null {
  const name = baseName(path);
  if (BAZEL_FILENAMES.has(name) || name.endsWith(".bzl")) return "python";
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return extensionLanguages[extension] ?? null;
}

export function getMarkdownFenceSyntaxLanguage(info: string): TaskSyntaxLanguage | null {
  const label = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return fenceLanguages[label] ?? null;
}

function highlight(content: string, language: TaskSyntaxLanguage | null): string {
  if (!language || content.length > MAX_SYNTAX_HIGHLIGHT_CHARACTERS) {
    return escapeTaskFileHtml(content);
  }
  try {
    const highlighted = hljs.highlight(content, {
      ignoreIllegals: true,
      language
    }).value;
    return highlighted.length <=
      content.length + MAX_SYNTAX_HIGHLIGHT_MARKUP_OVERHEAD
      ? highlighted
      : escapeTaskFileHtml(content);
  } catch {
    return escapeTaskFileHtml(content);
  }
}

export function highlightTaskFileSource(content: string, path: string): string {
  return highlight(content, getTaskFileSyntaxLanguage(path));
}

export function highlightMarkdownFence(content: string, info: string): string {
  return highlight(content, getMarkdownFenceSyntaxLanguage(info));
}
```

- [ ] **Step 3: Run the mobile typecheck for module compatibility**

Run `pnpm --dir apps/mobile typecheck`.

Expected: PASS. Keep the core-only static imports; do not replace them with the all-languages bundle.

### Task 3: Integrate Highlighting and Span-Safe Line Targeting

**Files:**
- Modify: `apps/mobile/src/screens/buildTaskFilePreviewDocument.ts`

- [ ] **Step 1: Connect MarkdownIt and raw rendering to the adapter**

Add the adapter import:

```ts
import {
  escapeTaskFileHtml,
  highlightMarkdownFence,
  highlightTaskFileSource
} from "./taskFileSyntaxHighlight";
```

Configure MarkdownIt's synchronous highlighter:

```ts
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  highlight(content, info) {
    return highlightMarkdownFence(content, info);
  }
});
```

Delete the local `escapeHtml` function and replace its call sites with `escapeTaskFileHtml`. Replace `buildRawContent` with:

```ts
function buildRawContent(content: string, path: string): string {
  return highlightTaskFileSource(content, path);
}
```

Build the body and visible path with:

```ts
const body =
  renderedMarkdown !== null
    ? `<main class="markdown">${renderedMarkdown.html}</main>`
    : `<pre class="raw">${buildRawContent(content, path)}</pre>`;
```

```ts
<div class="document-path">${escapeTaskFileHtml(path)}</div>
```

- [ ] **Step 2: Replace source-string line wrapping with a DOM Range**

Replace `buildLineTargetScript` with:

```ts
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
```

- [ ] **Step 3: Add a local dark token palette**

Add after the existing `pre code` rule:

```css
.hljs-comment, .hljs-quote { color: #7f8da3; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #ff7ab2; }
.hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition { color: #a8e6a3; }
.hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #d9a8ff; }
.hljs-variable, .hljs-template-variable, .hljs-selector-id, .hljs-selector-class { color: #73b7ff; }
.hljs-regexp, .hljs-deletion { color: #ff9f92; }
.hljs-attr, .hljs-property { color: #8bd5ff; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
```

Retain the existing `.raw` properties and add `position: relative`. Replace the `.raw-line` rule with:

```css
.raw-line {
  border-radius: 3px;
  left: -2px;
  pointer-events: none;
  position: absolute;
  right: -2px;
}
```

- [ ] **Step 4: Run the focused document test and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTaskFilePreviewDocument.test.ts
```

Expected: PASS, including pre-existing security, Markdown-limit, newline, and CSP cases.

### Task 4: Update Component-Level Preview Assertions

**Files:**
- Modify: `apps/mobile/src/screens/TaskFilePreview.test.tsx`

- [ ] **Step 1: Update assertions that intentionally observe raw HTML**

For raw Markdown mode, use:

```ts
expect((webView?.props?.source as { html: string }).html).toContain(
  '<span class="hljs-section"># Spec</span>'
);
```

For non-Markdown TypeScript files, use:

```ts
expect((webView?.props?.source as { html: string }).html).toContain(
  '<span class="hljs-keyword">const</span>'
);
```

For linked Markdown lines, replace the static `data-line="2"` expectation with:

```ts
expect(html).toContain("document.createTreeWalker");
expect(html).toContain("document.createRange");
expect(html).toContain("scrollIntoView");
```

- [ ] **Step 2: Run both preview suites**

Run:

```bash
pnpm --dir apps/mobile test -- src/screens/buildTaskFilePreviewDocument.test.ts src/screens/TaskFilePreview.test.tsx
```

Expected: PASS.

### Task 5: Verify the Mobile Package and Worktree

**Files:**
- Verify only; no new files expected.

- [ ] **Step 1: Run the mobile typecheck**

Run `pnpm --dir apps/mobile typecheck`.

Expected: PASS with no TypeScript or module-resolution errors.

- [ ] **Step 2: Run the full mobile unit suite**

Run `pnpm --dir apps/mobile test`.

Expected: PASS.

- [ ] **Step 3: Run repository-level verification where practical**

Run `pnpm test`.

Expected: PASS. If the monorepo suite cannot finish in the available stage time, report the exact completed checks and unfinished command without claiming it passed.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- apps/mobile/src/screens/taskFileSyntaxHighlight.ts apps/mobile/src/screens/buildTaskFilePreviewDocument.ts apps/mobile/src/screens/buildTaskFilePreviewDocument.test.ts apps/mobile/src/screens/TaskFilePreview.test.tsx apps/mobile/package.json pnpm-lock.yaml
```

Expected: no whitespace errors; only the approved highlighting implementation, tests, dependency metadata, spec, and plan are changed.

No commit step is included because this Kanna stage explicitly leaves committing to the workflow's later commit post.
