use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const MAX_WORKSPACE_COMMANDS: usize = 4;
const SOFT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HARD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const FINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

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
    ) -> Result<(), String> {
        let _active = self.acquire(label)?;
        run_process(label, shell_command, cwd, env, self.policy)
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
        let capacity_exhausted = state.active.len() >= self.policy.max_concurrent;
        let healthy = long_running == 0 && !capacity_exhausted;
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
    global_supervisor().run(label, command, cwd, env)
}

pub(crate) fn write_path_health() -> WritePathHealth {
    global_supervisor().snapshot()
}

#[cfg(test)]
pub(crate) fn run_workspace_command_with_hard_timeout_for_test(
    label: &str,
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    hard_timeout: Duration,
) -> Result<(), String> {
    let supervisor = Arc::new(WorkspaceCommandSupervisor::new(WorkspaceCommandPolicy {
        soft_timeout: hard_timeout / 2,
        hard_timeout,
        final_drain_timeout: Duration::from_millis(100),
        poll_interval: Duration::from_millis(10),
        max_concurrent: MAX_WORKSPACE_COMMANDS,
        max_output_bytes: MAX_OUTPUT_BYTES,
    }));
    supervisor.run(label, command, cwd, env)
}

fn run_process(
    label: &str,
    shell_command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    policy: WorkspaceCommandPolicy,
) -> Result<(), String> {
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
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run {label}: {error}"))?;
    let process_group = child.id() as i32;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("failed to capture {label} stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("failed to capture {label} stderr"))?;
    set_nonblocking(&stdout).map_err(|error| format!("failed to read {label} stdout: {error}"))?;
    set_nonblocking(&stderr).map_err(|error| format!("failed to read {label} stderr: {error}"))?;

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
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to wait for {label}: {error}"))?
        {
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
        if elapsed >= policy.hard_timeout {
            timed_out = true;
            kill_process_group(process_group);
            reap_until(
                &mut child,
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
    kill_process_group(process_group);
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

fn reap_until(
    child: &mut Child,
    label: &str,
    deadline: Instant,
    poll_interval: Duration,
) -> Result<(), String> {
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to reap timed-out {label}: {error}"))?
        {
            let _ = status;
            return Ok(());
        }
        std::thread::sleep(poll_interval);
    }
    log::error!("{label} direct child did not become reapable after process-group kill");
    Ok(())
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
            final_drain_timeout: Duration::from_millis(100),
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
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(test_policy(
            Duration::from_millis(150),
            4,
        )));

        let error = supervisor
            .run("workspace setup", &command, root.path(), &HashMap::new())
            .unwrap_err();

        assert!(error.contains("timed out"), "{error}");
        assert!(error.contains("setup-started"), "{error}");
        assert_process_exits(wait_for_pid_file(&pid_file));
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
            )
            .unwrap();

        assert!(
            started.elapsed() < Duration::from_secs(2),
            "inherited pipe held the runner open for {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn concurrent_hangs_never_exceed_the_configured_limit() {
        let supervisor = Arc::new(WorkspaceCommandSupervisor::new(test_policy(
            Duration::from_millis(300),
            4,
        )));
        let barrier = Arc::new(Barrier::new(9));
        let joins = (0..8)
            .map(|_| {
                let supervisor = Arc::clone(&supervisor);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    supervisor.run(
                        "workspace setup",
                        "sleep 30",
                        std::path::Path::new("/tmp"),
                        &HashMap::new(),
                    )
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        std::thread::sleep(Duration::from_millis(50));

        let health = supervisor.snapshot();
        assert_eq!(health.active_workspace_commands, 4);
        assert!(!health.healthy);
        assert_eq!(health.status, "degraded");
        assert_eq!(health.long_running_workspace_commands, 4);
        let capacity_errors = joins
            .into_iter()
            .map(|join| join.join().unwrap())
            .filter(|result| {
                result
                    .as_ref()
                    .is_err_and(|error| error.contains("capacity"))
            })
            .count();
        assert_eq!(capacity_errors, 4);
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
}
