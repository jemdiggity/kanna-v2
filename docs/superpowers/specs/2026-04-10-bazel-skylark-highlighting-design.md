# Bazel Skylark Highlighting

## Summary

Add Bazel/Starlark-aware syntax highlighting to both the file preview modal and the diff viewer. Because the shipped `shiki@4.0.2` bundle in this repo does not include a `starlark` or `skylark` grammar, Bazel files will be mapped to Shiki's `python` highlighter as an intentional approximation.

## Changes

### Shared detection

Add a small shared frontend utility that identifies Bazel/Starlark files by filename, not just extension.

Recognized filenames:
- `BUILD`
- `BUILD.bazel`
- `WORKSPACE`
- `WORKSPACE.bazel`
- `MODULE.bazel`
- Any `*.bzl`

The utility should expose:
- A predicate for Bazel/Starlark file detection
- A resolver that returns the syntax language to use for previews and diffs

The resolver should return `python` for Bazel/Starlark files and otherwise preserve the existing language mapping behavior.

### File: `apps/desktop/src/components/FilePreviewModal.vue`

- Replace the inline `langFromPath()` logic with the shared resolver.
- Keep the existing lazy Shiki loading flow.
- When previewing Bazel/Starlark files, load and render with `python`.
- Preserve the current fallback behavior to `text` if a language fails to load.

This keeps the file preview workflow unchanged except for filename-aware language detection.

### File: `apps/desktop/src/components/DiffView.vue`

- Add Bazel/Starlark language overrides before rendering file diffs.
- Use `@pierre/diffs`'s `setLanguageOverride()` on any diff file metadata whose path matches the shared Bazel/Starlark detector.
- Override those files to `python` before passing them to `FileDiff.render()`.

This uses the diff library's built-in language override seam instead of patching rendered output or changing worker internals.

### Tests

Add tests that lock in the new behavior:
- Unit tests for the shared filename detection and language resolution utility
- A file preview regression test that verifies a Bazel filename requests `python` highlighting
- A diff-view regression test that verifies Bazel diff entries are overridden to `python`

Tests should verify the behavior through the public seams the app already uses, not by snapshotting large rendered HTML blobs.

## Non-goals

- Vendoring a real Starlark grammar
- Adding new syntax themes
- Changing highlighting behavior for non-Bazel files
- Modifying backend, daemon, or database code

## Rationale

Using `python` is not perfect, but it is the best fit available in the current shipped Shiki bundle and keeps the implementation small, deterministic, and dependency-free. Centralizing Bazel filename detection avoids duplicating special cases between preview and diff rendering, and using `setLanguageOverride()` keeps diff behavior aligned with the library's intended extension points.
