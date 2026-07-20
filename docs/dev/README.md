# Kanna Developer Documentation

This directory is the onboarding and reference guide for humans working on Kanna
itself. It explains how the system fits together, how to run it locally, how to
test it, and how it ships.

Kanna is a Tauri v2 macOS desktop app for orchestrating coding agent tasks —
each task gets its own git worktree, branch, agent session, and pipeline stage —
plus a companion mobile app, a PTY daemon, a local API server, and cloud
services (relay + Firebase).

## Reading order

New to the codebase? Read in this order:

1. [Getting Started](getting-started.md) — prerequisites, first build, running the app
2. [Architecture](architecture.md) — components, data flow, and the code map
3. [Development Workflow](dev-workflow.md) — the `kd` CLI, worktree isolation, debugging
4. [Testing](testing.md) — the test taxonomy and what to run when
5. [Release](release.md) — versioning, Bazel packaging, staging/production ships, mobile OTA

## Other sources of truth

These docs are an overview and a map. Deeper contracts live next to the code:

| Document | Covers |
|---|---|
| [`AGENTS.md`](../../AGENTS.md) (symlinked as `CLAUDE.md`) | Product behavior, coding style, conventions, and pitfalls. It is written for coding agents but is binding for humans too — treat it as the canonical conventions document. |
| [`crates/daemon/SPEC.md`](../../crates/daemon/SPEC.md) | Full PTY daemon specification: invariants, handoff, session lifecycle |
| [`docs/kanna-server-boundary.md`](../kanna-server-boundary.md) | The `kanna-server` service boundary and its v1 LAN API surface |
| [`docs/specs/`](../specs/) | Feature specs (merge master, task graph stages, mobile OTA, …) |
| [`docs/testing/`](../testing/) | Manual QA gates and E2E runbooks |
| Dated notes in [`docs/`](../) (`YYYY-MM-DD-*.md`) | Point-in-time analyses, E2E coverage gap notes, and migration plans |

When these overview docs and the code (or `AGENTS.md`) disagree, the code and
`AGENTS.md` win — and please fix the doc.

## Documentation conventions

- Keep pages here evergreen. Point-in-time notes (investigations, coverage gaps,
  migration plans) go in `docs/` with a `YYYY-MM-DD-` date prefix instead.
- Behavior contracts belong next to the code they constrain (`SPEC.md`,
  `AGENTS.md`, module-level Rust docs); pages here should link to them rather
  than fork the details.
