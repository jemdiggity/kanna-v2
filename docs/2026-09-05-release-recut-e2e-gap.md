# Release recut E2E gap — 2026-09-05

The `kd` fixture suite now exercises recut validation and mutation ordering
with disposable git state and a stateful fake GitHub command runner. It covers
the archived old tip, guarded branch move, channel audit block, branch-only
refusal, production-tag refusal, unreadable-channel refusal, lineage
authorization, CLI validation, and MCP schema parity.

The remaining boundary is live GitHub behavior: a live release edit/upload can
fail between writes, and two operators can still race because kd deliberately
does not provide a cross-machine reservation protocol. Release mutations assume
one operator at a time. The local protections re-fetch and revalidate the
pinned refs, channel candidate, and production tags, then use an exact
old-SHA `--force-with-lease`; they detect many races but cannot prevent every
interleaving. A disposable remote repository plus GitHub test credentials (or a
hermetic GitHub API emulator) would make that boundary testable without
touching the real staging channel. Older kd binaries do not understand recut
application records.
