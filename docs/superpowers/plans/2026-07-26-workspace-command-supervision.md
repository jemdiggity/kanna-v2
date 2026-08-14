# Workspace Command Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repository setup or teardown processes from wedging kanna-server's task-action API.

**Architecture:** A process-wide workspace-command supervisor runs shell setup in a dedicated process group, polls the direct child independently from nonblocking pipe drains, applies soft/hard deadlines, and admits at most four concurrent commands. Stage-run preparation returns a pending session when setup is required; the existing detached transition worker finalizes it and records failures asynchronously. Teardown sessions are deadline-supervised through the daemon, server status reports supervisor health, and desktop adoption requires that health to be explicitly healthy.

**Tech Stack:** Rust 2021, Tokio, Axum, libc process groups, SQLite/rusqlite, Tauri v2, existing Kanna daemon protocol and HTTP integration tests.

---

### Task 1: Supervise headless workspace commands

**Files:**
- Create: `crates/kanna-server/src/workspace_commands.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/src/task_creator/environment.rs`

- [ ] **Step 1: Write failing process-lifecycle tests**

Add unit tests in `workspace_commands.rs` using an injected `WorkspaceCommandPolicy`:

```rust
#[derive(Clone, Copy)]
struct WorkspaceCommandPolicy {
    soft_timeout: Duration,
    hard_timeout: Duration,
    final_drain_timeout: Duration,
    poll_interval: Duration,
    max_concurrent: usize,
    max_output_bytes: usize,
}

#[test]
fn hanging_command_times_out_and_kills_its_process_group() {
    let root = tempfile::tempdir().unwrap();
    let pid_file = root.path().join("grandchild.pid");
    let command = format!(
        "printf 'setup-started\\n'; sleep 30 & echo $! > '{}'; wait",
        pid_file.display()
    );
    let error = run_workspace_command_with_policy(
        "workspace setup",
        &command,
        root.path(),
        &HashMap::new(),
        test_policy(Duration::from_millis(150)),
    )
    .unwrap_err();

    assert!(error.contains("timed out"), "{error}");
    assert!(error.contains("setup-started"), "{error}");
    let pid: i32 = std::fs::read_to_string(pid_file).unwrap().trim().parse().unwrap();
    assert_process_exits(pid, Duration::from_secs(2));
}

#[test]
fn exited_parent_is_not_held_by_grandchild_pipe() {
    let root = tempfile::tempdir().unwrap();
    let started = Instant::now();
    run_workspace_command_with_policy(
        "workspace setup",
        "python3 -c 'import os,time; p=os.fork(); os._exit(0) if p else time.sleep(30)'",
        root.path(),
        &HashMap::new(),
        test_policy(Duration::from_secs(5)),
    )
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn concurrent_hangs_never_exceed_the_configured_limit() {
    let supervisor = WorkspaceCommandSupervisor::new(test_policy_with_limit(
        Duration::from_millis(300),
        4,
    ));
    let barrier = Arc::new(Barrier::new(9));
    let results = (0..8)
        .map(|_| spawn_test_command(Arc::clone(&supervisor), Arc::clone(&barrier)))
        .collect::<Vec<_>>();
    barrier.wait();

    assert_eq!(supervisor.snapshot().active_workspace_commands, 4);
    let capacity_errors = results
        .into_iter()
        .filter(|join| join.join().unwrap().unwrap_err().contains("capacity"))
        .count();
    assert_eq!(capacity_errors, 4);
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p kanna-server workspace_commands::tests -- --nocapture
```

Expected: compilation fails because `workspace_commands` and its supervisor API do not exist.

- [ ] **Step 3: Implement the supervisor and nonblocking pipe runner**

Create `workspace_commands.rs` with:

```rust
pub(crate) const MAX_WORKSPACE_COMMANDS: usize = 4;
const SOFT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HARD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const FINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritePathHealth {
    pub(crate) healthy: bool,
    pub(crate) status: String,
    pub(crate) active_workspace_commands: usize,
    pub(crate) max_workspace_commands: usize,
    pub(crate) long_running_workspace_commands: usize,
    pub(crate) oldest_workspace_command_seconds: Option<u64>,
}

pub(crate) fn run_workspace_command(
    label: &str,
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    global_supervisor().run(label, command, cwd, env)
}

pub(crate) fn write_path_health() -> WritePathHealth {
    global_supervisor().snapshot()
}
```

`WorkspaceCommandSupervisor::run` must acquire a fail-fast permit, spawn
`/bin/zsh --login -c`, and establish a process group:

```rust
use std::os::unix::process::CommandExt;

let mut command = Command::new("/bin/zsh");
command
    .args(["--login", "-c", shell_command])
    .current_dir(cwd)
    .envs(env)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
unsafe {
    command.pre_exec(|| {
        if libc::setsid() == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    });
}
```

Set stdout/stderr `O_NONBLOCK` with `fcntl`, poll `try_wait`, drain both
descriptors into capped buffers, log once after the soft threshold, and call
`libc::kill(-pid, SIGKILL)` at hard timeout or after the direct child exits.
Poll reaping and pipe draining only until `final_drain_timeout`. Format nonzero
and timeout errors with captured stdout/stderr and a truncation marker.
Represent active operations in a mutex-protected map so `snapshot` can compute
active count, oldest age, and long-running count.

Declare `mod workspace_commands;` in `main.rs`. Replace
`Command::output()` in `run_workspace_setup_commands` with:

```rust
crate::workspace_commands::run_workspace_command(
    "workspace setup",
    &command,
    Path::new(worktree_path),
    env,
)
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server workspace_commands::tests -- --nocapture
cargo test -p kanna-server task_creator::tests::setup -- --nocapture
```

Expected: all selected tests pass, and the timeout test completes in seconds.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server/src/main.rs crates/kanna-server/src/workspace_commands.rs crates/kanna-server/src/task_creator/environment.rs
git commit -m "fix(server): supervise workspace setup processes"
```

### Task 2: Defer stage setup into detached transitions

**Files:**
- Modify: `crates/kanna-server/src/task_creator/types.rs`
- Modify: `crates/kanna-server/src/task_creator/mod.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/setup.rs`
- Modify: `crates/kanna-server/src/http_api/task_actions.rs`
- Modify: `crates/kanna-server/src/http_api/tests/actions.rs`

- [ ] **Step 1: Write failing preparation and HTTP tests**

Replace the eager assertion in the stage-fork setup test with:

```rust
let mut run = match prepare_advance_stage_for_api(&db, &config, "task-1").unwrap() {
    PreparedStageTransition::Run(run) => run,
    _ => panic!("expected stage fork"),
};
assert!(!expected.exists(), "request-path preparation must not run setup");
assert!(run.has_deferred_setup());

finish_deferred_stage_setup(&mut run).unwrap();
assert!(expected.exists(), "detached finalization must run setup");
assert!(!run.has_deferred_setup());
```

Add a real-router test in `http_api/tests/actions.rs` whose repo config setup
writes `setup-started`, waits on a release file, then writes `setup-finished`.
Issue `POST /v1/tasks/source-1/actions/advance-stage` under a one-second timeout:

```rust
let response = tokio::time::timeout(
    Duration::from_secs(1),
    app.oneshot(
        Request::post("/v1/tasks/source-1/actions/advance-stage")
            .body(Body::empty())
            .unwrap(),
    ),
)
.await
.expect("stage action must return while setup is running")
.unwrap();
assert_eq!(response.status(), StatusCode::OK);
wait_for_path(&setup_started).await;
assert!(!setup_finished.exists());
std::fs::write(&release_setup, "").unwrap();
let task = wait_for_task_stage(&db, "source-1", "review").await;
assert_eq!(task.stage.as_deref(), Some("review"));
```

Add a second route test with an injected short setup policy and a forever-hung
setup. Poll `latest_stage_run` and assert:

```rust
assert_eq!(failed.stage, "review");
assert_eq!(failed.status, "failed");
assert!(failed.result.unwrap().contains("workspace setup timed out"));
assert_eq!(
    db.get_pipeline_item("source-1").unwrap().unwrap().stage.as_deref(),
    Some("in progress")
);
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p kanna-server stage_fork_runs_repo_setup_before_resolving_pty_provider -- --nocapture
cargo test -p kanna-server advance_stage_route_returns_while_workspace_setup_runs -- --nocapture
```

Expected: the preparation test observes eager setup and the route exceeds the
response deadline.

- [ ] **Step 3: Add pending-session state**

Add to `types.rs`:

```rust
pub(super) struct DeferredStageSetup {
    pub(super) commands: Vec<String>,
    pub(super) provider_candidates: Vec<AgentProvider>,
    pub(super) source_agent_type: Option<String>,
    pub(super) final_prompt: String,
    pub(super) model: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) allowed_tools: Vec<String>,
    pub(super) mcp_config_path: Option<String>,
    pub(super) claude_resume: Option<String>,
}
```

Change `PreparedStageRunSpawn` to hold:

```rust
pub(super) agent_provider: Option<String>,
pub(super) provider_session_id: Option<String>,
pub(super) session: Option<PreparedSessionSpawn>,
pub(super) deferred_setup: Option<DeferredStageSetup>,
```

Provide test-only `has_deferred_setup()`.

In `prepare_stage_run_spawn`, preserve existing eager construction only when
the setup list is empty. For nonempty setup, store `DeferredStageSetup` and do
not call `run_workspace_setup_commands`, provider executable resolution, or
`build_prepared_session`.

Add `finish_deferred_stage_setup`:

```rust
pub(crate) fn finish_deferred_stage_setup(
    prepared: &mut PreparedStageRunSpawn,
) -> Result<(), String> {
    let Some(deferred) = prepared.deferred_setup.take() else {
        return Ok(());
    };
    run_workspace_setup_commands(&deferred.commands, &prepared.cwd, &prepared.env)?;
    let provider = deferred
        .provider_candidates
        .iter()
        .copied()
        .find(|provider| {
            resolve_provider_executable(
                *provider,
                prepared.env.get("PATH").map(String::as_str),
                &prepared.cwd,
            )
            .is_ok()
        })
        .ok_or_else(|| {
            format!(
                "None of the configured agent providers are available: {}.",
                deferred
                    .provider_candidates
                    .iter()
                    .map(|provider| provider.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    let agent_type = resolve_agent_type(deferred.source_agent_type.as_deref(), provider)?;
    let (session, provider_session_id) = build_prepared_session(
        provider,
        agent_type,
        &prepared.task_id,
        &prepared.run_stage,
        &prepared.workflow_name,
        Some(prepared.completion_transition.as_str()),
        deferred.final_prompt,
        deferred.model,
        deferred.permission_mode,
        deferred.allowed_tools,
        Vec::new(),
        None,
        None,
        deferred.mcp_config_path,
        &prepared.env,
        &prepared.cwd,
        &[],
        false,
        deferred.claude_resume.as_deref(),
    )?;
    prepared.agent_provider = Some(provider.as_str().to_string());
    prepared.provider_session_id = provider_session_id;
    prepared.session = Some(session);
    Ok(())
}
```

Store `workflow_name` on `PreparedStageRunSpawn`, and update ready-session
callers/tests to unwrap through focused helper methods rather than duplicating
state checks.

- [ ] **Step 4: Finalize and record failure in the detached worker**

At the start of `spawn_prepared_stage_run_for_api`, call
`finish_deferred_stage_setup`. On error:

```rust
if let Err(error) = finish_deferred_stage_setup(&mut prepared) {
    let rollback_error = rollback_prepared_stage_fork(&prepared, error);
    return Err(record_stage_transition_failure(db_path, &prepared, &rollback_error));
}
```

Add `record_stage_transition_failure` mirroring rerun failure bookkeeping:

```rust
let db = Db::open(db_path).map_err(|e| format!("db error: {e}"))?;
db.update_pipeline_item_activity(&prepared.task_id, "unread")
    .map_err(|e| format!("db error: {e}"))?;
let result = format!(
    "failed to start stage {}: {}",
    prepared.run_stage, error
);
db.insert_stage_run(NewStageRun {
    id: &generate_stage_run_id(&prepared.task_id),
    task_id: &prepared.task_id,
    stage: &prepared.run_stage,
    kind: prepared.run_kind,
    agent: prepared.stage_agent.as_deref(),
    agent_provider: prepared.agent_provider.as_deref(),
    model: prepared.model.as_deref(),
    status: "failed",
    result: Some(&result),
    feedback: Some("stage transition failed"),
    session_id: Some(&prepared.session_id),
    provider_session_id: prepared.provider_session_id.as_deref(),
    cwd: None,
    resumed_from_run_id: prepared.resumed_from_run_id.as_deref(),
})
```

Require ready `agent_provider` and `session` only after finalization. Leave
`execute_stage_transition_detached` as the owner of this lifecycle so the HTTP
handler returns before setup starts/finishes.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server task_creator::tests::setup -- --nocapture
cargo test -p kanna-server advance_stage_route_returns_while_workspace_setup_runs -- --nocapture
cargo test -p kanna-server timed_out_workspace_setup_records_failed_stage_run -- --nocapture
```

Expected: all selected tests pass; response timing is independent of setup,
and the timeout appears in the latest failed run.

- [ ] **Step 6: Commit**

```bash
git add crates/kanna-server/src/task_creator/types.rs crates/kanna-server/src/task_creator/mod.rs crates/kanna-server/src/task_creator/lifecycle.rs crates/kanna-server/src/task_creator/tests/setup.rs crates/kanna-server/src/http_api/task_actions.rs crates/kanna-server/src/http_api/tests/actions.rs
git commit -m "fix(server): detach stage workspace setup"
```

### Task 3: Bound teardown and kill daemon PTY process groups

**Files:**
- Modify: `crates/daemon/src/pty.rs`
- Modify: `crates/kanna-server/src/task_creator/lifecycle.rs`

- [ ] **Step 1: Write failing process-group and teardown-deadline tests**

Add a daemon PTY test:

```rust
#[test]
fn kill_terminates_the_entire_pty_process_group() {
    let root = tempfile::tempdir().unwrap();
    let pid_file = root.path().join("grandchild.pid");
    let mut session = PtySession::spawn(
        "/bin/sh",
        &[
            "-c".to_string(),
            format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()),
        ],
        root.path().to_str().unwrap(),
        &HashMap::new(),
        80,
        24,
    )
    .unwrap();
    wait_for_path(&pid_file);
    let grandchild = read_pid(&pid_file);
    session.kill().unwrap();
    assert_process_exits(grandchild, Duration::from_secs(2));
}
```

Add a lifecycle test with short injected teardown timing. Its fake daemon
returns `SessionCreated` for `td-*`, reports that session from `List`, then
expects `Kill` before the test deadline.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test -p kanna-daemon kill_terminates_the_entire_pty_process_group -- --nocapture
cargo test -p kanna-server teardown_session_is_killed_at_its_deadline -- --nocapture
```

Expected: the grandchild remains alive and no deadline kill is sent.

- [ ] **Step 3: Kill daemon process groups**

Change `PtySession::kill`:

```rust
pub fn kill(&mut self) -> io::Result<()> {
    let ret = unsafe { libc::kill(-self.child_pid, libc::SIGKILL) };
    if ret != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}
```

Keep `SessionHandle::kill`'s existing direct-child background reaper.

- [ ] **Step 4: Schedule teardown observation and timeout**

After a teardown receives `SessionCreated`, spawn an async supervisor carrying
the daemon directory and session id. At 10 minutes, reconnect, issue `List`,
and log a warning only when the session is still present. At 30 minutes, repeat
the presence check and issue `Kill` if present:

```rust
tokio::spawn(async move {
    tokio::time::sleep(TEARDOWN_SOFT_TIMEOUT).await;
    if daemon_session_exists(&daemon_dir, &session_id).await {
        log::warn!("workspace teardown {session_id} exceeded 600s");
    } else {
        return;
    }
    tokio::time::sleep(TEARDOWN_HARD_TIMEOUT - TEARDOWN_SOFT_TIMEOUT).await;
    if let Ok(mut daemon) = DaemonClient::connect(&daemon_dir).await {
        if daemon_session_exists_with(&mut daemon, &session_id).await {
            log::error!("workspace teardown {session_id} timed out; killing process group");
            let _ = daemon
                .send_command(&DaemonCommand::Kill { session_id })
                .await;
        }
    }
});
```

Use test-only injected durations so production constants remain 10/30 minutes.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
cargo test -p kanna-daemon pty::tests -- --nocapture
cargo test -p kanna-server teardown_session_is_killed_at_its_deadline -- --nocapture
```

Expected: both selected suites pass.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/pty.rs crates/kanna-server/src/task_creator/lifecycle.rs
git commit -m "fix(server): bound workspace teardown groups"
```

### Task 4: Report write-path health

**Files:**
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/http_api/state.rs`
- Modify: `crates/kanna-server/src/http_api/tests/revision_status.rs`
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.test.ts`

- [ ] **Step 1: Write failing status tests**

Extend the real status route test:

```rust
let status: MobileServerStatus = from_slice(&body).unwrap();
assert_eq!(status.write_path_health.status, "healthy");
assert!(status.write_path_health.healthy);
assert_eq!(status.write_path_health.active_workspace_commands, 0);
assert_eq!(status.write_path_health.max_workspace_commands, 4);
```

Add a supervisor snapshot unit test that injects an active start time older
than the soft threshold and expects `degraded`, `healthy == false`, and
`long_running_workspace_commands == 1`.

Update remote transport mapping tests to require:

```typescript
writePathHealth: {
  healthy: true,
  status: "healthy",
  activeWorkspaceCommands: 0,
  maxWorkspaceCommands: 4,
  longRunningWorkspaceCommands: 0,
  oldestWorkspaceCommandSeconds: null
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test -p kanna-server status_route -- --nocapture
pnpm --dir apps/mobile exec vitest run src/lib/transports/remoteTransport.test.ts
```

Expected: status types/mapping lack `writePathHealth`.

- [ ] **Step 3: Add the status contract**

Add `write_path_health: WritePathHealth` to `MobileServerStatus` and populate it
in `build_mobile_server_status`:

```rust
write_path_health: crate::workspace_commands::write_path_health(),
```

Mirror the camelCase object in `apps/mobile/src/lib/api/types.ts`. In
`mapMobileServerStatus`, validate every required health field and return it
unchanged. Keep remote status strict because current servers always provide
the field; desktop adoption handles legacy absence separately.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server status_route -- --nocapture
pnpm --dir apps/mobile exec vitest run src/lib/transports/remoteTransport.test.ts
```

Expected: selected Rust and TypeScript tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server/src/mobile_api.rs crates/kanna-server/src/http_api/state.rs crates/kanna-server/src/http_api/tests/revision_status.rs apps/mobile/src/lib/api/types.ts apps/mobile/src/lib/transports/remoteTransport.ts apps/mobile/src/lib/transports/remoteTransport.test.ts
git commit -m "feat(server): expose write path health"
```

### Task 5: Reject unhealthy server adoption

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/mod.rs`

- [ ] **Step 1: Write failing adoption tests**

Extend `current_server_status_requires_matching_build_metadata` with a healthy
health object and add:

```rust
let unhealthy = MobileServerStatus {
    write_path_health: Some(WritePathHealth {
        healthy: false,
        status: "degraded".to_string(),
        active_workspace_commands: 4,
        max_workspace_commands: 4,
        long_running_workspace_commands: 4,
        oldest_workspace_command_seconds: Some(601),
    }),
    ..status.clone()
};
assert!(!is_current_server_status(
    &unhealthy,
    "desktop-1",
    current_server_version(),
    "production",
));
```

Add a legacy JSON assertion where `writePathHealth` is absent and adoption is
false. Add an integration variant of `manager_replaces_stale_server...` using
matching version/environment but a test server status with unhealthy health,
then assert the old PID exits and replacement reports healthy.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml current_server_status_requires_matching_build_metadata -- --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml manager_replaces_unhealthy_current_server -- --nocapture
```

Expected: the status type has no health field and identity-matching unhealthy
status is still adopted.

- [ ] **Step 3: Require explicit health**

Add desktop-local deserialization structs:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritePathHealth {
    pub healthy: bool,
    pub status: String,
    pub active_workspace_commands: usize,
    pub max_workspace_commands: usize,
    pub long_running_workspace_commands: usize,
    pub oldest_workspace_command_seconds: Option<u64>,
}
```

Add `#[serde(default)] pub write_path_health: Option<WritePathHealth>` to
`MobileServerStatus`, set a healthy object in `stopped_snapshot`, and change:

```rust
status.desktop_id == expected_desktop_id
    && status.version == expected_version
    && status.environment == expected_environment
    && status
        .write_path_health
        .as_ref()
        .is_some_and(|health| health.healthy)
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::mobile::tests -- --nocapture
```

Expected: mobile server manager/adoption tests pass, including legacy and
unhealthy replacement.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/mobile/mod.rs
git commit -m "fix(desktop): replace unhealthy kanna server"
```

### Task 6: Cross-boundary regression and full verification

**Files:**
- No production files; this task verifies the implementation produced by Tasks
  1–5.

- [ ] **Step 1: Run focused incident regression**

```bash
cargo test -p kanna-server workspace_commands::tests -- --nocapture
cargo test -p kanna-server task_creator::tests::setup -- --nocapture
cargo test -p kanna-server http_api::tests::actions -- --nocapture
cargo test -p kanna-daemon pty::tests -- --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::mobile::tests -- --nocapture
pnpm --dir apps/mobile exec vitest run src/lib/transports/remoteTransport.test.ts
```

Expected: every command exits 0 with zero failed tests.

- [ ] **Step 2: Run repository verification**

```bash
pnpm test
./kd test rust
```

Expected: both canonical suites exit 0.

- [ ] **Step 3: Inspect the finished change**

```bash
git status --short
git diff HEAD^ --check
git log --oneline --decorate -8
```

Expected: no whitespace errors or unrelated changes; only the implementation
and its design/plan commits are present.

- [ ] **Step 4: Request code review and address findings**

Review against:

```text
docs/superpowers/specs/2026-07-26-workspace-command-supervision-design.md
```

Critical and Important findings must be fixed with a new failing regression
test followed by the focused and canonical verification commands.
