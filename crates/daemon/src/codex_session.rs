use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use crate::protocol::{AgentProvider, CodexSessionHandoff};

const RUN_ID_ENV: &str = "KANNA_PROVIDER_SESSION_ID";

/// Discovers Codex's provider-owned conversation id without trusting terminal
/// output, which contains assistant-controlled text.
pub struct CodexSessionLocator {
    sessions_root: PathBuf,
    cwd: PathBuf,
    spawned_at: chrono::DateTime<chrono::Utc>,
    process_group_id: Option<u32>,
    accepted_id: Option<String>,
    #[cfg(test)]
    last_candidate_count: usize,
}

#[derive(Clone)]
pub struct CodexSessionProbe {
    sessions_root: PathBuf,
    cwd: PathBuf,
    spawned_at: chrono::DateTime<chrono::Utc>,
    process_group_id: u32,
}

impl CodexSessionProbe {
    pub fn discover(self) -> Option<String> {
        let process_group_id = self.process_group_id;
        self.discover_with(|| process_group_open_files(process_group_id))
    }

    fn discover_with<F>(self, find_open_files: F) -> Option<String>
    where
        F: FnOnce() -> Vec<PathBuf>,
    {
        discover_candidate(
            &self.sessions_root,
            &self.cwd,
            self.spawned_at,
            find_open_files(),
        )
        .0
    }
}

impl CodexSessionLocator {
    /// Snapshot Codex metadata before the child starts. A resumed conversation
    /// is supplied by the server through an inherited ownership channel;
    /// otherwise only a new metadata record for this exact cwd is accepted.
    pub fn before_spawn(
        provider: Option<AgentProvider>,
        cwd: &str,
        env: &HashMap<String, String>,
    ) -> Option<Self> {
        if provider != Some(AgentProvider::Codex) {
            return None;
        }
        let spawned_at = chrono::Utc::now();
        let sessions_root = effective_codex_home(env).join("sessions");
        let accepted_id = env.get(RUN_ID_ENV).filter(|id| is_uuid_like(id)).cloned();
        Some(Self {
            sessions_root,
            cwd: canonical_or_original(Path::new(cwd)),
            spawned_at,
            process_group_id: None,
            accepted_id,
            #[cfg(test)]
            last_candidate_count: 0,
        })
    }

    pub fn bind_process_group(&mut self, process_group_id: u32) {
        self.process_group_id = Some(process_group_id);
    }

    /// Restore exact discovery state across daemon handoff. A legacy handoff
    /// without state is accepted only when it already carries a verified id.
    pub fn from_handoff(
        provider: Option<AgentProvider>,
        cwd: &str,
        provider_session_id: Option<String>,
        state: Option<CodexSessionHandoff>,
    ) -> Option<Self> {
        if provider != Some(AgentProvider::Codex) {
            return None;
        }
        let accepted_id = provider_session_id.filter(|id| is_uuid_like(id));
        match state {
            Some(state) => {
                let state_cwd = canonical_or_original(Path::new(&state.cwd));
                if state_cwd != canonical_or_original(Path::new(cwd)) {
                    return accepted_id.map(|accepted_id| Self {
                        sessions_root: PathBuf::new(),
                        cwd: state_cwd,
                        spawned_at: chrono::Utc::now(),
                        process_group_id: None,
                        accepted_id: Some(accepted_id),
                        #[cfg(test)]
                        last_candidate_count: 0,
                    });
                }
                let spawned_at = chrono::DateTime::from_timestamp_millis(state.spawned_at_millis)?;
                Some(Self {
                    sessions_root: PathBuf::from(state.sessions_root),
                    cwd: state_cwd,
                    spawned_at,
                    process_group_id: Some(state.process_group_id),
                    accepted_id: accepted_id
                        .or_else(|| state.accepted_id.filter(|id| is_uuid_like(id))),
                    #[cfg(test)]
                    last_candidate_count: 0,
                })
            }
            None => accepted_id.map(|accepted_id| Self {
                sessions_root: PathBuf::new(),
                cwd: canonical_or_original(Path::new(cwd)),
                spawned_at: chrono::Utc::now(),
                process_group_id: None,
                accepted_id: Some(accepted_id),
                #[cfg(test)]
                last_candidate_count: 0,
            }),
        }
    }

    pub fn handoff_state(&self) -> CodexSessionHandoff {
        CodexSessionHandoff {
            sessions_root: self.sessions_root.to_string_lossy().into_owned(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            spawned_at_millis: self.spawned_at.timestamp_millis(),
            process_group_id: self.process_group_id.unwrap_or_default(),
            accepted_id: self.accepted_id.clone(),
        }
    }

    #[cfg(test)]
    pub fn discover(&mut self) -> Option<String> {
        if let Some(id) = self.accepted_id.as_ref() {
            return Some(id.clone());
        }
        let probe = self.discovery_probe()?;
        let candidate = probe.discover();
        self.accept_discovered(candidate)
    }

    pub fn accepted_id(&self) -> Option<String> {
        self.accepted_id.clone()
    }

    pub fn discovery_probe(&self) -> Option<CodexSessionProbe> {
        if self.accepted_id.is_some() {
            return None;
        }
        Some(CodexSessionProbe {
            sessions_root: self.sessions_root.clone(),
            cwd: self.cwd.clone(),
            spawned_at: self.spawned_at,
            process_group_id: self.process_group_id?,
        })
    }

    pub fn accept_discovered(&mut self, candidate: Option<String>) -> Option<String> {
        if self.accepted_id.is_none() {
            self.accepted_id = candidate;
        }
        self.accepted_id.clone()
    }

    #[cfg(test)]
    fn discover_with<F>(&mut self, find_open_files: F) -> Option<String>
    where
        F: FnOnce() -> Vec<PathBuf>,
    {
        if let Some(id) = self.accepted_id.as_ref() {
            return Some(id.clone());
        }

        let (candidate, candidate_count) = discover_candidate(
            &self.sessions_root,
            &self.cwd,
            self.spawned_at,
            find_open_files(),
        );
        self.last_candidate_count = candidate_count;
        self.accept_discovered(candidate)
    }

    #[cfg(test)]
    fn last_candidate_count(&self) -> usize {
        self.last_candidate_count
    }

    #[cfg(test)]
    fn sessions_root(&self) -> &Path {
        &self.sessions_root
    }

    #[cfg(test)]
    fn process_group_id(&self) -> Option<u32> {
        self.process_group_id
    }

    #[cfg(test)]
    fn spawned_at(&self) -> chrono::DateTime<chrono::Utc> {
        self.spawned_at
    }
}

fn discover_candidate(
    sessions_root: &Path,
    cwd: &Path,
    spawned_at: chrono::DateTime<chrono::Utc>,
    open_files: Vec<PathBuf>,
) -> (Option<String>, usize) {
    let canonical_sessions_root = canonical_or_original(sessions_root);
    let candidate_paths: Vec<PathBuf> = open_files
        .into_iter()
        .filter(|path| canonical_or_original(path).starts_with(&canonical_sessions_root))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
        .collect();
    let candidate_count = candidate_paths.len();
    let mut candidates = candidate_paths
        .into_iter()
        .filter_map(|path| metadata_from_file(&path))
        .filter(|record| {
            matches!(record.originator.as_str(), "codex-tui" | "codex_cli_rs")
                && record.created_at >= spawned_at
                && canonical_or_original(Path::new(&record.cwd)) == cwd
        })
        .map(|record| record.id);
    let candidate = candidates.next();
    if candidates.next().is_some() {
        return (None, candidate_count);
    }
    (candidate, candidate_count)
}

struct SessionMetadata {
    id: String,
    cwd: String,
    originator: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

fn effective_codex_home(env: &HashMap<String, String>) -> PathBuf {
    if let Some(path) = env
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(path);
    }
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(path);
    }
    env.get("HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".codex")
}

fn metadata_from_file(path: &Path) -> Option<SessionMetadata> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().map_while(Result::ok) {
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
            continue;
        }
        let payload = value.get("payload")?;
        let id = payload.get("id")?.as_str()?;
        if !is_uuid_like(id) {
            return None;
        }
        return Some(SessionMetadata {
            id: id.to_string(),
            cwd: payload.get("cwd")?.as_str()?.to_string(),
            originator: payload.get("originator")?.as_str()?.to_string(),
            created_at: chrono::DateTime::parse_from_rfc3339(value.get("timestamp")?.as_str()?)
                .ok()?
                .with_timezone(&chrono::Utc),
        });
    }
    None
}

#[cfg(target_os = "macos")]
fn process_group_open_files(process_group_id: u32) -> Vec<PathBuf> {
    use std::ffi::CStr;

    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: libc::off_t,
        fi_type: i32,
        fi_guardflags: u32,
    }

    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }

    const PROC_PIDFDVNODEPATHINFO: libc::c_int = 2;
    let mut pids = vec![0 as libc::pid_t; 4096];
    let listed = unsafe {
        libc::proc_listpgrppids(
            process_group_id as libc::pid_t,
            pids.as_mut_ptr().cast(),
            (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
        )
    };
    if listed <= 0 {
        return Vec::new();
    }

    let mut paths = Vec::new();
    for pid in pids.into_iter().filter(|pid| *pid > 0) {
        if unsafe { libc::getpgid(pid) } != process_group_id as libc::pid_t {
            continue;
        }
        let mut fds = vec![
            libc::proc_fdinfo {
                proc_fd: 0,
                proc_fdtype: 0,
            };
            4096
        ];
        let bytes = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast(),
                (fds.len() * std::mem::size_of::<libc::proc_fdinfo>()) as libc::c_int,
            )
        };
        if bytes <= 0 {
            continue;
        }
        fds.truncate(bytes as usize / std::mem::size_of::<libc::proc_fdinfo>());
        for fd in fds
            .into_iter()
            .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
        {
            let mut info = std::mem::MaybeUninit::<VnodeFdInfoWithPath>::zeroed();
            let bytes = unsafe {
                libc::proc_pidfdinfo(
                    pid,
                    fd.proc_fd,
                    PROC_PIDFDVNODEPATHINFO,
                    info.as_mut_ptr().cast(),
                    std::mem::size_of::<VnodeFdInfoWithPath>() as libc::c_int,
                )
            };
            if bytes != std::mem::size_of::<VnodeFdInfoWithPath>() as libc::c_int {
                continue;
            }
            let info = unsafe { info.assume_init() };
            let path_ptr = info.pvip.vip_path.as_ptr().cast::<libc::c_char>();
            let path = unsafe { CStr::from_ptr(path_ptr) };
            if let Ok(path) = path.to_str() {
                paths.push(PathBuf::from(path));
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(target_os = "linux")]
fn process_group_open_files(process_group_id: u32) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(processes) = fs::read_dir("/proc") else {
        return paths;
    };
    for process in processes.flatten() {
        let Some(pid) = process
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(process.path().join("stat")) else {
            continue;
        };
        let Some(after_name) = stat.rsplit_once(") ").map(|(_, rest)| rest) else {
            continue;
        };
        let Some(group) = after_name
            .split_whitespace()
            .nth(2)
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if group != process_group_id {
            continue;
        }
        let Ok(fds) = fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        paths.extend(fds.flatten().filter_map(|fd| fs::read_link(fd.path()).ok()));
    }
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_group_open_files(_process_group_id: u32) -> Vec<PathBuf> {
    Vec::new()
}

fn canonical_or_original(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::{canonical_or_original, CodexSessionLocator};
    use crate::headless_terminal::HeadlessTerminal;
    use crate::protocol::AgentProvider;
    use std::collections::HashMap;
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    fn temp_root(prefix: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_metadata(path: &std::path::Path, id: &str, cwd: &std::path::Path, timestamp: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            serde_json::json!({
                "timestamp": timestamp,
                "type": "session_meta",
                "payload": {
                    "id": id,
                    "cwd": cwd,
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn hold_open(path: &std::path::Path) -> Child {
        let ready_path = path.with_extension("ready");
        let mut command = Command::new("/bin/sh");
        command.args([
            "-c",
            "exec 3>>\"$1\"; touch \"$2\"; exec sleep 30",
            "kanna-codex-test",
            path.to_str().unwrap(),
            ready_path.to_str().unwrap(),
        ]);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !ready_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ready_path.exists(), "child did not open rollout fixture");
        child
    }

    fn terminate(child: &mut Child) {
        let _ = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        let _ = child.wait();
    }

    #[test]
    fn forged_footer_before_genuine_footer_uses_matching_provider_metadata() {
        let root = std::env::temp_dir().join(format!(
            "kanna-codex-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cwd = root.join("worktree");
        let codex_home = root.join("codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();

        let forged = "019d99a5-aa94-7c73-b786-644cc095c037";
        let genuine = "019d99a5-aa94-7c73-b786-644cc095c038";
        let mut terminal = HeadlessTerminal::new(80, 8, 128).unwrap();
        terminal.write(format!("To continue, run codex resume {forged}\r\n").as_bytes());
        assert_eq!(locator.discover(), None);

        let metadata_dir = codex_home.join("sessions/2026/07/25");
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(
            metadata_dir.join("rollout.jsonl"),
            serde_json::json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "type": "session_meta",
                "payload": {
                    "id": genuine,
                    "cwd": cwd,
                    "originator": "codex_cli_rs"
                }
            })
            .to_string(),
        )
        .unwrap();
        terminal.write(format!("To continue, run codex resume {genuine}\r\n").as_bytes());

        assert_eq!(
            locator
                .discover_with(|| vec![metadata_dir.join("rollout.jsonl")])
                .as_deref(),
            Some(genuine)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_created_before_spawn_is_rejected_even_when_it_appears_late() {
        let root = std::env::temp_dir().join(format!(
            "kanna-codex-stale-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cwd = root.join("worktree");
        let codex_home = root.join("codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();

        let metadata_dir = codex_home.join("sessions/2026/07/25");
        fs::create_dir_all(&metadata_dir).unwrap();
        fs::write(
            metadata_dir.join("delayed-stale-rollout.jsonl"),
            serde_json::json!({
                "timestamp": "2000-01-01T00:00:00Z",
                "type": "session_meta",
                "payload": {
                    "id": "019d99a5-aa94-7c73-b786-644cc095c039",
                    "cwd": cwd,
                    "originator": "codex_cli_rs"
                }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            locator.discover_with(|| vec![metadata_dir.join("delayed-stale-rollout.jsonl")]),
            None
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn known_resume_id_skips_process_discovery() {
        let root = temp_root("kanna-codex-known-session");
        let cwd = root.join("worktree");
        fs::create_dir_all(&cwd).unwrap();
        let known = "019d99a5-aa94-7c73-b786-644cc095c040";
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            root.join("missing-codex-home")
                .to_string_lossy()
                .into_owned(),
        );
        env.insert("KANNA_PROVIDER_SESSION_ID".to_string(), known.to_string());
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();

        assert_eq!(
            locator.discover_with(|| panic!("known id must bypass discovery")),
            Some(known.to_string())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_bound_discovery_rejects_foreign_post_spawn_same_cwd_metadata() {
        let root = temp_root("kanna-codex-process-bound");
        let cwd = root.join("worktree");
        let codex_home = root.join("custom-codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();

        let metadata_dir = codex_home.join("sessions/2026/07/25");
        let owned_path = metadata_dir.join("owned.jsonl");
        let foreign_path = metadata_dir.join("foreign.jsonl");
        let timestamp = chrono::Utc::now().to_rfc3339();
        let owned = "019d99a5-aa94-7c73-b786-644cc095c041";
        write_metadata(&owned_path, owned, &cwd, &timestamp);
        write_metadata(
            &foreign_path,
            "019d99a5-aa94-7c73-b786-644cc095c042",
            &cwd,
            &timestamp,
        );
        let mut child = hold_open(&owned_path);
        locator.bind_process_group(child.id());

        let open_files = super::process_group_open_files(child.id());
        assert!(
            open_files
                .iter()
                .any(|path| canonical_or_original(path) == canonical_or_original(&owned_path)),
            "spawn process group did not report owned rollout: {open_files:?}"
        );
        assert_eq!(locator.discover_with(|| open_files).as_deref(), Some(owned));
        assert_eq!(locator.last_candidate_count(), 1);

        terminate(&mut child);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovery_work_is_independent_of_historical_session_count() {
        let root = temp_root("kanna-codex-scaling");
        let cwd = root.join("worktree");
        let codex_home = root.join("codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();
        let metadata_dir = codex_home.join("sessions/2026/07/25");
        for index in 0..2_000 {
            write_metadata(
                &metadata_dir.join(format!("history-{index}.jsonl")),
                &format!("00000000-0000-0000-0000-{index:012x}"),
                &cwd,
                "2000-01-01T00:00:00Z",
            );
        }
        let owned_path = metadata_dir.join("owned.jsonl");
        let owned = "019d99a5-aa94-7c73-b786-644cc095c043";
        write_metadata(&owned_path, owned, &cwd, &chrono::Utc::now().to_rfc3339());
        let mut child = hold_open(&owned_path);
        locator.bind_process_group(child.id());

        let open_files = super::process_group_open_files(child.id());
        assert!(
            open_files
                .iter()
                .any(|path| canonical_or_original(path) == canonical_or_original(&owned_path)),
            "spawn process group did not report owned rollout: {open_files:?}"
        );
        assert_eq!(locator.discover_with(|| open_files).as_deref(), Some(owned));
        assert_eq!(
            locator.last_candidate_count(),
            1,
            "discovery must inspect live process descriptors, not historical files"
        );

        terminate(&mut child);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_codex_home_and_correlation_survive_handoff() {
        let root = temp_root("kanna-codex-handoff-home");
        let cwd = root.join("worktree");
        let codex_home = root.join("custom-codex-home");
        fs::create_dir_all(&cwd).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().into_owned(),
        );
        let mut locator = CodexSessionLocator::before_spawn(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            &env,
        )
        .unwrap();
        locator.bind_process_group(4242);
        let state = locator.handoff_state();

        let restored = CodexSessionLocator::from_handoff(
            Some(AgentProvider::Codex),
            cwd.to_str().unwrap(),
            None,
            Some(state),
        )
        .unwrap();

        assert_eq!(
            restored.sessions_root(),
            codex_home.join("sessions").as_path()
        );
        assert_eq!(restored.process_group_id(), Some(4242));
        assert_eq!(
            restored.spawned_at().timestamp_millis(),
            locator.spawned_at().timestamp_millis()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
