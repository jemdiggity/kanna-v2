# Release-infrastructure repair for Zig and DMG creation

## Goal

Restore hermetic macOS release builds after the upstream static Zig 0.15.2 aarch64-macos binary stopped linking libSystem on Darwin 25.x, and make the related Ghostty dependency-fetch and Finder-volume failure modes explicit.

The reproduced cause is Zig 0.15.2's inability to match Xcode 26.4+'s
arm64e-only TAPI targets (`ziglang/zig#31673`). The pinned Ghostty source
requires exactly Zig 0.15.2, so the toolchain fix keeps the official rules_zig
compiler and selects the compatible Command Line Tools SDK only for that
compiler.

## Scope and constraints

- Identify the upstream Zig failure and repair the `rules_zig` toolchain in
  `MODULE.bazel`. Since vendored Ghostty requires exactly Zig 0.15.2, retain
  the checksummed upstream compiler but scope it to the compatible Apple
  Command Line Tools SDK. Preserve the existing `libghostty-vt-sys`
  optimization contract and make its cache paths work in Bazel's normal
  sandbox. Homebrew Zig must not become a build dependency.
- Evaluate whether Ghostty's Zig packages can and should be prefetched or vendored; implement the appropriate hermetic solution or document why it is not appropriate.
- Add a DMG preflight that uses a scratch volume to detect a wedged Finder volume registry and reports that Finder should be relaunched with `killall Finder`, with automated coverage and a dated note for the real-GUI E2E gap.
- Remove the two incident-only `~/.bazelrc` overrides and `~/.kanna/local-zig-override`, then prove `./kd release ship --staging --dry-run` succeeds without them.
- Do not publish, promote, or otherwise mutate production or staging release state beyond the requested dry-run.
- Do not adopt the previously explored partial Ghostty dependency overlay: it
  adds roughly 245,000 lines while leaving other URL dependencies unresolved.
  Record the complete Bazel-prefetch design and remaining cold-cache network
  dependency for a dedicated follow-up.

## Done when

The repository uses a working hermetic Zig toolchain, relevant focused checks pass, the staging release dry-run passes with the machine overrides removed, the Ghostty fetch decision is recorded, and Finder preflight behavior is covered at the Bazel/Python level with the remaining GUI-session gap documented.
