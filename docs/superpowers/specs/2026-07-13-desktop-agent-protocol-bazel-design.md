# Desktop Agent Protocol Bazel Dependency Design

## Problem

The desktop crate imports `kanna_agent_protocol::AgentProvider`, and Cargo
declares the corresponding path dependency. The Bazel desktop libraries do not
link a `kanna-agent-protocol` target, so production and staging release builds
fail with an unresolved import before packaging begins.

The shared protocol crate already exposes separate targets for daemon, server,
and task-transfer crate universes. Reusing one of those targets for desktop
would mix dependency universes and violate the existing build boundary.

## Design

Add a desktop-universe `kanna_agent_protocol` Rust library to
`crates/kanna-agent-protocol/BUILD.bazel`. It will use the `desktop_crates`
dependency resolver and the existing desktop `claude_agent_sdk` target,
matching the established per-consumer target pattern.

Link the new target from all three desktop Rust library targets:
`kanna_desktop_lib`, `kanna_desktop_lib_bazel`, and
`kanna_desktop_staging_lib_bazel`. This keeps Cargo, normal Bazel, and staging
Bazel builds consistent without changing Rust behavior or duplicating provider
validation.

## Testing

Use the currently failing
`//apps/desktop/src-tauri:kanna_desktop_staging_lib_bazel` build as the focused
regression test: confirm it fails before the patch with the unresolved import,
then passes after the dependency graph is corrected. Also build the production
desktop Bazel library to verify both release variants.

After focused verification, restore any generated lockfile residue, confirm the
worktree contains only the intended source and design changes, and rerun
`./kd release ship --staging --patch --dry-run` with the standard updater
signing keypair. Success requires signed staging DMG and updater artifacts for
`0.0.69-staging.1`.
