# Task d4bda4c8: search tasks by ID

OWNER FEATURE REQUEST (2026-09-02, verbatim): "Probably it would be good if searching tasks on mobile also picked up task ids"

## Goal and scope

- Mobile task search must find an open task by its case-insensitive durable ID, including an exact ID and a partial ID such as `eef65` for `eef65d54`.
- Search result rows must make the matched ID legible. The existing mobile task row’s dedicated, non-truncating short-ID line fulfills this; update its surrounding search copy to name IDs.
- Add the same literal durable-ID field to desktop task filtering because it is a small parallel change. Keep existing title, prompt, issue-title, and branch matching unchanged.
- Branch-name matching remains supported by the existing desktop branch field and is included in the server query as the same trivial literal match; cloud task summaries do not carry branch names, so no separate branch-ID extraction is added there.

## Constraints and decisions

- ID matching is literal, case-insensitive substring matching, not fuzzy/subsequence matching: task IDs are exact cross-system identifiers, and partial IDs may be copied from either end or the middle. This is an additional searchable field alongside current matching.
- Do not create a fuzzy matcher. Desktop continues to use its existing task-search scorer; the repository’s `fuzzyMatch.ts` remains reserved for established desktop fuzzy-search surfaces.
- Cover the server/mobile boundary and desktop matcher with focused tests, and add mobile E2E coverage or a dated coverage-gap note. Visually verify mobile search by ID in the real app or simulator and capture a screenshot under this task’s gitignored screenshot directory.

## Done when

Searching mobile by a full or partial task ID returns the task with its ID visibly rendered; desktop filtering also matches the durable ID directly; focused checks pass; and mobile rendered/E2E verification is recorded.

## Verification

- The self-contained iOS Simulator Search smoke passed through the hybrid LAN/relay harness. It entered the first five characters of a live eight-hex task ID, asserted the result accessibility label contained the full ID, and captured `docs/task-specs/d4bda4c8-screenshots/mobile-id-search.png` (gitignored). The inspected screenshot shows the prefix query and the full ID on the matching result row.
- Focused mobile controller/transport/component tests, desktop matcher/sidebar tests, the server search boundary test, and both TypeScript typechecks pass. Rust formatting passes; the repository's all-target `kanna-server` Clippy run remains blocked by pre-existing warnings outside this change.
