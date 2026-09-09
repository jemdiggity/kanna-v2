use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const MAX_WORKSPACE_COMMANDS: usize = 4;
const SOFT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HARD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const FINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const BACKGROUND_REAP_GIVE_UP_AFTER: Duration = Duration::from_secs(60);
const BACKGROUND_REAP_MAX_INTERVAL: Duration = Duration::from_secs(1);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// Hang containment for a test that arms the hard timeout explicitly. Nothing
/// asserts against it; it only stops a wedged fixture from running forever.
#[cfg(test)]
const TEST_ARMED_TIMEOUT_GUARD: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
struct WorkspaceCommandPolicy {
    soft_timeout: Duration,
    hard_timeout: Duration,
    final_drain_timeout: Duration,
    poll_interval: Duration,
    max_concurrent: usize,
    max_output_bytes: usize,
}

impl Default for WorkspaceCommandPolicy {
    fn default() -> Self {
        Self {
            soft_timeout: SOFT_TIMEOUT,
            hard_timeout: HARD_TIMEOUT,
            final_drain_timeout: FINAL_DRAIN_TIMEOUT,
            poll_interval: POLL_INTERVAL,
            max_concurrent: MAX_WORKSPACE_COMMANDS,
            max_output_bytes: MAX_OUTPUT_BYTES,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritePathHealth {
    pub healthy: bool,
    pub status: String,
    pub active_workspace_commands: usize,
    pub max_workspace_commands: usize,
    pub long_running_workspace_commands: usize,
    pub oldest_workspace_command_seconds: Option<u64>,
}

struct SupervisorState {
    next_id: u64,
    active: HashMap<u64, Instant>,
}

struct ActiveCommand {
    supervisor: Arc<WorkspaceCommandSupervisor>,
    id: u64,
}

impl Drop for ActiveCommand {
    fn drop(&mut self) {
        self.supervisor
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active
            .remove(&self.id);
    }
}

struct WorkspaceCommandSupervisor {
    policy: WorkspaceCommandPolicy,
    state: Mutex<SupervisorState>,
}

impl WorkspaceCommandSupervisor {
    fn new(policy: WorkspaceCommandPolicy) -> Self {
        Self {
            policy,
            state: Mutex::new(SupervisorState {
                next_id: 1,
                active: HashMap::new(),
            }),
        }
    }

    fn acquire(self: &Arc<Self>, label: &str) -> Result<ActiveCommand, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active.len() >= self.policy.max_concurrent {
            return Err(format!(
                "{label} rejected: workspace command capacity is full ({}/{})",
                state.active.len(),
                self.policy.max_concurrent
            ));
        }
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        state.active.insert(id, Instant::now());
        Ok(ActiveCommand {
            supervisor: Arc::clone(self),
            id,
        })
    }

    fn run(
        self: &Arc<Self>,
        label: &str,
        shell_command: &str,
        cwd: &Path,
        env: &HashMap<String, String>,
        armed_timeout: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let _active = self.acquire(label)?;
        run_process(label, shell_command, cwd, env, self.policy, armed_timeout)
    }

    fn snapshot(&self) -> WritePathHealth {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let oldest = state
            .active
            .values()
            .map(|started| now.saturating_duration_since(*started))
            .max();
        let long_running = state
            .active
            .values()
            .filter(|started| now.saturating_duration_since(**started) >= self.policy.soft_timeout)
            .count();
        let healthy = long_running == 0;
        let status = if healthy && state.active.is_empty() {
            "healthy"
        } else if healthy {
            "busy"
        } else {
            "degraded"
        };
        WritePathHealth {
            healthy,
            status: status.to_string(),
            active_workspace_commands: state.active.len(),
            max_workspace_commands: self.policy.max_concurrent,
            long_running_workspace_commands: long_running,
            oldest_workspace_command_seconds: oldest.map(|elapsed| elapsed.as_secs()),
        }
    }
}

fn global_supervisor() -> &'static Arc<WorkspaceCommandSupervisor> {
    static SUPERVISOR: OnceLock<Arc<WorkspaceCommandSupervisor>> = OnceLock::new();
    SUPERVISOR.get_or_init(|| {
        Arc::new(WorkspaceCommandSupervisor::new(
            WorkspaceCommandPolicy::default(),
        ))
    })
}

pub(crate) fn run_workspace_command(
    label: &str,
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    global_supervisor().run(label, command, cwd, env, None)
}

pub(crate) fn write_path_health() -> WritePathHealth {
    global_supervisor().snapshot()
}

/// Fire the hard timeout on an explicit signal instead of the wall clock.
///
/// A test that proves timeout handling must first get the supervised process
/// into the state under test — output produced, descendants spawned. A fixed
/// budget cannot express that ordering: on a loaded machine it can expire
/// while the login shell is still sourcing profiles, so the test asserts
/// against machine speed rather than against the timeout path. The caller
/// therefore observes that state itself and arms this flag; the accompanying
/// duration is only hang containment for a fixture that never arms it.
#[cfg(test)]
pub(crate) fn run_workspace_command_with_armed_timeout_for_test(
    label: &str,
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    armed_timeout: &AtomicBool,
) -> Result<(), String> {
    let supervisor = Arc::new(WorkspaceCommandSupervisor::new(WorkspaceCommandPolicy {
        soft_timeout: TEST_ARMED_TIMEOUT_GUARD,
        hard_timeout: TEST_ARMED_TIMEOUT_GUARD,
        final_drain_timeout: FINAL_DRAIN_TIMEOUT,
        poll_interval: Duration::from_millis(10),
        max_concurrent: MAX_WORKSPACE_COMMANDS,
        max_output_bytes: MAX_OUTPUT_BYTES,
    }));
    supervisor.run(label, command, cwd, env, Some(armed_timeout))
}

struct SupervisedChild {
    child: Option<Child>,
    process_group: i32,
    termination_sent: bool,
    direct_child_reaped: bool,
}

impl SupervisedChild {
    fn child_mut(&mut self) -> &mut Child {
        self.child
            .as_mut()
            .expect("supervised child ownership must remain local until cleanup")
    }

    fn try_wait(&mut self, label: &str) -> Result<Option<ExitStatus>, String> {
        let status = self
            .child_mut()
            .try_wait()
            .map_err(|error| format!("failed to wait for {label}: {error}"))?;
        self.direct_child_reaped |= status.is_some();
        Ok(status)
    }

    fn terminate_once(&mut self) {
        if self.termination_sent {
            return;
        }
        self.termination_sent = true;
        kill_process_group(self.process_group);
        if let Err(error) = self.child_mut().kill() {
            if error.kind() != io::ErrorKind::InvalidInput {
                log::debug!(
                    "direct workspace child {} could not be killed during cleanup: {error}",
                    self.process_group
                );
            }
        }
    }

    fn terminate_and_reap(
        &mut self,
        label: &str,
        deadline: Instant,
        poll_interval: Duration,
    ) -> Result<(), String> {
        if self.child.is_none() {
            return Ok(());
        }
        self.terminate_once();
        if self.direct_child_reaped {
            self.child.take();
            return Ok(());
        }
        while Instant::now() < deadline {
            match self.child_mut().try_wait() {
                Ok(Some(_)) => {
                    self.direct_child_reaped = true;
                    self.child.take();
                    return Ok(());
                }
                Ok(None) => std::thread::sleep(poll_interval),
                Err(error) => {
                    hand_off_to_background_reaper(self.child.take().unwrap());
                    return Err(format!("failed to reap {label}: {error}"));
                }
            }
        }
        log::error!(
            "{label} direct child {} did not become reapable after process-group kill; \
             continuing reap in the background",
            self.process_group
        );
        hand_off_to_background_reaper(self.child.take().unwrap());
        Ok(())
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        if self.child.is_some() {
            if let Err(error) = self.terminate_and_reap(
                "workspace command",
                Instant::now() + FINAL_DRAIN_TIMEOUT,
                POLL_INTERVAL,
            ) {
                log::warn!("{error}");
            }
        }
    }
}

fn background_reaper() -> &'static mpsc::Sender<Child> {
    struct ReapEntry {
        child: Child,
        deadline: Instant,
        next_poll: Instant,
        delay: Duration,
    }

    impl ReapEntry {
        fn new(child: Child) -> Self {
            let now = Instant::now();
            Self {
                child,
                deadline: now + BACKGROUND_REAP_GIVE_UP_AFTER,
                next_poll: now,
                delay: POLL_INTERVAL,
            }
        }
    }

    static REAPER: OnceLock<mpsc::Sender<Child>> = OnceLock::new();
    REAPER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel::<Child>();
        if let Err(error) = std::thread::Builder::new()
            .name("workspace-child-reaper".to_string())
            .spawn(move || {
                let mut children = Vec::<ReapEntry>::new();
                loop {
                    if children.is_empty() {
                        let Ok(child) = receiver.recv() else {
                            return;
                        };
                        children.push(ReapEntry::new(child));
                    } else {
                        let now = Instant::now();
                        let wait = children
                            .iter()
                            .map(|entry| entry.next_poll.saturating_duration_since(now))
                            .min()
                            .unwrap_or(POLL_INTERVAL);
                        match receiver.recv_timeout(wait) {
                            Ok(child) => children.push(ReapEntry::new(child)),
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    while let Ok(child) = receiver.try_recv() {
                        children.push(ReapEntry::new(child));
                    }
                    let now = Instant::now();
                    children.retain_mut(|entry| {
                        if now < entry.next_poll {
                            return true;
                        }
                        match entry.child.try_wait() {
                            Ok(Some(_)) => false,
                            Ok(None) if now >= entry.deadline => {
                                log::warn!(
                                    "workspace child still not reapable after {:?}; abandoning reap",
                                    BACKGROUND_REAP_GIVE_UP_AFTER
                                );
                                false
                            }
                            Ok(None) => {
                                entry.delay =
                                    (entry.delay * 2).min(BACKGROUND_REAP_MAX_INTERVAL);
                                entry.next_poll = now + entry.delay;
                                true
                            }
                            Err(error) => {
                                log::warn!("background workspace child reap failed: {error}");
                                false
                            }
                        }
                    });
                }
            })
        {
            log::warn!("failed to start workspace child reaper: {error}");
        }
        sender
    })
}

fn hand_off_to_background_reaper(child: Child) {
    if let Err(error) = background_reaper().send(child) {
        log::warn!("failed to hand workspace child to background reaper");
        drop(error.0);
    }
}

fn spawn_workspace_process(
    label: &str,
    shell_command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Result<SupervisedChild, String> {
    let shell = crate::login_shell::login_shell();
    let mut command = Command::new(shell.path());
    command
        .args(shell.login_args(shell_command))
        .current_dir(cwd)
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|error| format!("failed to run {label}: {error}"))?;
    Ok(SupervisedChild {
        process_group: child.id() as i32,
        child: Some(child),
        termination_sent: false,
        direct_child_reaped: false,
    })
}

fn take_nonblocking_output(
    child: &mut SupervisedChild,
    label: &str,
) -> Result<(ChildStdout, ChildStderr), String> {
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture {label} stdout"))?;
    let stderr = child
        .child_mut()
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture {label} stderr"))?;
    set_nonblocking(&stdout).map_err(|error| format!("failed to read {label} stdout: {error}"))?;
    set_nonblocking(&stderr).map_err(|error| format!("failed to read {label} stderr: {error}"))?;
    Ok((stdout, stderr))
}

fn run_process(
    label: &str,
    shell_command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    policy: WorkspaceCommandPolicy,
    armed_timeout: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut child = spawn_workspace_process(label, shell_command, cwd, env)?;
    let process_group = child.process_group;
    let (mut stdout, mut stderr) = take_nonblocking_output(&mut child, label)?;

    let started = Instant::now();
    let mut soft_logged = false;
    let mut timed_out = false;
    let mut stdout_buffer = Vec::new();
    let mut stderr_buffer = Vec::new();
    let mut truncated = false;
    let status = loop {
        drain_into(
            &mut stdout,
            &mut stdout_buffer,
            policy.max_output_bytes,
            &mut truncated,
        );
        drain_into(
            &mut stderr,
            &mut stderr_buffer,
            policy.max_output_bytes.saturating_sub(stdout_buffer.len()),
            &mut truncated,
        );
        if let Some(status) = child.try_wait(label)? {
            break Some(status);
        }
        let elapsed = started.elapsed();
        if !soft_logged && elapsed >= policy.soft_timeout {
            soft_logged = true;
            log::warn!(
                "{label} process group {process_group} exceeded soft threshold of {}s",
                policy.soft_timeout.as_secs()
            );
        }
        if elapsed >= policy.hard_timeout
            || armed_timeout.is_some_and(|armed| armed.load(Ordering::Acquire))
        {
            timed_out = true;
            child.terminate_and_reap(
                label,
                Instant::now() + policy.final_drain_timeout,
                policy.poll_interval,
            )?;
            break None;
        }
        std::thread::sleep(policy.poll_interval);
    };

    // The direct child is the completion signal. Its descendants may still
    // own inherited pipes, so terminate the group and drain only briefly.
    child.terminate_and_reap(
        label,
        Instant::now() + policy.final_drain_timeout,
        policy.poll_interval,
    )?;
    drain_final(
        stdout,
        stderr,
        &mut stdout_buffer,
        &mut stderr_buffer,
        &mut truncated,
        policy,
    );
    let details = format_output(&stdout_buffer, &stderr_buffer, truncated);
    if timed_out {
        return Err(format!(
            "{label} timed out after {}s{}",
            policy.hard_timeout.as_secs(),
            details
        ));
    }
    if status.is_some_and(|status| status.success()) {
        return Ok(());
    }
    Err(format!(
        "{label} failed with {}{details}",
        status
            .map(|status| status.to_string())
            .unwrap_or_else(|| "unknown status".to_string())
    ))
}

fn set_nonblocking<T: AsRawFd>(pipe: &T) -> io::Result<()> {
    let fd = pipe.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn kill_process_group(process_group: i32) {
    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            log::warn!("failed to kill workspace process group {process_group}: {error}");
        }
    }
}

fn drain_final(
    mut stdout_pipe: ChildStdout,
    mut stderr_pipe: ChildStderr,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    truncated: &mut bool,
    policy: WorkspaceCommandPolicy,
) {
    let deadline = Instant::now() + policy.final_drain_timeout;
    let mut stdout_done = false;
    let mut stderr_done = false;
    while !(stdout_done && stderr_done) && Instant::now() < deadline {
        stdout_done |= drain_into(&mut stdout_pipe, stdout, policy.max_output_bytes, truncated);
        let remaining = policy.max_output_bytes.saturating_sub(stdout.len());
        stderr_done |= drain_into(&mut stderr_pipe, stderr, remaining, truncated);
        if !(stdout_done && stderr_done) {
            std::thread::sleep(policy.poll_interval);
        }
    }
}

fn drain_into(
    reader: &mut impl Read,
    output: &mut Vec<u8>,
    max_bytes: usize,
    truncated: &mut bool,
) -> bool {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return true,
            Ok(count) => {
                let remaining = max_bytes.saturating_sub(output.len());
                let kept = remaining.min(count);
                output.extend_from_slice(&buffer[..kept]);
                *truncated |= kept < count;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return false,
            Err(_) => return true,
        }
    }
}

fn format_output(stdout: &[u8], stderr: &[u8], truncated: bool) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    let mut details = [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if truncated {
        if !details.is_empty() {
            details.push('\n');
        }
        details.push_str("[output truncated]");
    }
    if details.is_empty() {
        String::new()
    } else {
        format!(": {details}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};

    fn test_policy(hard_timeout: Duration, max_concurrent: usize) -> WorkspaceCommandPolicy {
        WorkspaceCommandPolicy {
            soft_timeout: Duration::from_millis(50),
            hard_timeout,
            // Reap-and-drain is a bounded wait, not a budget under test: it
            // ends as soon as the child is reapable, so a generous ceiling
            // costs nothing on a quiet box and stops a loaded one from
            // dropping output into the background reaper.
            final_drain_timeout: Duration::from_secs(2),
            poll_interval: Duration::from_millis(10),
            max_concurrent,
            max_output_bytes: 64 * 1024,
        }
    }

    fn wait_for_pid_file(path: &std::path::Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(contents) = std::fs::read_to_string(path) {
                if let Ok(pid) = contents.trim().parse() {
                    return pid;
                }
            }
            assert!(Instant::now() < deadline, "pid file was not written");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_process_exits(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let result = unsafe { libc::kill(pid, 0) };
            if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild process {pid} survived group termination"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn hanging_command_times_out_and_kills_its_process_group() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("grandchild.pid");
        let command = format!(
            "printf 'setup-started\\n'; sleep 30 & echo $! > '{}'; wait",
            pid_file.display()
        );
        // The command sleeps for 30s, so any hard timeout below that proves the
        // same thing. It is generous because the assertions below need the
        // shell to have reached its `printf` before the kill lands, and a
        // 150ms budget lost that race on a loaded machine — the shell had not
        // finished starting. 5s is ~two orders of magnitude more than a shell
        // needs to print one line; only a timeout that never fires trips it.
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(test_policy(
            Duration::from_secs(5),
            4,
        )));

        let error = supervisor
            .run(
                "workspace setup",
                &command,
                root.path(),
                &HashMap::new(),
                None,
            )
            .unwrap_err();

        assert!(error.contains("timed out"), "{error}");
        assert!(error.contains("setup-started"), "{error}");
        assert_process_exits(wait_for_pid_file(&pid_file));
    }

    #[test]
    fn dropping_spawned_command_guard_kills_and_reaps_its_process_group() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("grandchild.pid");
        let command = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let child =
            spawn_workspace_process("workspace setup", &command, root.path(), &HashMap::new())
                .unwrap();
        let direct_child_pid = child.process_group;
        let grandchild_pid = wait_for_pid_file(&pid_file);

        drop(child);

        assert_process_exits(direct_child_pid);
        assert_process_exits(grandchild_pid);
    }

    #[test]
    fn post_spawn_output_initialization_error_still_cleans_up_process_group() {
        let root = tempfile::tempdir().unwrap();
        let pid_file = root.path().join("grandchild.pid");
        let command = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
        let mut child =
            spawn_workspace_process("workspace setup", &command, root.path(), &HashMap::new())
                .unwrap();
        let direct_child_pid = child.process_group;
        let grandchild_pid = wait_for_pid_file(&pid_file);
        let captured_stdout = child.child_mut().stdout.take().unwrap();

        let error = take_nonblocking_output(&mut child, "workspace setup").unwrap_err();
        assert!(error.contains("failed to capture workspace setup stdout"));
        drop(captured_stdout);
        drop(child);

        assert_process_exits(direct_child_pid);
        assert_process_exits(grandchild_pid);
    }

    #[test]
    fn exited_parent_is_not_held_by_grandchild_pipe() {
        let root = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(test_policy(
            Duration::from_secs(5),
            4,
        )));

        supervisor
            .run(
                "workspace setup",
                "/bin/sh -c 'sleep 30 &'",
                root.path(),
                &HashMap::new(),
                None,
            )
            .unwrap();

        // `sleep 30 &` is what would hold the pipe open, so the failure this
        // guards costs 30s. A 10s ceiling keeps that order-of-magnitude signal
        // while surviving a loaded box.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "inherited pipe held the runner open for {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn concurrent_hangs_never_exceed_the_configured_limit() {
        let root = tempfile::tempdir().unwrap();
        let release_flag = root.path().join("release");
        // Winners hold their permit until the test creates the release flag,
        // so the saturated state is observed deterministically instead of
        // racing fixed sleeps against thread scheduling.
        let command = format!(
            "while [ ! -e '{}' ]; do sleep 0.05; done",
            release_flag.display()
        );
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(test_policy(
            Duration::from_secs(30),
            4,
        )));
        let (results_tx, results_rx) = std::sync::mpsc::channel();
        let barrier = Arc::new(Barrier::new(9));
        let joins = (0..8)
            .map(|_| {
                let supervisor = Arc::clone(&supervisor);
                let barrier = Arc::clone(&barrier);
                let command = command.clone();
                let cwd = root.path().to_path_buf();
                let results_tx = results_tx.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let result =
                        supervisor.run("workspace setup", &command, &cwd, &HashMap::new(), None);
                    results_tx.send(result.clone()).unwrap();
                    result
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();

        // Until the flag exists exactly four commands hold permits, so every
        // other acquire must fail fast; collect those four capacity errors.
        for _ in 0..4 {
            let result = results_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("over-capacity commands should fail fast");
            assert!(
                result
                    .as_ref()
                    .is_err_and(|error| error.contains("capacity")),
                "pre-release completion must be a capacity refusal: {result:?}"
            );
        }

        // The four winners stay active until released; wait for them to cross
        // the soft threshold and be reported as degraded.
        let deadline = Instant::now() + Duration::from_secs(10);
        let health = loop {
            let health = supervisor.snapshot();
            if health.long_running_workspace_commands == 4 {
                break health;
            }
            assert!(
                Instant::now() < deadline,
                "hung commands never became long-running: {health:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(health.active_workspace_commands, 4);
        assert!(!health.healthy);
        assert_eq!(health.status, "degraded");
        assert_eq!(health.long_running_workspace_commands, 4);

        std::fs::write(&release_flag, b"go").unwrap();
        for join in joins {
            let _ = join.join().unwrap();
        }
        assert_eq!(supervisor.snapshot().status, "healthy");
    }

    #[test]
    fn active_command_is_busy_before_its_soft_threshold() {
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(WorkspaceCommandPolicy {
            soft_timeout: Duration::from_secs(5),
            ..test_policy(Duration::from_secs(10), 4)
        }));
        let active = supervisor.acquire("workspace setup").unwrap();

        let health = supervisor.snapshot();
        assert!(health.healthy);
        assert_eq!(health.status, "busy");
        assert_eq!(health.active_workspace_commands, 1);
        assert_eq!(health.long_running_workspace_commands, 0);

        drop(active);
        assert_eq!(supervisor.snapshot().status, "healthy");
    }

    #[test]
    fn full_capacity_is_busy_and_healthy_before_its_soft_threshold() {
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(WorkspaceCommandPolicy {
            soft_timeout: Duration::from_secs(5),
            ..test_policy(Duration::from_secs(10), 4)
        }));
        let active = (0..4)
            .map(|_| supervisor.acquire("workspace setup").unwrap())
            .collect::<Vec<_>>();

        let health = supervisor.snapshot();
        assert!(health.healthy);
        assert_eq!(health.status, "busy");
        assert_eq!(health.active_workspace_commands, 4);
        assert_eq!(health.max_workspace_commands, 4);
        assert_eq!(health.long_running_workspace_commands, 0);

        drop(active);
        assert_eq!(supervisor.snapshot().status, "healthy");
    }
}
