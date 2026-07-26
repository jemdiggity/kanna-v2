# Daemon Handoff Capability Epoch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify the hardened handoff as protocol v3 while retaining one explicit, receiver-validated v2 fallback so deployed users keep their live PTYs.

**Architecture:** First integrate the already-reviewed lifecycle and descriptor hardening because those are the guarantees v3 names. Then drive the change test-first: unit tests specify v3/v2 negotiation, and a real daemon built from the shipped `v0.1.0-staging.1` tag proves stable PTY and agent sessions survive while separate session ids churn. A typed `HandoffMode` prevents the adopter from confusing transactional v3 with best-effort legacy v2.

**Tech Stack:** Rust, Tokio, Unix sockets, SCM_RIGHTS, Cargo integration tests, Git archive fixtures, Markdown.

---

## File Responsibilities

- `crates/daemon/src/protocol.rs` — single source of truth for current and legacy handoff epochs.
- `crates/daemon/src/handoff.rs` — typed negotiation, sender mode selection, transfer validation, and mode diagnostics.
- `crates/daemon/src/tests.rs` — unit tests for version mapping and fallback decisions.
- `crates/daemon/tests/handoff.rs` — real-process current/current and previous/current handoff coverage.
- `crates/daemon/tests/support/mod.rs` — shared integration-test support exports.
- `crates/daemon/tests/support/previous_daemon.rs` — cached builder for the real shipped v2 daemon.
- `crates/daemon/SPEC.md` and `CLAUDE.md` — protocol guarantees and legacy limitation.

### Task 1: Integrate the Reviewed Hardening Prerequisite

**Files:**
- Modify: daemon files contained in commits `634f3f95` and `b0d890e5`
- Verify: `crates/daemon/src/handoff.rs`
- Verify: `crates/daemon/src/session.rs`
- Verify: `crates/daemon/src/agent_runtime/adoption.rs`

- [ ] **Step 1: Cherry-pick the reviewed commits**

Run:

```bash
git cherry-pick 634f3f95 b0d890e5
```

Expected: both commits apply without switching branches.

- [ ] **Step 2: Confirm every guarantee named by v3 exists**

Run:

```bash
rg -n "seal_for_handoff|AgentHandoffSealGuard|duplicate_owned|bundle_is_authentic|socket_peer_pid" crates/daemon/src
```

Expected: matches cover PTY sealing, agent sealing, owned FD duplication, pipe provenance, and peer authentication.

- [ ] **Step 3: Verify the integrated baseline**

Run:

```bash
cargo test -p kanna-daemon --lib -- --test-threads=1
```

Expected: all daemon library tests pass before protocol changes.

### Task 2: Write Failing Negotiation Tests

**Files:**
- Modify: `crates/daemon/src/tests.rs`
- Modify: `crates/daemon/tests/handoff.rs`

- [ ] **Step 1: Specify the protocol constants and typed modes**

Add to `crates/daemon/src/tests.rs`:

```rust
use crate::handoff::{
    handoff_mode_for_version, legacy_fallback_after_error, HandoffMode, HandoffRequestError,
};

#[test]
fn handoff_protocol_epochs_are_distinct() {
    assert_eq!(protocol::HANDOFF_PROTOCOL_VERSION, 3);
    assert_eq!(protocol::LEGACY_HANDOFF_PROTOCOL_VERSION, 2);
}

#[test]
fn supported_handoff_versions_map_to_explicit_modes() {
    assert_eq!(
        handoff_mode_for_version(protocol::HANDOFF_PROTOCOL_VERSION),
        Some(HandoffMode::TransactionalV3)
    );
    assert_eq!(
        handoff_mode_for_version(protocol::LEGACY_HANDOFF_PROTOCOL_VERSION),
        Some(HandoffMode::LegacyV2)
    );
    assert_eq!(handoff_mode_for_version(1), None);
}

#[test]
fn explicit_v3_mismatch_selects_one_legacy_v2_fallback() {
    let error = HandoffRequestError::OldDaemonRefused(
        "handoff version mismatch: expected 1 or 2, got 3".to_string(),
    );
    assert_eq!(
        legacy_fallback_after_error(&error),
        Some(HandoffMode::LegacyV2)
    );
}

#[test]
fn ambiguous_handoff_failure_never_selects_legacy() {
    assert_eq!(
        legacy_fallback_after_error(&HandoffRequestError::ResponseTimeout),
        None
    );
}
```

Remove v1 payload tests. Keep the deployed full-v2 `HandoffReady` parser test.

- [ ] **Step 2: Change the fake previous-daemon expectation to v3 then v2**

Rename `test_handoff_explicit_version_mismatch_retries_compat` to
`test_handoff_explicit_v3_mismatch_retries_legacy_v2`. Make its handler reject
version 3 and accept version 2, then assert:

```rust
assert_eq!(
    requests,
    vec![3, 2],
    "explicit v3 mismatch should retry exactly once with legacy v2"
);
```

- [ ] **Step 3: Run and verify RED**

Run:

```bash
cargo test -p kanna-daemon --lib handoff_protocol_epochs_are_distinct
cargo test -p kanna-daemon --test handoff test_handoff_explicit_v3_mismatch_retries_legacy_v2
```

Expected: compilation failures for the missing constants, mode, and fallback function.

### Task 3: Build and Cache an Actual Previous Daemon

**Files:**
- Create: `crates/daemon/tests/support/mod.rs`
- Create: `crates/daemon/tests/support/previous_daemon.rs`
- Modify: `crates/daemon/tests/handoff.rs`

- [ ] **Step 1: Write the failing fixture smoke test**

At the top of `handoff.rs`, add `mod support;`, then add:

```rust
#[test]
fn previous_daemon_fixture_is_the_shipped_v2_binary() {
    let binary = support::previous_daemon::binary();
    let output = Command::new(binary)
        .arg("--version")
        .output()
        .expect("run previous daemon");
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("kanna-daemon"));
}
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
cargo test -p kanna-daemon --test handoff previous_daemon_fixture_is_the_shipped_v2_binary -- --nocapture
```

Expected: compilation failure because the support module does not exist.

- [ ] **Step 3: Implement the fixture cache**

Create `support/mod.rs`:

```rust
pub mod previous_daemon;
```

Create `previous_daemon.rs` with the fixed shipped tag:

```rust
const PREVIOUS_TAG: &str = "v0.1.0-staging.1";

pub fn binary() -> PathBuf {
    if let Some(path) = std::env::var_os("KANNA_PREVIOUS_DAEMON_BIN") {
        return PathBuf::from(path);
    }

    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates directory")
        .parent()
        .expect("repository root")
        .to_path_buf();
    let commit = command_stdout(
        Command::new("git")
            .current_dir(&repo)
            .args(["rev-parse", PREVIOUS_TAG]),
    );
    let root = repo.join(".build/daemon-cross-version").join(format!(
        "{}-{}-{}",
        commit.trim(),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let binary = root.join("target/debug/kanna-daemon");
    if binary.is_file() {
        return binary;
    }

    let _lock = BuildLock::acquire(&root, &binary);
    if !binary.is_file() {
        materialize_archive(&repo, &root);
        let status = Command::new("cargo")
            .current_dir(root.join("source"))
            .env("CARGO_TARGET_DIR", root.join("target"))
            .args([
                "build",
                "--locked",
                "-p",
                "kanna-daemon",
                "--bin",
                "kanna-daemon",
            ])
            .status()
            .expect("build previous daemon");
        assert!(status.success(), "previous daemon fixture build failed");
    }
    binary
}
```

Use these helper implementations (with the corresponding `std` imports):

```rust
fn command_stdout(command: &mut Command) -> String {
    let output = command.output().expect("run fixture command");
    assert!(
        output.status.success(),
        "fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("fixture command output is UTF-8")
}

fn materialize_archive(repo: &Path, root: &Path) {
    let source = root.join("source");
    if source.is_dir() {
        return;
    }
    std::fs::create_dir_all(root).expect("create fixture cache root");
    let staging = root.join(format!("source.staging-{}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).expect("remove stale owned staging");
    }
    std::fs::create_dir_all(&staging).expect("create fixture staging");

    let mut archive = Command::new("git")
        .current_dir(repo)
        .args(["archive", PREVIOUS_TAG])
        .stdout(Stdio::piped())
        .spawn()
        .expect("start git archive");
    let archive_stdout = archive.stdout.take().expect("git archive stdout");
    let extract = Command::new("tar")
        .args(["-x", "-C"])
        .arg(&staging)
        .stdin(Stdio::from(archive_stdout))
        .status()
        .expect("extract previous source");
    let archived = archive.wait().expect("wait for git archive");
    assert!(archived.success(), "git archive failed");
    assert!(extract.success(), "tar extraction failed");
    std::fs::rename(staging, source).expect("publish previous source atomically");
}

struct BuildLock {
    path: Option<PathBuf>,
}

impl BuildLock {
    fn acquire(root: &Path, binary: &Path) -> Self {
        std::fs::create_dir_all(root).expect("create fixture cache root");
        let path = root.join("build.lock");
        loop {
            if binary.is_file() {
                return Self { path: None };
            }
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => {
                    return Self {
                        path: Some(path),
                    };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                        .is_ok_and(|age| age > Duration::from_secs(15 * 60));
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    } else {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
                Err(error) => panic!("acquire previous-daemon build lock: {error}"),
            }
        }
    }
}

impl Drop for BuildLock {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
```

- [ ] **Step 4: Run and verify GREEN plus cache reuse**

Run twice:

```bash
cargo test -p kanna-daemon --test handoff previous_daemon_fixture_is_the_shipped_v2_binary -- --nocapture
```

Expected: the first run builds beneath `.build/daemon-cross-version`; the second immediately reuses the binary.

### Task 4: Write the Failing Previous-v2/Current-v3 Race Regression

**Files:**
- Modify: `crates/daemon/tests/handoff.rs`

- [ ] **Step 1: Make `DaemonHandle` binary-selectable**

Refactor the existing constructor to:

```rust
impl DaemonHandle {
    fn start_in(dir: &PathBuf) -> Self {
        Self::start_binary_in(Path::new(env!("CARGO_BIN_EXE_kanna-daemon")), dir)
    }

    fn start_binary_in(binary: &Path, dir: &PathBuf) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let socket_path = compute_socket_path(dir);
        let pid_path = dir.join("daemon.pid");
        let child = Command::new(binary)
            .env("KANNA_DAEMON_DIR", dir)
            .spawn()
            .expect("failed to start daemon");
        let expected_pid = child.id();

        for _ in 0..200 {
            let ready = std::fs::read_to_string(&pid_path)
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok())
                == Some(expected_pid)
                && UnixStream::connect(&socket_path).is_ok();
            if ready {
                return DaemonHandle { child, socket_path };
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("daemon {expected_pid} did not publish");
    }
}
```

Preserve `start_in_with_env` by routing it through an equivalent internal
constructor that accepts both a binary path and extra environment entries.

- [ ] **Step 2: Extend the test wire types for agent lifecycle commands**

Add these `Cmd` variants using the current shared types:

```rust
SpawnAgent {
    session_id: String,
    params: kanna_daemon::protocol::AgentSpawnParams,
},
AttachAgent {
    session_id: String,
    from_seq: u64,
},
AgentInput {
    session_id: String,
    text: String,
},
Kill {
    session_id: String,
},
```

Add `AgentSnapshot` and `AgentEvent` variants to `Evt`. Use
`kanna_agent_protocol::AgentEvent` for event payloads. Add a shell fixture that
emits Claude-shaped init, assistant, and turn-complete NDJSON, then reads
subsequent input and emits another completed turn.

- [ ] **Step 3: Add deterministic stable-session and churn helpers**

Implement:

```rust
fn spawn_lifecycle_churn(
    socket_path: PathBuf,
    script: PathBuf,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut sequence = 0_u64;
        while !stop.load(Ordering::SeqCst) {
            sequence += 1;
            if let Ok(stream) = UnixStream::connect(&socket_path) {
                let mut conn = ClientConn::from_stream(stream);
                let pty_id = format!("churn-pty-{sequence}");
                let _ = conn.try_round_trip(&Cmd::Spawn {
                    session_id: pty_id.clone(),
                    executable: "/bin/cat".to_string(),
                    args: Vec::new(),
                    cwd: "/tmp".to_string(),
                    env: HashMap::new(),
                    cols: 80,
                    rows: 24,
                });
                let _ = conn.try_round_trip(&Cmd::Kill { session_id: pty_id });

                let agent_id = format!("churn-agent-{sequence}");
                let _ = conn.try_round_trip(&Cmd::SpawnAgent {
                    session_id: agent_id.clone(),
                    params: agent_params(&script, "churn"),
                });
                let _ = conn.try_round_trip(&Cmd::Kill {
                    session_id: agent_id,
                });
            }
        }
    })
}
```

`ClientConn::from_stream` installs a 5-second read timeout and clones the stream
for its buffered reader. `try_round_trip` writes one JSON line and returns the
next deserializable event or the socket error; EOF/reset is an accepted churn
result during ownership cutover.

- [ ] **Step 4: Add the cross-binary behavior test**

Add:

```rust
#[test]
fn shipped_v2_hands_stable_pty_and_agent_to_v3_during_lifecycle_churn() {
    let dir = test_dir("v2-v3-race");
    cleanup(&dir);
    let script = write_steerable_agent(&dir);
    let previous = support::previous_daemon::binary();
    let mut old = DaemonHandle::start_binary_in(&previous, &dir);

    spawn_echo(&mut old.connect(), "stable-pty");
    spawn_agent(&mut old.connect(), "stable-agent", &script, "before handoff");
    assert_pty_round_trip(&old, "stable-pty", b"before\n", "before");
    assert_agent_round_trip(&old, "stable-agent", "first turn");

    let stop = Arc::new(AtomicBool::new(false));
    let churn = spawn_lifecycle_churn(old.socket_path.clone(), script, stop.clone());
    let current = DaemonHandle::start_in(&dir);
    stop.store(true, Ordering::SeqCst);
    churn.join().expect("lifecycle churn thread");

    assert!(
        wait_for_child_exit(&mut old.child, Duration::from_secs(10)).is_some(),
        "v2 incumbent should exit after its snapshot is adopted"
    );
    assert_pty_round_trip(&current, "stable-pty", b"after\n", "after");
    assert_agent_round_trip(&current, "stable-agent", "after handoff");
    assert_daemon_log_contains(&dir, "selected legacy-v2 mode");
    cleanup(&dir);
}
```

The helper assertions must ignore unrelated status/output events but fail on a
stable-session `Error` or `Exit`. No assertion is made about ids prefixed
`churn-`, because v2 cannot define their snapshot ordering.

- [ ] **Step 5: Run and verify RED**

Run:

```bash
cargo test -p kanna-daemon --test handoff shipped_v2_hands_stable_pty_and_agent_to_v3_during_lifecycle_churn -- --nocapture --test-threads=1
```

Expected: failure because the current daemon requests v2 directly and never logs a v3-to-legacy-v2 negotiation.

### Task 5: Implement v3 and the Explicit v2 Fallback

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/tests.rs`
- Modify: `crates/daemon/tests/handoff.rs`

- [ ] **Step 1: Add shared epoch constants**

In `protocol.rs` add:

```rust
/// Transactional lifecycle-fenced and provenance-authenticated handoff.
pub const HANDOFF_PROTOCOL_VERSION: u32 = 3;

/// Deployed pre-transaction handoff retained to preserve stable live sessions.
pub const LEGACY_HANDOFF_PROTOCOL_VERSION: u32 = 2;
```

- [ ] **Step 2: Add the typed mode**

In `handoff.rs` add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HandoffMode {
    TransactionalV3,
    LegacyV2,
}

impl HandoffMode {
    fn version(self) -> u32 {
        match self {
            Self::TransactionalV3 => protocol::HANDOFF_PROTOCOL_VERSION,
            Self::LegacyV2 => protocol::LEGACY_HANDOFF_PROTOCOL_VERSION,
        }
    }
}

pub(crate) fn handoff_mode_for_version(version: u32) -> Option<HandoffMode> {
    match version {
        protocol::HANDOFF_PROTOCOL_VERSION => Some(HandoffMode::TransactionalV3),
        protocol::LEGACY_HANDOFF_PROTOCOL_VERSION => Some(HandoffMode::LegacyV2),
        _ => None,
    }
}
```

- [ ] **Step 3: Restrict fallback to an explicit pre-transfer mismatch**

Replace `should_try_compat_handoff_after_error` with:

```rust
pub(crate) fn legacy_fallback_after_error(
    error: &HandoffRequestError,
) -> Option<HandoffMode> {
    match error {
        HandoffRequestError::OldDaemonRefused(message)
            if message.contains("handoff version mismatch") =>
        {
            Some(HandoffMode::LegacyV2)
        }
        _ => None,
    }
}
```

Make `request_handoff` accept a mode and use `mode.version()`. Make
`attempt_handoff` request `TransactionalV3`, then request `LegacyV2` exactly
once only when this function returns it. Remove all version 1 request,
serialization, parsing, and special ACK-close tolerance. Emit:

```rust
log::warn!(
    "[handoff] selected legacy-v2 mode; stable sessions will transfer, \
     but concurrent Spawn/Kill is outside a provable snapshot boundary"
);
```

- [ ] **Step 4: Deliberately support both versions as a current sender**

Resolve `handle_handoff`'s request with `handoff_mode_for_version`. On `None`,
return `HandoffVersionMismatch` naming expected versions 3 and 2.

For both accepted modes, retain the current sender's PTY seal, agent seal,
owned descriptor duplicates, and ACK commit. Send the normal full
`Event::HandoffReady` shape for both versions; serde-compatible older adopters
ignore optional fields they do not know. Delete `HandoffEventV1`,
`HandoffSessionV1`, and every v1 branch.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon --lib handoff_protocol_epochs_are_distinct
cargo test -p kanna-daemon --lib supported_handoff_versions_map_to_explicit_modes
cargo test -p kanna-daemon --lib explicit_v3_mismatch_selects_one_legacy_v2_fallback
cargo test -p kanna-daemon --lib ambiguous_handoff_failure_never_selects_legacy
cargo test -p kanna-daemon --test handoff test_handoff_explicit_v3_mismatch_retries_legacy_v2
cargo test -p kanna-daemon --test handoff shipped_v2_hands_stable_pty_and_agent_to_v3_during_lifecycle_churn -- --nocapture --test-threads=1
```

Expected: all negotiation and previous/current tests pass.

- [ ] **Step 6: Run complete handoff coverage**

Run:

```bash
cargo test -p kanna-daemon --test handoff -- --test-threads=1
cargo test -p kanna-daemon --test agent_sessions agent_session_survives_daemon_handoff -- --test-threads=1
```

Expected: current/current PTY and agent handoff tests also pass.

- [ ] **Step 7: Commit protocol plus regression**

Run:

```bash
git add crates/daemon/src/protocol.rs crates/daemon/src/handoff.rs \
  crates/daemon/src/tests.rs crates/daemon/tests/handoff.rs \
  crates/daemon/tests/support
git commit -m "feat(daemon): negotiate transactional handoff v3"
```

### Task 6: Update the Contract Documentation

**Files:**
- Modify: `crates/daemon/SPEC.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update both documents**

State explicitly:

```markdown
- Version 3 identifies the lifecycle-fenced, exact-incarnation,
  provenance-authenticated transaction.
- An explicit v3 mismatch may retry deployed version 2 once.
- Legacy v2 preserves stable live sessions with mandatory receiver checks, but
  concurrent Spawn/Kill during the v2 snapshot has unspecified ordering.
- Ambiguous failures never fallback and never permit split-brain publication.
```

Change the sequence diagram to version 3 and describe `HandoffAdopted` as the
commit point. Remove the stale `currently 1` claim and the unconditional
statement that failed handoff kills the incumbent and loses sessions.

- [ ] **Step 2: Check for stale claims**

Run:

```bash
rg -n "currently `1`|version.:1|kills the old one and starts fresh|v3|legacy v2" crates/daemon/SPEC.md CLAUDE.md
```

Expected: no stale protocol-version or unconditional-loss statements remain.

- [ ] **Step 3: Commit documentation**

Run:

```bash
git add crates/daemon/SPEC.md CLAUDE.md
git commit -m "docs(daemon): define v3 and legacy v2 handoff modes"
```

### Task 7: Full Verification

**Files:**
- Verify: all modified files

- [ ] **Step 1: Format and inspect**

Run:

```bash
cargo fmt --all -- --check
git diff --check
git status --short
```

Expected: formatting and whitespace checks pass; the worktree contains only intentional changes.

- [ ] **Step 2: Run all daemon tests**

Run:

```bash
cargo test -p kanna-daemon -- --test-threads=1
```

Expected: all unit and integration tests pass, including the cached real-v2 regression.

- [ ] **Step 3: Run canonical repository verification**

Run:

```bash
./kd test rust
```

Expected: protocol checks, frontend build, sidecar build, workspace tests, and serial daemon tests all pass.

- [ ] **Step 4: Audit requirements**

Run:

```bash
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Confirm that v3 uniquely identifies the hardened guarantees; explicit mismatch
is the only v2 fallback; v1 is gone; the actual shipped v2 daemon transfers
stable PTY and agent sessions under lifecycle churn; and documentation names
the unavoidable ordering limitation for raced v2 ids.
