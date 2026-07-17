# KSP Companion Outbound Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one pending latest companion frame per task at the WebSocket boundary without allowing obsolete companion documents to delay terminal or agent traffic.

**Architecture:** Replace the two-stage shared FIFO writer with a combined outbound receiver consumed directly by each WebSocket sink. Ordinary frames retain their bounded FIFO; companion frames use a task-keyed latest-value map plus a capacity-one wake channel, and the receiver checks ordinary frames before taking a companion value.

**Tech Stack:** Rust, Tokio `mpsc`, Axum WebSockets, tokio-tungstenite, KSP `ServerFrame` integration tests.

---

## File Structure

- Modify `crates/kanna-server/src/ksp.rs`: define the combined outbound channel, connect it directly to both WebSocket writers, route companion producers through the coalescing sender, clear pending values on attachment replacement/detach, and add deterministic regression coverage.
- Create `docs/superpowers/plans/2026-07-18-ksp-companion-outbound-coalescing.md`: record this implementation plan.

### Task 1: Add the deterministic outbound regression test

**Files:**
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Write the failing test**

Add a `companion_outbound_coalesces_backpressured_revisions_without_starving_terminal` Tokio test. Construct the planned outbound channel, publish companion snapshots with revisions `revision-1`, `revision-2`, and `revision-3` without polling its receiver, then enqueue a `TermOutput` frame. Resume polling and assert the terminal frame is first, the only companion frame is `revision-3`, and no third frame arrives:

```rust
#[tokio::test]
async fn companion_outbound_coalesces_backpressured_revisions_without_starving_terminal() {
    let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
    let snapshot = |revision: &str| ServerFrame::CompanionSnapshot {
        task_id: "task-1".into(),
        session_id: "session-1".into(),
        revision: revision.into(),
        document_kind: CompanionDocumentKind::Fragment,
        html: format!("<p>{revision}</p>"),
    };

    for revision in ["revision-1", "revision-2", "revision-3"] {
        assert!(companion_tx.publish("task-1".into(), snapshot(revision)));
    }
    frame_tx
        .send(ServerFrame::TermOutput {
            task_id: "task-1".into(),
            data_b64: b64(b"responsive"),
        })
        .await
        .unwrap();

    assert!(matches!(
        outbound_rx.recv().await,
        Some(ServerFrame::TermOutput { .. })
    ));
    match outbound_rx.recv().await {
        Some(ServerFrame::CompanionSnapshot { revision, .. }) => {
            assert_eq!(revision, "revision-3")
        }
        other => panic!("expected newest companion snapshot, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(25), outbound_rx.recv())
            .await
            .is_err(),
        "intermediate companion snapshots must be discarded"
    );
}
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
cargo test -p kanna-server ksp::tests::companion_outbound_coalesces_backpressured_revisions_without_starving_terminal -- --nocapture
```

Expected: compilation fails because `outbound_frame_channel` and companion `publish` do not exist. This is the missing outbound behavior the test specifies; fix any unrelated syntax or fixture errors before implementation.

### Task 2: Implement the connection-scoped latest-value outbound channel

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs:7-217`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Add the outbound sender and receiver types**

Import `Mutex`, then add a companion sender backed by `Arc<Mutex<HashMap<String, ServerFrame>>>`, a capacity-one notification channel, and an outbound receiver:

```rust
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct CompanionFrameSender {
    pending: Arc<Mutex<HashMap<String, ServerFrame>>>,
    notify_tx: mpsc::Sender<()>,
}

impl CompanionFrameSender {
    fn publish(&self, task_id: String, frame: ServerFrame) -> bool {
        if self.notify_tx.is_closed() {
            return false;
        }
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(task_id, frame);
        match self.notify_tx.try_send(()) {
            Ok(()) | Err(mpsc::error::TrySendError::Full(())) => true,
            Err(mpsc::error::TrySendError::Closed(())) => false,
        }
    }

    fn clear(&self, task_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(task_id);
    }
}

struct OutboundFrameReceiver {
    frame_rx: mpsc::Receiver<ServerFrame>,
    companion_pending: Arc<Mutex<HashMap<String, ServerFrame>>>,
    companion_notify_rx: mpsc::Receiver<()>,
    frame_closed: bool,
    companion_closed: bool,
}
```

- [ ] **Step 2: Add channel construction and priority receive logic**

Create both paths together. `recv` first drains a ready ordinary frame, then takes one coalesced companion frame, and finally waits with a biased select. It exits only when both sender sets are closed and the companion map is empty:

```rust
fn outbound_frame_channel(
    capacity: usize,
) -> (
    mpsc::Sender<ServerFrame>,
    CompanionFrameSender,
    OutboundFrameReceiver,
) {
    let (frame_tx, frame_rx) = mpsc::channel(capacity);
    let (notify_tx, companion_notify_rx) = mpsc::channel(1);
    let companion_pending = Arc::new(Mutex::new(HashMap::new()));
    (
        frame_tx,
        CompanionFrameSender {
            pending: companion_pending.clone(),
            notify_tx,
        },
        OutboundFrameReceiver {
            frame_rx,
            companion_pending,
            companion_notify_rx,
            frame_closed: false,
            companion_closed: false,
        },
    )
}

impl OutboundFrameReceiver {
    fn take_companion(&self) -> Option<ServerFrame> {
        let mut pending = self
            .companion_pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let task_id = pending.keys().next()?.clone();
        pending.remove(&task_id)
    }

    async fn recv(&mut self) -> Option<ServerFrame> {
        loop {
            if !self.frame_closed {
                match self.frame_rx.try_recv() {
                    Ok(frame) => return Some(frame),
                    Err(mpsc::error::TryRecvError::Disconnected) => self.frame_closed = true,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            if let Some(frame) = self.take_companion() {
                return Some(frame);
            }
            if self.frame_closed && self.companion_closed {
                return None;
            }

            tokio::select! {
                biased;
                frame = self.frame_rx.recv(), if !self.frame_closed => {
                    match frame {
                        Some(frame) => return Some(frame),
                        None => self.frame_closed = true,
                    }
                }
                notification = self.companion_notify_rx.recv(), if !self.companion_closed => {
                    if notification.is_none() {
                        self.companion_closed = true;
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 3: Run the focused regression test to verify GREEN**

Run:

```bash
cargo test -p kanna-server ksp::tests::companion_outbound_coalesces_backpressured_revisions_without_starving_terminal -- --nocapture
```

Expected: PASS, proving normal traffic priority and per-task replacement at the outbound abstraction.

### Task 3: Move coalescing to the actual WebSocket boundary

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs:65-230`
- Modify: `crates/kanna-server/src/ksp.rs:583-688`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Make both socket writers consume `OutboundFrameReceiver` directly**

In both `handle_stream` and `handle_tungstenite_stream`, construct `outbound_frame_channel(256)`. The writer task calls `outbound_rx.recv()`, serializes the returned `ServerFrame`, and immediately sends it through its socket sink. Pass the ordinary and companion senders into `handle_stream_channels`. Remove the `String` channel and `write_frames` task/function.

Axum writer shape:

```rust
let (frame_tx, companion_tx, mut outbound_rx) = outbound_frame_channel(256);
let writer_task = tokio::spawn(async move {
    while let Some(frame) = outbound_rx.recv().await {
        let Ok(json) = serde_json::to_string(&frame) else {
            continue;
        };
        if ws_tx.send(WsMessage::Text(json.into())).await.is_err() {
            return;
        }
    }
});
```

Apply the same logic using `TungsteniteMessage::Text` for the relay/Tungstenite writer.

- [ ] **Step 2: Route `StreamConn` companion attachment state through the latest-value sender**

Change `handle_stream_channels` to accept `frame_tx: mpsc::Sender<ServerFrame>` and `companion_tx: CompanionFrameSender`. Store both in `StreamConn`. Keep state-change, terminal, agent, error, response, and event-result frames on `frame_tx`.

Before replacing a companion attachment, clear its task's pending companion value. On companion detach, abort the producer and clear the task slot. During shutdown, abort all producers and clear companion slots for drained companion attachments.

- [ ] **Step 3: Publish companion changes without entering the ordinary FIFO**

Change `stream_companion` to receive `CompanionFrameSender`. Rename `sent` to `published` because publication now means the latest value has been installed at the writer boundary. For a changed document state:

```rust
if next_state != published {
    if !companion_tx.publish(task_id.clone(), frame) {
        return;
    }
    published = next_state;
}
```

This retains scan de-duplication while ensuring a later state replaces an older unsent state.

- [ ] **Step 4: Run focused companion coverage**

Run:

```bash
cargo test -p kanna-server ksp::tests::companion -- --nocapture
```

Expected: all companion tests pass, including the new deterministic regression.

- [ ] **Step 5: Format and inspect the focused diff**

Run:

```bash
cargo fmt --all -- --check
git diff --check
git diff -- crates/kanna-server/src/ksp.rs
```

If formatting check reports changes, run `cargo fmt --all`, rerun the focused test, and then repeat the checks.

### Task 4: Run the reviewer-requested regression suite

**Files:**
- Verify: repository-wide tests only

- [ ] **Step 1: Run all kanna-server tests**

Run:

```bash
cargo test -p kanna-server
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run the JavaScript/TypeScript suite**

Run:

```bash
pnpm test
```

Expected: PASS with zero failed test files.

- [ ] **Step 3: Run daemon tests single-threaded**

Run:

```bash
(cd crates/daemon && cargo test -- --test-threads=1)
```

Expected: PASS with zero failed tests.

- [ ] **Step 4: Review the final diff and status**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~1
```

Confirm only the approved KSP implementation/test and superpowers documentation are present.

- [ ] **Step 5: Commit the implementation**

```bash
git add crates/kanna-server/src/ksp.rs docs/superpowers/plans/2026-07-18-ksp-companion-outbound-coalescing.md
git commit -m "fix(server): coalesce companion outbound frames"
```
