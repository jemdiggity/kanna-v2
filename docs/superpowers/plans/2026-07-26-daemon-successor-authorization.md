# Daemon Successor Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize only an app-spawned successor daemon before the sender allocates a handoff owner token, seals registries, snapshots sessions, writes metadata, or transfers descriptors.

**Architecture:** Capture the sender's daemon executable path and trusted launcher executable path from kernel process metadata at startup. A focused authorizer pins the connected peer and its live direct parent by PID/start time, validates both executable paths, and rechecks identity and paths immediately before returning an unforgeable authorization result. The existing transactional handoff consumes that result before owner-token allocation and otherwise remains unchanged.

**Tech Stack:** Rust 2021, Tokio Unix sockets, macOS `libproc` process inspection, Linux `/proc` fallback, serde NDJSON protocol, real-process daemon integration tests.

---

## File Structure

- Create `crates/daemon/src/successor_auth.rs`: immutable captured trust root, kernel process lookup abstraction, peer/direct-parent authorization, final recheck, and deterministic unit tests.
- Modify `crates/daemon/src/proc_info.rs`: kernel-derived executable-path lookup for a PID on macOS and Linux.
- Modify `crates/daemon/src/main.rs`: register the focused authorization module.
- Modify `crates/daemon/src/startup.rs`: capture the launcher trust root before attempting receiver-side handoff and share it with accepted connections.
- Modify `crates/daemon/src/connection.rs`: carry the authorization policy into `handle_handoff`.
- Modify `crates/daemon/src/handoff.rs`: validate supported versions, authorize the peer, and only then allocate the existing owner token and seal registries.
- Modify `crates/daemon/src/protocol.rs`: add a specific `handoff_unauthorized` error code without changing the `Handoff` command shape or version.
- Modify `crates/daemon/src/tests.rs`: cover process lookup and deterministic authorization/recheck behavior where shared crate tests are the established home.
- Modify `crates/daemon/tests/handoff.rs`: prove an ordinary client gets no metadata or descriptors and leaves lifecycle operations usable; retain successful real replacement and compatibility coverage.
- Modify `crates/daemon/SPEC.md` and `CLAUDE.md`: document sender-side successor authorization and the preserved rolling/dev topology.

### Task 1: Kernel-Derived Executable Paths

**Files:**
- Modify: `crates/daemon/src/proc_info.rs`
- Test: `crates/daemon/src/tests.rs`

- [ ] **Step 1: Write failing current-process and child-process path tests**

Add tests that compare `proc_info::process_executable_path(std::process::id() as i32)` with `std::env::current_exe()` after canonical normalization, and spawn `/bin/cat` to prove lookup returns `/bin/cat` for another live PID:

```rust
#[test]
fn process_executable_path_is_kernel_derived_for_live_processes() {
    let current = crate::proc_info::process_executable_path(std::process::id() as libc::pid_t)
        .expect("current process path");
    assert_eq!(
        std::fs::canonicalize(current).unwrap(),
        std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap()
    );

    let mut child = std::process::Command::new("/bin/cat")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let child_path =
        crate::proc_info::process_executable_path(child.id() as libc::pid_t).unwrap();
    assert_eq!(
        std::fs::canonicalize(child_path).unwrap(),
        std::fs::canonicalize("/bin/cat").unwrap()
    );
    child.kill().unwrap();
    child.wait().unwrap();
}
```

- [ ] **Step 2: Run the test and verify the missing API failure**

Run:

```bash
cargo test -p kanna-daemon process_executable_path_is_kernel_derived_for_live_processes -- --nocapture
```

Expected: compilation fails because `process_executable_path` does not exist.

- [ ] **Step 3: Implement macOS and Linux kernel lookup**

On macOS, add the `proc_pidpath` declaration and return a `PathBuf` from its NUL-terminated buffer. On Linux, use `std::fs::read_link("/proc/{pid}/exe")`. Return `None` for invalid PIDs, lookup failure, an empty path, and unsupported targets:

```rust
pub fn process_executable_path(pid: libc::pid_t) -> Option<std::path::PathBuf> {
    if pid <= 1 {
        return None;
    }
    imp::process_executable_path(pid)
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
cargo test -p kanna-daemon process_executable_path_is_kernel_derived_for_live_processes -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit the process lookup**

```bash
git add crates/daemon/src/proc_info.rs crates/daemon/src/tests.rs
git commit -m "feat(daemon): inspect process executable paths"
```

### Task 2: Capture and Validate Successor Provenance

**Files:**
- Create: `crates/daemon/src/successor_auth.rs`
- Modify: `crates/daemon/src/main.rs`
- Test: `crates/daemon/src/successor_auth.rs`

- [ ] **Step 1: Write failing deterministic policy tests**

Define a private `ProcessLookup` trait used by production and fake lookups. Write one acceptance test and separate refusals for peer path mismatch, launcher path mismatch, missing/zombie parent, peer start change, parent start change, direct-parent change, and executable change during the final recheck.

The acceptance fixture must supply two observations for each process because authorization rechecks both immediately before success:

```rust
#[test]
fn authorizes_matching_daemon_with_live_trusted_direct_parent() {
    let policy = SuccessorAuthorizer::from_paths("/app/kanna-daemon", "/app/Kanna");
    let lookup = FakeLookup::new()
        .peer_pid(200)
        .process_sequence(200, [live_process(200, 100, (2, 0)), live_process(200, 100, (2, 0))])
        .path_sequence(200, ["/app/kanna-daemon", "/app/kanna-daemon"])
        .process_sequence(100, [live_process(100, 1, (1, 0)), live_process(100, 1, (1, 0))])
        .path_sequence(100, ["/app/Kanna", "/app/Kanna"]);

    let authorization = policy.authorize_with(7, &lookup).unwrap();

    assert_eq!(authorization.peer().pid, 200);
    assert_eq!(authorization.parent().pid, 100);
}
```

- [ ] **Step 2: Run the policy tests and verify the module/API failure**

Run:

```bash
cargo test -p kanna-daemon successor_auth::tests -- --nocapture
```

Expected: compilation fails because `successor_auth` and its policy do not exist.

- [ ] **Step 3: Implement immutable trust capture and two-phase validation**

Implement:

```rust
#[derive(Clone, Debug)]
pub(crate) struct SuccessorAuthorizer {
    daemon_executable: PathBuf,
    trusted_launcher_executable: PathBuf,
}

#[derive(Debug)]
pub(crate) struct AuthorizedSuccessor {
    peer: ProcessIdentity,
    parent: ProcessIdentity,
}
```

`SuccessorAuthorizer::capture()` must:

1. read the sender's own live process record;
2. read its live direct parent record while the app/test launcher is waiting;
3. obtain both executable paths from `process_executable_path`;
4. recheck sender and parent PID/start identities before returning; and
5. retain only the executable paths, so later app restart/reparenting does not erase the launcher trust root.

`authorize(socket_fd)` must:

1. obtain `LOCAL_PEERPID`;
2. pin the live peer PID/start and direct parent PID;
3. match the peer executable path;
4. pin the live direct parent PID/start;
5. match the trusted launcher executable path; and
6. re-read peer and parent records and paths, requiring identical PID/start, the same direct-parent relationship, live non-zombie processes, and the same trusted paths.

All errors must be closed failures with category-specific messages and without session information.

- [ ] **Step 4: Run deterministic authorization tests**

Run:

```bash
cargo test -p kanna-daemon successor_auth::tests -- --nocapture
```

Expected: all policy acceptance/refusal tests PASS.

- [ ] **Step 5: Commit the authorizer**

```bash
git add crates/daemon/src/main.rs crates/daemon/src/successor_auth.rs
git commit -m "feat(daemon): authenticate successor process provenance"
```

### Task 3: Add the Real Ordinary-Client Regression

**Files:**
- Modify: `crates/daemon/tests/handoff.rs`

- [ ] **Step 1: Write the failing ordinary-client regression**

Replace the raw-client interrupted-handoff expectation with a security
regression that:

1. starts daemon A and a live `/bin/cat` PTY;
2. connects from the integration-test process and sends supported
   `{"type":"Handoff","version":2}`;
3. requires `Error { code: HandoffUnauthorized, .. }`, never
   `HandoffReady`;
4. performs a nonblocking `recvmsg` with ancillary space and requires no
   `SCM_RIGHTS` descriptors;
5. reads daemon A's process log and requires that the existing
   post-seal `found ... owner=...` transaction marker never appeared;
6. sends input through the original PTY and observes its echo; and
7. spawns and kills a second session, proving neither registry remains sealed.

```rust
assert!(matches!(
    unauthorized_event,
    Evt::Error {
        code: Some(ErrorCode::HandoffUnauthorized),
        ..
    }
));
assert!(recv_fds_nonblocking(handoff.as_raw_fd()).is_empty());
assert!(!daemon_log.contains("sessions in manager (owner="));
send_input_and_wait_for_echo(&mut conn_a, session_id, b"still-live\n", "still-live");
spawn_echo(&mut conn_a, "post-refusal");
kill(&mut conn_a, "post-refusal");
```

- [ ] **Step 2: Run the regression against the pre-authorization behavior**

Run:

```bash
cargo test -p kanna-daemon --test handoff ordinary_client_cannot_begin_or_receive_handoff -- --nocapture
```

Expected: FAIL because the ordinary client receives `HandoffReady` and the
transaction marker appears. If the new error-code variant is needed to compile
the red test, add only that protocol enum variant; do not add authorization
behavior before observing the failure.

- [ ] **Step 3: Commit the red regression**

```bash
git add crates/daemon/src/protocol.rs crates/daemon/tests/handoff.rs
git commit -m "test(daemon): expose unauthorized handoff regression"
```

### Task 4: Put Authorization Before the Transaction

**Files:**
- Modify: `crates/daemon/src/startup.rs`
- Modify: `crates/daemon/src/connection.rs`
- Modify: `crates/daemon/src/handoff.rs`
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/tests/handoff.rs`
- Test: `crates/daemon/src/successor_auth.rs`

- [ ] **Step 1: Write a failing transaction-boundary unit test**

Add a helper that admits only supported and authorized requests to the
transaction. Test that its transaction closure is never invoked for a rejected
successor:

```rust
#[test]
fn denied_successor_never_enters_handoff_transaction() {
    let transaction_entries = Cell::new(0);
    let result = authorize_supported_handoff(
        HANDOFF_VERSION,
        || Err(AuthorizationError::PeerExecutableMismatch),
        |_| transaction_entries.set(transaction_entries.get() + 1),
    );

    assert!(result.is_err());
    assert_eq!(transaction_entries.get(), 0);
}
```

The production helper returns `AuthorizedSuccessor`; only the success branch
can continue to owner-token allocation. Keep version mismatch handling before
authorization because it discloses no session state.

- [ ] **Step 2: Run the boundary test and verify it fails**

Run:

```bash
cargo test -p kanna-daemon denied_successor_never_enters_handoff_transaction -- --nocapture
```

Expected: compilation fails because the supported-version authorization
boundary is not wired.

- [ ] **Step 3: Wire startup capture and connection sharing**

In `run_daemon`, call `SuccessorAuthorizer::capture()` immediately after CLI
argument handling, directory creation, and logging setup, but before
`attempt_handoff`. Refuse startup if the trust root cannot be captured. Wrap it
in `Arc` and clone it into every `handle_connection`.

- [ ] **Step 4: Authorize before owner allocation**

Add `ErrorCode::HandoffUnauthorized`. In `handle_handoff`:

```rust
if !is_supported_handoff_version(version) {
    // Existing mismatch response; no authorization or state disclosure.
    return false;
}

let _authorized = match successor_authorizer.authorize(socket_fd) {
    Ok(authorized) => authorized,
    Err(error) => {
        write_event(
            &mut *writer.lock().await,
            &error_event(Some(ErrorCode::HandoffUnauthorized), error.to_string()),
        )
        .await
        .ok();
        return false;
    }
};

let owner = next_handoff_owner();
```

Do not change `next_handoff_owner`, PTY/agent seal APIs, epochs, snapshot logic, receiver identity checks, descriptor provenance, or `SCM_RIGHTS` framing.

- [ ] **Step 5: Run the boundary and ordinary-client tests**

Run:

```bash
cargo test -p kanna-daemon denied_successor_never_enters_handoff_transaction -- --nocapture
cargo test -p kanna-daemon successor_auth::tests -- --nocapture
cargo test -p kanna-daemon --test handoff ordinary_client_cannot_begin_or_receive_handoff -- --nocapture
cargo check -p kanna-daemon
```

Expected: PASS with no warnings.

- [ ] **Step 6: Run valid replacement and compatibility tests**

Run:

```bash
cargo test -p kanna-daemon --test handoff test_handoff_transfers_session -- --nocapture
cargo test -p kanna-daemon --test handoff test_handoff_empty -- --nocapture
cargo test -p kanna-daemon --test handoff test_handoff_explicit_version_mismatch_retries_compat -- --nocapture
```

Expected: PASS. These real processes are both directly spawned by the same test
launcher executable, covering the development topology and unchanged wire
protocol.

- [ ] **Step 7: Mutation-test bypass and post-seal placement**

Temporarily apply each mutation, run the focused ordinary-client test, confirm
failure, and restore the production source with `apply_patch`:

1. bypass `successor_authorizer.authorize(socket_fd)` so the ordinary peer
   enters the transaction; expected failure: `HandoffReady`/descriptor
   disclosure replaces the refusal;
2. move authorization below the existing seal acquisition and transaction log
   marker; expected failure: the log-marker assertion detects entry into the
   transaction even though the request is ultimately refused.

After restoring, rerun:

```bash
cargo test -p kanna-daemon --test handoff ordinary_client_cannot_begin_or_receive_handoff -- --nocapture
git diff --check
```

Expected: PASS and no mutation remains.

- [ ] **Step 8: Commit transaction integration**

```bash
git add crates/daemon/src/startup.rs crates/daemon/src/connection.rs crates/daemon/src/handoff.rs crates/daemon/src/protocol.rs crates/daemon/src/successor_auth.rs crates/daemon/tests/handoff.rs
git commit -m "fix(daemon): authorize successor before handoff transaction"
```

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `crates/daemon/SPEC.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update protocol and invariant documentation**

Document:

- sender-side peer/parent executable provenance authorization;
- startup capture of the launcher path before reparenting;
- supported-version authorization before owner-token allocation;
- fail-closed refusal before seals, metadata, or descriptors;
- unchanged receiver-side old-daemon identity recheck;
- unchanged `Handoff` wire shape and rolling/dev compatibility.

- [ ] **Step 2: Run formatting and focused daemon verification**

Run:

```bash
cargo fmt --all -- --check
cargo test -p kanna-daemon --lib -- --nocapture
cargo test -p kanna-daemon --bin kanna-daemon -- --nocapture
cargo test -p kanna-daemon --test handoff -- --nocapture
cargo clippy -p kanna-daemon --all-targets -- -D warnings
```

Expected: all tests pass, formatting is clean, and clippy reports no warnings.

- [ ] **Step 3: Run canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: the canonical Rust suite passes with zero failures.

- [ ] **Step 4: Commit documentation**

```bash
git add crates/daemon/SPEC.md CLAUDE.md
git commit -m "docs(daemon): specify successor authorization"
```

- [ ] **Step 5: Verify final tree**

Run:

```bash
git status --short
git diff 22b99f4c3805e7c0477dc5155ffb0d680c159feb..HEAD --check
git log --oneline 22b99f4c3805e7c0477dc5155ffb0d680c159feb..HEAD
```

Expected: clean worktree, no whitespace errors, and only the design, plan,
focused implementation, tests, and documentation commits.
