# Mobile File Preview Syntax Highlighting Design

## Goal

Add offline syntax highlighting to mobile task file previews for both raw source files and fenced code blocks in rendered Markdown, while preserving the preview's security boundaries, exact-line navigation, and bounded behavior for large inputs.

## Current Behavior and Root Cause

`buildTaskFilePreviewDocument` HTML-escapes raw files and inserts the result directly into a `<pre>` element. Rendered Markdown emits `language-*` classes for fenced code, but no highlighting engine processes those classes. Consequently, every mobile preview uses a single text color regardless of its path or Markdown fence language.

## Chosen Approach

Use `highlight.js` in the React Native document-building layer. Register a curated set of language modules explicitly and map file paths to those registered language names. This keeps highlighting synchronous, offline, and independent of WebView networking or external assets.

This approach is preferred over Shiki because it avoids Shiki's larger mobile bundle and asynchronous grammar-loading path. It is preferred over running a highlighting library inside the WebView because document construction remains testable as a pure TypeScript operation and the WebView retains its narrow script surface.

## Architecture

Create a focused mobile syntax-highlighting utility responsible for:

- mapping common source file paths and special filenames to registered languages;
- resolving Markdown fence aliases to those same languages;
- returning escaped plaintext when a language is unknown;
- catching highlighting failures and returning escaped plaintext;
- declining to highlight content above a fixed character limit.

`buildTaskFilePreviewDocument` will use this utility in two places:

1. Raw previews select a language from the file path and render highlighted HTML when the file is supported and within the limit.
2. The existing MarkdownIt instance receives a synchronous `highlight` callback so supported fenced blocks render highlighted HTML. Unsupported or unlabeled fences remain safely escaped.

All generated token markup will use locally defined `hljs-*` CSS classes. The stylesheet will provide a dark palette consistent with the existing mobile preview.

## Language Coverage

The initial registry will cover the source formats already recognized by the desktop file preview where Highlight.js provides a suitable grammar: TypeScript, TSX, JavaScript, JSX, Vue, HTML/XML/SVG, CSS/SCSS, JSON, TOML, YAML, Markdown, Rust, Python, Ruby, Go, shell scripts, SQL, Swift, Kotlin, Java, C, C++, and GraphQL. Bazel files (`BUILD`, `WORKSPACE`, `MODULE.bazel`, and `*.bzl`) will use Python-compatible highlighting, matching desktop behavior.

Unknown extensions and unsupported Markdown fence labels will render as plaintext rather than use auto-detection. Deterministic path-based detection avoids incorrect highlighting and unnecessary processing.

## Exact-Line Navigation

Highlighted token spans can cross line boundaries, so line targeting will no longer depend on inserting a wrapper into the source before highlighting. The existing inline navigation script will locate the requested line through text nodes, create a DOM `Range` for that line, measure its bounds, and position one `.raw-line` flash overlay without moving or nesting the highlighted token markup.

Only a requested line receives a navigation wrapper. Large or newline-heavy plaintext files therefore retain constant wrapper complexity.

## Performance and Fallbacks

Raw syntax highlighting will have an explicit character limit. Files above the limit retain the existing escaped plaintext rendering, avoiding expensive tokenization and excessive token DOM on mobile. Highlighted output also has a fixed markup-overhead allowance; results that expand beyond it fall back to plaintext. Rendered Markdown keeps its existing parse and token limits; fenced highlighting occurs only after those limits pass.

Highlighting is an enhancement, not a prerequisite for opening a file. Unknown languages, oversize content, and highlighter exceptions all fall back to escaped plaintext. The document builder must never insert unescaped source text or exception content into HTML.

## Security

The WebView remains offline with the existing restrictive Content Security Policy. Highlight.js runs in app JavaScript before the HTML reaches the WebView. No scripts, styles, fonts, or grammars are fetched at runtime. The only inline script remains the fixed exact-line navigation script, parameterized solely by a validated positive integer.

## Testing

Unit tests will verify:

- file-path and Markdown-fence language resolution, including Bazel and unknown paths;
- visible token markup for raw TypeScript source;
- visible token markup for a fenced Markdown block;
- escaped plaintext fallbacks for unknown languages, oversized raw files, and highlighting errors where practical;
- preservation of HTML escaping and the restrictive CSP;
- exact-line navigation through highlighted markup without per-line wrappers;
- retention of bounded DOM behavior for worst-case large newline-heavy files.

Focused mobile tests and the mobile TypeScript check will run after implementation. The repository-wide test suite will run where practical.
