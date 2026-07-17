# pnpm 11 Bazel Rules Compatibility Design

**Goal:** Restore Kanna's Bazel release build after the pnpm 11 upgrade by updating the JavaScript rules to a version that understands pnpm 11 lockfiles.

## Context

Kanna has declared `pnpm@11.0.8` since May 7, 2026, while `MODULE.bazel` pins `aspect_rules_js` to `3.0.3`. Releases through `v0.0.68` succeeded with that combination because the lockfile did not contain any patched dependencies, so Bazel never exercised the incompatible patch-handling path.

The Expo SDK 57 upgrade merged on July 16, 2026 added Kanna's first `patchedDependencies` entry for `expo-modules-jsi`. pnpm 11 represents that entry in `pnpm-lock.yaml` as a hash string and retains the patch path in `pnpm-workspace.yaml`; earlier pnpm versions represented each lock entry as an object containing both path and hash. During `./kd release ship --staging --patch --dry-run`, `aspect_rules_js 3.0.3` now enters its patch-handling path, calls `.get("path")` on the hash string, and fails during Bazel module evaluation before compilation.

This is a newly activated latent compatibility gap rather than a new pnpm upgrade. Upstream `aspect_rules_js 3.1.0` introduced pnpm 11 support. This change will use the current `3.2.3` release, provided focused verification shows it does not introduce new build problems.

## Design

Update the direct `aspect_rules_js` dependency in `MODULE.bazel` from `3.0.3` to `3.2.3`. Regenerate `MODULE.bazel.lock` with Bazel so the lock records the selected module and its transitive dependency graph. Do not manually reshape `pnpm-lock.yaml` or duplicate pnpm's patch metadata in Bazel configuration.

No application runtime behavior or release-script logic changes. The change stays at the dependency compatibility boundary that parses the existing pnpm 11 source of truth.

## Verification

The failed Bazel module evaluation is the regression test for this configuration-only fix. Verification proceeds from narrowest to broadest:

1. Re-run Bazel dependency/package evaluation and confirm the pnpm lock translator accepts the existing `patchedDependencies` entry.
2. Run the repository checks relevant to the changed Bazel module graph.
3. Confirm the worktree contains only the intended dependency and generated-lock changes.
4. Commit the compatibility fix so the release script's clean-worktree prerequisite is satisfied.
5. Re-run `./kd release ship --staging --patch --dry-run` with the standard updater signing key environment.
6. Report the resulting prerelease version and DMG locations if successful.

If `aspect_rules_js 3.2.3` produces a new incompatibility, stop and reassess the upgrade version instead of adding unrelated workarounds.

## Scope

The implementation may modify only `MODULE.bazel` and the generated `MODULE.bazel.lock`, apart from this design and implementation-plan documentation. It will not modify pnpm lock data, application code, release behavior, branch names, or remote branches.
