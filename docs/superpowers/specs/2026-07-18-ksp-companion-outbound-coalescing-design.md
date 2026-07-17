# KSP Companion Outbound Coalescing Design

## Goal

Keep at most one unsent visual companion document per task at the KSP WebSocket boundary. A newer document replaces an older pending document, while terminal, agent, response, and state frames remain responsive.

## Root Cause

KSP currently sends every changed companion document into the same bounded FIFO used by all `ServerFrame` values. A second FIFO holds serialized frames before the WebSocket writer. `stream_companion` marks a revision as sent when the first queue accepts it, even though both queues and the socket may still be backpressured. Consequently, multiple obsolete documents can accumulate and delay unrelated streams.

## Architecture

Introduce a connection-scoped outbound channel with two paths:

- A bounded FIFO for ordinary `ServerFrame` traffic. Existing terminal, agent, response, error, and state-change producers retain their ordered, lossless behavior.
- A per-task latest-value store for companion snapshots, unavailable states, and source errors. Publishing replaces any pending companion frame for that task and signals the receiver without blocking.

The actual WebSocket writer consumes this combined receiver directly. There is no intermediate serialized-frame FIFO. Before taking a companion frame, the receiver checks ordinary traffic, ensuring a terminal or agent frame already waiting is not placed behind obsolete companion documents. A companion frame already handed to the socket is in flight and cannot be preempted; only unsent frames are coalesced.

The latest-value store is keyed by task id because one KSP connection may attach companion streams for multiple tasks. Pending state is cleared when that task's companion attachment is detached or replaced. Connection shutdown aborts producers, drops senders, drains the remaining ordinary frames and latest companion values, and then lets the writer exit.

## Data Flow

1. `stream_companion` scans the current document and compares its state with the most recently published state.
2. A changed state is published into the task's latest-value slot. Publication replaces an older unsent state and records the new state as observed.
3. The outbound receiver selects ordinary FIFO traffic first when available; otherwise it takes one pending companion value.
4. The WebSocket writer serializes that selected frame immediately before sending it to the socket.

Serialization failures continue to discard only the affected frame. A closed outbound receiver terminates companion producers and all existing stream producers through their normal send failure paths.

## Deterministic Regression Coverage

Add a KSP test around the real outbound abstraction. The test deliberately does not poll the outbound receiver, publishes three companion document revisions for one task, and publishes a terminal frame while the consumer remains backpressured. Once consumption resumes, it must observe:

1. The terminal frame before any pending companion frame.
2. Only the newest companion revision.
3. No remaining intermediate companion revisions.

Existing companion attachment, source-error, event-validation, terminal-responsiveness, and relay happy-path coverage remains unchanged. Appium coverage is outside this server-side fix.

## Verification

Run the reviewer-requested commands:

```bash
cargo test -p kanna-server ksp::tests::companion -- --nocapture
cargo test -p kanna-server
pnpm test
(cd crates/daemon && cargo test -- --test-threads=1)
```
