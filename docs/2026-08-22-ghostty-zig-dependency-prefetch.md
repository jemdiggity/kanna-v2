# Ghostty Zig dependency prefetch decision (2026-08-22)

The pinned Ghostty source still resolves packages from
`https://deps.files.ghostty.org` while its Zig build runs. Zig verifies those
packages against the hashes in `build.zig.zon`, but a clean build therefore
still depends on that service being reachable. This caused a transient
`ConnectionTimedOut` during the 0.3.0-staging.5 ship.

We evaluated the existing `kanna-vendor-ghostty-zig-deps-61ae57d` experiment.
It copies uucode, Highway, and utf8cpp into the repository (roughly 245,000
lines), yet leaves other lazy URL dependencies in Ghostty's package graph. It
is both too large for this incident hardening and incomplete as a hermetic
solution, so it is not being adopted.

The release build remains network-dependent for a cold Zig package cache. A
complete fix should generate a Bazel repository from every URL and hash in the
pinned Ghostty `build.zig.zon`, download those packages through Bazel's
repository cache, and rewrite the package graph to local paths for the Zig
action. That generated repository must be refreshed atomically whenever the
pinned Ghostty commit changes. This should be implemented and tested as its
own dependency-vendoring change rather than checking a partial source copy
into this incident fix.
