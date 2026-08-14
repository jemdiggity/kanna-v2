# Bazel Crate Universe Boundary Cleanup

## Problem

`MODULE.bazel` currently defines `desktop_crates` from the root Cargo workspace manifest (`//:Cargo.toml`) instead of the desktop crate manifest. That causes `rules_rust` crate-universe to resolve a much larger Rust graph than the desktop build actually needs before Bazel can analyze or build desktop release targets.

The observed effect is slow Bazel analysis during `ship.sh --dry-run`, where crate-universe spends substantial time splicing and fetching dependencies for workspace members unrelated to the desktop app's direct build boundary.

## Goals

- Align Bazel `crate_universe` repository definitions to actual product boundaries.
- Keep desktop Bazel analysis focused on the desktop crate and its direct Rust dependencies.
- Preserve the shipped desktop product's runtime sidecar behavior and packaging layout.
- Make build-boundary mistakes fail explicitly at Bazel analysis time.
- Add static tests that lock the new repo boundary assumptions in place.

## Non-Goals

- Do not change the shipped sidecar set.
- Do not remove runtime daemon, server, transfer, or recovery sidecar packaging.
- Do not refactor unrelated desktop or sidecar Rust code.
- Do not add compatibility fallbacks that silently preserve the old broad workspace behavior.

## Current State

The Rust workspace root includes multiple product boundaries:

- desktop app
- sidecar binaries
- shared support crates

`crate.from_cargo()` is already split for some sidecar-specific repos, but `desktop_crates` still points at the root workspace manifest. As a result, generated `desktop_crates` metadata includes crates and dependencies that are not part of the desktop crate's direct Cargo boundary.

The desktop app does still depend on sidecar binaries as packaged runtime resources. That dependency is modeled through the sidecar build and staging workflow, not through the desktop crate's direct Cargo dependency list.

## Proposed Design

### 1. Split crate-universe repos by Bazel product boundary

Update `MODULE.bazel` so each `crate.from_cargo()` definition maps to the manifest that actually defines the Bazel product being built.

Expected boundary model:

- `desktop_crates`
  - source manifest: `//apps/desktop/src-tauri:Cargo.toml`
  - lockfile: `//apps/desktop/src-tauri:Cargo.lock`
- sidecar repos
  - source manifest and lockfile for each sidecar product or tightly-coupled sidecar boundary
- shared repos
  - only if multiple products truly need the same local Rust crate boundary and a separate repo materially improves clarity

The key rule is that crate-universe repo scope should match a Bazel build boundary, not the entire Rust workspace.

### 2. Keep runtime sidecar packaging separate from Cargo repo scope

The desktop app's runtime dependency on `kanna-daemon`, `kanna-cli`, `kanna-server`, `kanna-terminal-recovery`, and `kanna-task-transfer` remains unchanged. Those binaries continue to be built and staged through the sidecar workflow and included in Tauri `externalBin`.

This cleanup changes dependency resolution scope for Bazel Rust repos. It does not remove runtime packaging dependencies.

### 3. Make local crate relationships explicit

If narrowing a repo exposes an implicit dependency on another workspace member, that dependency should be modeled explicitly:

- through an existing Bazel target dependency
- or through a dedicated crate-universe repo for the relevant local crate boundary

We should not restore root-workspace resolution just to make hidden coupling continue to work.

### 4. Prefer explicit analysis failures over hidden fallback

If the narrowed boundary is incomplete, Bazel should fail immediately with a missing crate, missing repo, or missing target error. That is the desired behavior because it exposes incorrect build-graph assumptions at the layer that owns them.

## Implementation Shape

### `MODULE.bazel`

- Replace the root-workspace manifest for `desktop_crates` with the desktop crate manifest.
- Review the existing sidecar repos and split or rename them only where the current grouping still crosses unrelated product boundaries.
- Keep `supported_platform_triples` behavior unchanged unless the narrowed boundary requires an adjustment.

### `BUILD.bazel` consumers

- Update any `load("@...//:defs.bzl", "all_crate_deps")` sites whose repo names or boundaries change.
- Keep dependency edges explicit and local to the crate or binary being built.
- Avoid introducing alias repos that preserve the old broad scope invisibly.

### Tests

Add or update static tests that assert:

- `desktop_crates` no longer uses `//:Cargo.toml`
- `desktop_crates` is sourced from `apps/desktop/src-tauri/Cargo.toml`
- repo wiring still includes the expected sidecar packaging path
- any newly introduced crate repo names are referenced consistently by the consuming Bazel files

## Verification

### Static verification

- targeted Vitest coverage for `MODULE.bazel` and any touched Bazel files
- `pnpm --dir apps/desktop test -- src/ship.test.ts src/sidecars.test.ts`
- `pnpm exec tsc --noEmit`

### Build-graph verification

Run targeted Bazel commands that prove the narrowed boundaries still analyze or build:

- desktop target analysis/build
- at least one sidecar target analysis/build
- if repo names change for shared crates, a dependent target that exercises the new repo wiring

### Success Criteria

- `desktop_crates` metadata no longer includes unrelated sidecar crates solely because they are workspace members.
- desktop Bazel analysis no longer requires resolving the full Rust workspace upfront.
- sidecar packaging behavior remains unchanged.
- build failures, if any, occur as explicit missing-boundary errors rather than hidden fallback to root workspace resolution.

## Risks

### Hidden workspace coupling

Some local crates may rely on root-workspace context more than the current Bazel files make obvious. Narrowing boundaries may surface missing explicit deps. This is desirable, but it may require a small number of follow-on Bazel dependency fixes.

### Repo naming churn

If repo names change too broadly, the patch can become noisy. Prefer the minimum repo churn needed to make boundaries accurate.

### Lockfile churn

Changing crate-universe boundaries may change which lockfiles Bazel reads and updates. Verification should confirm that the new boundaries reduce unnecessary lockfile interaction rather than spreading it.

## Recommended Approach

Implement the cleanup as a focused Bazel-boundary change:

1. narrow `desktop_crates` to the desktop crate manifest
2. fix any explicit Bazel deps that the narrower scope exposes
3. add static tests that prevent regression
4. verify desktop and sidecar targets still analyze/build through the intended paths

This keeps the architecture honest without changing the shipped product surface.
