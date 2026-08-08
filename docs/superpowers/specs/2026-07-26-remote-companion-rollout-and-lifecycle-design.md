# Remote Companion Rollout and Lifecycle Design

## Goal

Finish the remote visual companion rollout without adding latency to terminal/control traffic, breaking older KSP peers, or allowing an older LAN observation attempt to replace a newer one.

## Protocol and scheduling

KSP companion attach gains an optional `accept_snapshot_chunks` boolean. Current stream clients set it to `true`; old servers ignore the unknown field and continue to emit legacy snapshots. Current servers emit `companion_snapshot_chunk` only when the field is explicitly true. An old client omits it and receives the legacy bounded `companion_snapshot` frame.

For negotiated peers, the server moves serialization and chunk preparation to a blocking worker before the outbound receiver starts yielding chunks. Ordinary KSP frames continue through their independent queue while that worker runs. The browser keeps bounded chunk metadata on the companion lane, but sends the completed serialized snapshot back through the configured frame decoder so joining and `JSON.parse` happen off the UI thread. The decoded snapshot is dispatched only if its socket, decode generation, transfer identity, and attachment are still current.

The relay remains a transparent bounded tunnel during mixed-version rollout. It accepts legal legacy snapshots from old servers and applies the existing 64 MiB absolute buffered-byte cap to all frames. Its slow-peer regression sends legal 96 KiB chunk frames through a real paused peer, proves high/low-water pause and resume, and separately proves the absolute cap closes both sides before enqueue.

## LAN observation ordering

Companion control requests are serialized by `(target_peer_id, task_id)`, not by generation. The runtime also records the latest requested generation before opening a peer stream. When an open completes, installation occurs only if that generation is still latest. A losing stream is dropped and its owner-side observation is released; it never removes or replaces the installed newer observer. Unobserve clears only the matching generation.

The desktop client treats replacement as an ordered handoff: it issues cleanup for the previous generation before starting the replacement attempt and ignores late completions and events using the existing current-entry and generation checks.

## Real journey and stable discovery

The real desktop journey creates two independent owner tasks and companion fixtures. Companion A remains open in its external browser while the secondary app selects B and releases A's Vue component claim. The test publishes distinct revisions to A and B, sends distinct choices through both live browsers, verifies each fixture receives only its own event, then selects A again and proves its bridge/browser remains live.

Remote task discovery uses the owner identity and transport as the stable key, waits for one canonical visible sidebar row, and clicks that row on every retry until both selected-item identity and transport diagnostics agree. It does not select by prompt alone or retain a stale “clicked” flag across Vue rerenders.

## Bounds and failure handling

- Snapshot framing remains bounded by the visual-companion discovery limits and the existing 64 MiB KSP/relay retained-byte caps.
- Unknown or absent capabilities are treated as legacy compatibility, never as chunk support.
- Malformed, oversized, stale, or cross-task chunk assemblies are discarded with the existing companion error.
- Decode cancellation and socket replacement discard late completed assemblies.
- A stale LAN open releases its stream and cannot invalidate the latest observer.
- Relay pause/resume thresholds remain 32 MiB and 16 MiB; the absolute cap remains 64 MiB.

## Verification

Focused regressions prove:

1. old and new KSP clients receive legacy and chunked snapshots respectively;
2. terminal traffic is received while maximum-size server serialization is blocked;
3. terminal dispatch occurs around the final chunk while join/parse is blocked in the decoder;
4. legal chunk traffic pauses and resumes a real relay tunnel, while the absolute cap is enforced;
5. generation 2 can finish opening before generation 1 without generation 1 replacing it;
6. companions A and B remain concurrently interactive and isolated across selection/release;
7. the canonical real E2E setup passes repeatedly from a clean run.
