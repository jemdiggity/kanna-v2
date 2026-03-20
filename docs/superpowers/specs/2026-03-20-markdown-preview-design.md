# Markdown Preview in File Preview Modal

## Summary

Add rendered markdown preview to the existing FilePreviewModal. When a `.md` file is open, pressing spacebar toggles between raw syntax-highlighted text (default) and rendered markdown.

## Requirements

- Spacebar toggles between raw and rendered views for `.md` files only
- Default view is raw (syntax-highlighted, current behavior)
- Rendered view supports GFM features: headings, bold, italic, lists, links, code blocks (syntax-highlighted via Shiki), tables, task lists, blockquotes, horizontal rules, strikethrough
- Styling matches the existing dark theme
- No changes to FilePickerModal, App.vue, or keyboard shortcuts composable

## Approach

Use `markdown-it` as the parser with GFM plugins. Fenced code blocks use the existing lazy-loaded Shiki highlighter singleton for syntax highlighting.

## Design

### State & Toggle Logic

In `FilePreviewModal.vue`:

- `renderMarkdown` ref, default `false`
- `isMarkdownFile` computed from file path (ends with `.md`)
- Spacebar keydown listener on the modal toggles `renderMarkdown` when `isMarkdownFile` is true
- Reset `renderMarkdown` to `false` whenever `loadFile` is called (ensures default-to-raw on file change)
- Small indicator in the header shows current mode and toggle hint (e.g. "Raw" / "Rendered" badge next to the existing open-in-IDE button)

#### Spacebar handler guards

- Call `e.preventDefault()` to prevent background scroll
- Only fire when no modifier keys are pressed (`!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey`) to avoid conflicting with future shortcuts like `Cmd+Space`

### Rendering Pipeline

When `renderMarkdown` is true:

- Raw content passed through `markdown-it` configured with GFM support (tables are built-in; task lists via `markdown-it-task-lists`; strikethrough via `markdown-it-strikethrough-alt`)
- Fenced code blocks use a custom `highlight` function that calls Shiki's `codeToHtml` synchronously on the already-resolved highlighter instance
- The rendered HTML is computed via an async watcher: when `renderMarkdown` flips to true, await `getHighlighter()` first (ensuring the singleton is warm), then run `md.render(content)` synchronously. This bridges the async Shiki init with markdown-it's synchronous `highlight(str, lang)` callback.
- Output HTML rendered via `v-html` in the same container div
- When false, existing Shiki syntax-highlighted raw view (unchanged)

No new Tauri commands needed — raw content is already loaded.

### Styling

Scoped styles using `:deep()` on a `.markdown-rendered` wrapper class:

- Headings: sized hierarchy, `#e0e0e0`, subtle bottom border on h1/h2
- Code blocks: `#252525` background, rounded corners, Shiki syntax colors
- Inline code: slight background highlight, monospace
- Tables: bordered cells, alternating row backgrounds
- Task lists: styled checkboxes (read-only)
- Links: colored, underline on hover
- Blockquotes: left border accent, muted text
- Lists: proper indentation and spacing

All colors consistent with existing theme (`#1a1a1a`, `#252525`, `#333`, `#e0e0e0`).

**Existing style scoping:** The current `:deep(pre)` and `:deep(code)` rules (which set `min-height: 100%` and override backgrounds) must be guarded to only apply in raw view mode. Use `.preview-content:not(.markdown-rendered)` as the selector scope, so rendered markdown code blocks get their own independent styling.

## Dependencies

### New (dependencies)

- `markdown-it` — markdown parser
- `markdown-it-task-lists` — GFM task list checkboxes
- `markdown-it-strikethrough-alt` — GFM strikethrough (`~~text~~`)

### New (devDependencies)

- `@types/markdown-it` — TypeScript types

### Existing (reused)

- `shiki` v4.0.2 — fenced code block highlighting via existing singleton

## Files Modified

- `apps/desktop/src/components/FilePreviewModal.vue` — toggle state, rendering logic, styles
- `apps/desktop/package.json` — new dependencies

## Out of Scope

- No sanitization library (content is local filesystem, trusted)
- No image rendering (broken images acceptable for code project preview)
- No `.markdown` or `.mdx` support (`isMarkdownFile` checks `.md` only; can be expanded later)
- No side-by-side view
- No changes to other components
