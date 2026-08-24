# Mobile terminal reconnect fidelity

## Goal

Eliminate mobile terminal emulator corruption across relay/LAN disconnect and reconnect cycles introduced by bounded snapshots and offset-based resume.

## Scope and constraints

- Trace and fix the daemon → server → mobile snapshot/live-output contract at its source of truth, including hostile reconnect cuts inside ANSI escapes, UTF-8 code points, and synchronized updates.
- Preserve bounded terminal history and reconnect resume behavior; do not broaden into unrelated terminal UI work.
- Extend the existing terminal-fidelity/E2E harness to compare the complete final rendered screen with a reference emulator after repeated reconnects, rather than checking only sentinels.
- Capture and inspect before/after reproduction screenshots. Mobile JS changes must not bump `runtimeVersion`.
- Owner environment pinning (2026-08-24): reproduce the contract represented by mobile OTA `63327a63-20cd-5f0b-9153-a99880cae033` from task-685968d3 tip `766b8536` (includes PR #1208 / `da8391f0`) against staging desktop `0.3.0-staging.6` built from `2401a9c56` (kspStream v2 / `1bd450811`) over `relay-staging` on 4G.
- The observed build predates PR #1219, so TUI terminal carryover is excluded from this reproduction. Investigate it only if the same corruption class makes it a concrete pre-.7 risk.
- Prioritize, in order: unsafe resume splice boundaries; snapshot/resume overlap or gap; retained-terminal snapshot/live ordering races; then serialization state loss.

## Done

The protocol cannot overlap, gap, reorder, or begin replay at an unsafe byte boundary; byte-exact/full-screen fidelity tests pass through repeated disconnects, relevant Rust/TypeScript checks pass, and the rendered repro is visually verified.

## Implemented contract

- The server ring accepts resume positions only at recorded `term_output` frame boundaries. Hostile offsets inside ESC, UTF-8, or synchronized-update bytes fall back to the bounded snapshot plus complete-frame replay.
- A within-grace foreground return no longer assumes native-to-WKWebView injection was consumed while iOS was backgrounded. Mobile performs one authoritative local xterm rehydrate from the retained contiguous buffer.
- If the mobile live-output cap compacted that buffer and left a snapshot-to-tail gap, foreground reconciliation drops the attachment/resume cursor and obtains a fresh bounded snapshot instead.
- The KSP fidelity test drives three reconnects at hostile offsets and compares the entire final visible screen from a reconstructed client emulator with the uninterrupted reference emulator.
