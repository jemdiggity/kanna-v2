use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

const RECOVERY_QUEUE_CAPACITY: usize = 1024;
const RECOVERY_SHUTDOWN_TIMEOUT_MS: u64 = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub saved_at: u64,
    pub sequence: u64,
}

#[derive(Debug, Clone)]
pub struct SeededRecoverySnapshot {
    pub serialized: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
}

#[derive(Clone)]
pub struct RecoveryManager {
    launcher: Option<RecoveryLauncher>,
    snapshot_dir: PathBuf,
    sequences: Arc<StdMutex<HashMap<String, u64>>>,
    state: Arc<Mutex<RecoveryState>>,
}

#[derive(Debug)]
struct RecoveryState {
    sender: Option<mpsc::Sender<WorkerMessage>>,
    shutdown_requested: bool,
    tracked_sessions: HashMap<String, SessionGeometry>,
}

#[derive(Debug, Clone, Copy)]
struct SessionGeometry {
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone)]
struct RecoveryLauncher {
    program: PathBuf,
    args: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum RecoveryCommand {
    StartSession {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "resumeFromDisk")]
        resume_from_disk: bool,
    },
    WriteOutput {
        #[serde(rename = "sessionId")]
        session_id: String,
        data: Vec<u8>,
        sequence: u64,
    },
    ResizeSession {
        #[serde(rename = "sessionId")]
        session_id: String,
        cols: u16,
        rows: u16,
    },
    EndSession {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    GetSnapshot {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    FlushAndShutdown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum RecoveryResponse {
    Ok,
    Error {
        message: String,
    },
    Snapshot {
        #[serde(rename = "sessionId")]
        session_id: String,
        serialized: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "cursorRow")]
        cursor_row: u16,
        #[serde(rename = "cursorCol")]
        cursor_col: u16,
        #[serde(rename = "cursorVisible")]
        cursor_visible: bool,
        #[serde(rename = "savedAt")]
        saved_at: u64,
        sequence: u64,
    },
    NotFound,
}

enum WorkerMessage {
    FireAndForget(RecoveryCommand),
    Request {
        command: RecoveryCommand,
        reply: oneshot::Sender<Result<RecoveryResponse, String>>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRecoverySnapshot {
    session_id: String,
    serialized: String,
    cols: u16,
    rows: u16,
    cursor_row: u16,
    cursor_col: u16,
    cursor_visible: bool,
    saved_at: u64,
    sequence: u64,
}

impl RecoveryManager {
    pub async fn start() -> Self {
        let snapshot_dir = default_snapshot_dir();
        let launcher = detect_launcher();
        let manager = Self::new(snapshot_dir, launcher);
        let _ = manager.ensure_sender().await;
        manager
    }

    pub fn disconnected() -> Self {
        Self::new(default_snapshot_dir(), None)
    }

    pub async fn new_for_test() -> Result<Self, String> {
        let snapshot_dir = unique_test_snapshot_dir();
        Self::new_for_test_with_snapshot_dir(snapshot_dir).await
    }

    pub async fn new_for_test_with_snapshot_dir(snapshot_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&snapshot_dir).map_err(|error| {
            format!(
                "failed to create test recovery snapshot dir {:?}: {}",
                snapshot_dir, error
            )
        })?;

        let launcher = detect_test_launcher()
            .ok_or_else(|| "recovery sidecar launcher could not be resolved".to_string())?;
        let manager = Self::new(snapshot_dir, Some(launcher));
        manager
            .ensure_sender()
            .await
            .ok_or_else(|| "recovery sidecar failed to start for tests".to_string())?;
        Ok(manager)
    }

    pub fn snapshot_file_for_test(&self, session_id: &str) -> PathBuf {
        self.snapshot_file(session_id)
    }

    pub fn has_persisted_snapshot(&self, session_id: &str) -> bool {
        self.snapshot_file(session_id).exists()
    }

    pub fn seed_snapshot(
        &self,
        session_id: &str,
        snapshot: &SeededRecoverySnapshot,
    ) -> Result<(), String> {
        std::fs::create_dir_all(&self.snapshot_dir).map_err(|error| {
            format!(
                "failed to create recovery snapshot dir {:?}: {}",
                self.snapshot_dir, error
            )
        })?;

        let snapshot = PersistedRecoverySnapshot {
            session_id: session_id.to_string(),
            serialized: snapshot.serialized.clone(),
            cols: snapshot.cols,
            rows: snapshot.rows,
            cursor_row: snapshot.cursor_row,
            cursor_col: snapshot.cursor_col,
            cursor_visible: snapshot.cursor_visible,
            saved_at: now_millis(),
            sequence: 0,
        };

        let payload = serde_json::to_vec(&snapshot)
            .map_err(|error| format!("failed to serialize seeded recovery snapshot: {}", error))?;
        let path = self.snapshot_file(session_id);
        let temp_path =
            path.with_extension(format!("json.tmp-{}-{}", std::process::id(), now_millis()));
        std::fs::write(&temp_path, payload).map_err(|error| {
            format!(
                "failed to write seeded recovery snapshot {:?}: {}",
                temp_path, error
            )
        })?;
        std::fs::rename(&temp_path, &path).map_err(|error| {
            format!(
                "failed to publish seeded recovery snapshot {:?}: {}",
                path, error
            )
        })?;
        Ok(())
    }

    pub fn next_sequence(&self, session_id: &str) -> u64 {
        let mut sequences = lock_sequences(&self.sequences);
        let next = sequences.get(session_id).copied().unwrap_or(0) + 1;
        sequences.insert(session_id.to_string(), next);
        next
    }

    pub async fn start_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        resume_from_disk: bool,
    ) -> Result<(), String> {
        match self
            .request(RecoveryCommand::StartSession {
                session_id: session_id.to_string(),
                cols,
                rows,
                resume_from_disk,
            })
            .await?
        {
            RecoveryResponse::Ok => {
                let mut state = self.state.lock().await;
                state
                    .tracked_sessions
                    .insert(session_id.to_string(), SessionGeometry { cols, rows });
                Ok(())
            }
            RecoveryResponse::Error { message } => Err(message),
            other => Err(format!(
                "unexpected recovery response to StartSession: {:?}",
                other
            )),
        }
    }

    pub async fn write_output(&self, session_id: &str, data: &[u8], sequence: u64) {
        if let Some(delay) = test_slow_recovery_write_delay() {
            tokio::time::sleep(delay).await;
        }

        self.fire_and_forget(RecoveryCommand::WriteOutput {
            session_id: session_id.to_string(),
            data: data.to_vec(),
            sequence,
        })
        .await;
    }

    pub async fn resize_session(&self, session_id: &str, cols: u16, rows: u16) {
        {
            let mut state = self.state.lock().await;
            state
                .tracked_sessions
                .insert(session_id.to_string(), SessionGeometry { cols, rows });
        }

        self.fire_and_forget(RecoveryCommand::ResizeSession {
            session_id: session_id.to_string(),
            cols,
            rows,
        })
        .await;
    }

    pub async fn end_session(&self, session_id: &str) {
        {
            let mut state = self.state.lock().await;
            state.tracked_sessions.remove(session_id);
        }
        {
            let mut sequences = lock_sequences(&self.sequences);
            sequences.remove(session_id);
        }

        self.fire_and_forget(RecoveryCommand::EndSession {
            session_id: session_id.to_string(),
        })
        .await;
    }

    pub async fn get_snapshot(&self, session_id: &str) -> Result<Option<RecoverySnapshot>, String> {
        if self.launcher.is_none() {
            return self.read_persisted_snapshot(session_id);
        }

        match self
            .request(RecoveryCommand::GetSnapshot {
                session_id: session_id.to_string(),
            })
            .await?
        {
            RecoveryResponse::Snapshot {
                session_id: response_session_id,
                serialized,
                cols,
                rows,
                cursor_row,
                cursor_col,
                cursor_visible,
                saved_at,
                sequence,
            } => {
                if response_session_id != session_id {
                    return Err(format!(
                        "recovery snapshot response mismatched session: expected {}, got {}",
                        session_id, response_session_id
                    ));
                }

                Ok(Some(RecoverySnapshot {
                    serialized,
                    cols,
                    rows,
                    cursor_row,
                    cursor_col,
                    cursor_visible,
                    saved_at,
                    sequence,
                }))
            }
            RecoveryResponse::NotFound => self.read_persisted_snapshot(session_id),
            RecoveryResponse::Error { message } => Err(message),
            RecoveryResponse::Ok => Err("unexpected recovery response to GetSnapshot".to_string()),
        }
    }

    fn read_persisted_snapshot(
        &self,
        session_id: &str,
    ) -> Result<Option<RecoverySnapshot>, String> {
        let path = self.snapshot_file(session_id);
        if !path.exists() {
            return Ok(None);
        }

        let payload = std::fs::read(&path)
            .map_err(|error| format!("failed to read recovery snapshot {:?}: {}", path, error))?;
        let snapshot: PersistedRecoverySnapshot = serde_json::from_slice(&payload)
            .map_err(|error| format!("failed to parse recovery snapshot {:?}: {}", path, error))?;
        if snapshot.session_id != session_id {
            return Err(format!(
                "persisted recovery snapshot mismatched session: expected {}, got {}",
                session_id, snapshot.session_id
            ));
        }

        Ok(Some(RecoverySnapshot {
            serialized: snapshot.serialized,
            cols: snapshot.cols,
            rows: snapshot.rows,
            cursor_row: snapshot.cursor_row,
            cursor_col: snapshot.cursor_col,
            cursor_visible: snapshot.cursor_visible,
            saved_at: snapshot.saved_at,
            sequence: snapshot.sequence,
        }))
    }

    pub async fn flush_and_shutdown(&self) {
        let sender = {
            let mut state = self.state.lock().await;
            state.shutdown_requested = true;
            if let Some(sender) = state.sender.as_ref() {
                if sender.is_closed() {
                    state.sender = None;
                    None
                } else {
                    Some(sender.clone())
                }
            } else {
                None
            }
        };

        let Some(sender) = sender else {
            return;
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        if sender
            .send(WorkerMessage::Request {
                command: RecoveryCommand::FlushAndShutdown,
                reply: reply_tx,
            })
            .await
            .is_err()
        {
            self.reset_sender().await;
        } else if let Ok(Err(message)) = reply_rx.await {
            log::warn!("recovery flush_and_shutdown failed: {}", message);
            self.reset_sender().await;
        } else {
            self.reset_sender().await;
        }

        let mut state = self.state.lock().await;
        state.tracked_sessions.clear();
    }

    fn new(snapshot_dir: PathBuf, launcher: Option<RecoveryLauncher>) -> Self {
        Self {
            launcher,
            snapshot_dir,
            sequences: Arc::new(StdMutex::new(HashMap::new())),
            state: Arc::new(Mutex::new(RecoveryState {
                sender: None,
                shutdown_requested: false,
                tracked_sessions: HashMap::new(),
            })),
        }
    }

    async fn fire_and_forget(&self, command: RecoveryCommand) {
        if self.launcher.is_none() {
            return;
        }

        for attempt in 0..2 {
            let Some(sender) = self.ensure_sender().await else {
                return;
            };

            match sender.try_send(WorkerMessage::FireAndForget(command.clone())) {
                Ok(()) => return,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    log::warn!("recovery queue is full; dropping mirrored command");
                    return;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    self.reset_sender().await;
                    if attempt == 1 {
                        log::warn!(
                            "recovery worker closed before mirrored command could be queued"
                        );
                        return;
                    }
                }
            }
        }
    }

    async fn request(&self, command: RecoveryCommand) -> Result<RecoveryResponse, String> {
        if self.launcher.is_none() {
            return Err("recovery service is unavailable".to_string());
        }

        for attempt in 0..2 {
            let Some(sender) = self.ensure_sender().await else {
                log::warn!(
                    "recovery request could not ensure sender on attempt {}",
                    attempt
                );
                return Err("recovery service is unavailable".to_string());
            };

            let (reply_tx, reply_rx) = oneshot::channel();
            if sender
                .send(WorkerMessage::Request {
                    command: command.clone(),
                    reply: reply_tx,
                })
                .await
                .is_err()
            {
                self.reset_sender().await;
                if attempt == 1 {
                    return Err("recovery worker stopped before request send".to_string());
                }
                continue;
            }

            match reply_rx.await {
                Ok(Ok(response)) => return Ok(response),
                Ok(Err(message)) => {
                    self.reset_sender().await;
                    if attempt == 1 {
                        return Err(message);
                    }
                }
                Err(_) => {
                    self.reset_sender().await;
                    if attempt == 1 {
                        return Err("recovery worker stopped before reply".to_string());
                    }
                }
            }
        }

        Err("recovery request failed".to_string())
    }

    async fn ensure_sender(&self) -> Option<mpsc::Sender<WorkerMessage>> {
        self.launcher.as_ref()?;

        let tracked_sessions = {
            let mut state = self.state.lock().await;
            if state.shutdown_requested {
                return None;
            }
            if let Some(sender) = state.sender.as_ref() {
                if !sender.is_closed() {
                    return Some(sender.clone());
                }
                state.sender = None;
            }
            state.tracked_sessions.clone()
        };

        let launcher = self.launcher.as_ref()?.clone();
        let sender = match spawn_worker(launcher, self.snapshot_dir.clone()).await {
            Ok(sender) => sender,
            Err(message) => {
                log::warn!("failed to start recovery sidecar: {}", message);
                return None;
            }
        };

        for (session_id, geometry) in tracked_sessions {
            let resume_from_disk = self.has_persisted_snapshot(&session_id);
            if let Err(message) = send_request_via_sender(
                &sender,
                RecoveryCommand::StartSession {
                    session_id,
                    cols: geometry.cols,
                    rows: geometry.rows,
                    resume_from_disk,
                },
            )
            .await
            {
                log::warn!(
                    "failed to re-register recovery session after restart: {}",
                    message
                );
                self.reset_sender().await;
                return None;
            }
        }

        let mut state = self.state.lock().await;
        state.sender = Some(sender.clone());
        Some(sender)
    }

    async fn reset_sender(&self) {
        let mut state = self.state.lock().await;
        state.sender = None;
    }

    fn snapshot_file(&self, session_id: &str) -> PathBuf {
        self.snapshot_dir.join(format!("{}.json", session_id))
    }
}

fn lock_sequences(
    sequences: &Arc<StdMutex<HashMap<String, u64>>>,
) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
    match sequences.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::warn!("recovery sequence map was poisoned; continuing");
            poisoned.into_inner()
        }
    }
}

async fn send_request_via_sender(
    sender: &mpsc::Sender<WorkerMessage>,
    command: RecoveryCommand,
) -> Result<RecoveryResponse, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    sender
        .send(WorkerMessage::Request {
            command,
            reply: reply_tx,
        })
        .await
        .map_err(|_| "recovery worker stopped before replay request".to_string())?;

    match reply_rx.await {
        Ok(result) => result,
        Err(_) => Err("recovery worker stopped before replay response".to_string()),
    }
}

async fn spawn_worker(
    launcher: RecoveryLauncher,
    snapshot_dir: PathBuf,
) -> Result<mpsc::Sender<WorkerMessage>, String> {
    std::fs::create_dir_all(&snapshot_dir).map_err(|error| {
        format!(
            "failed to create recovery snapshot dir {:?}: {}",
            snapshot_dir, error
        )
    })?;

    let mut command = Command::new(&launcher.program);
    command.args(&launcher.args);
    crate::subprocess_env::apply_child_env(
        &mut command,
        [(
            "KANNA_TERMINAL_RECOVERY_DIR".to_string(),
            snapshot_dir.to_string_lossy().into_owned(),
        )],
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        format!(
            "failed to spawn recovery sidecar {:?}: {}",
            launcher.program, error
        )
    })?;

    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "recovery sidecar did not expose stdin".to_string())?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "recovery sidecar did not expose stdout".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(log_recovery_stderr(stderr));
    }

    let (tx, rx) = mpsc::channel(RECOVERY_QUEUE_CAPACITY);
    tokio::spawn(recovery_worker(child, child_stdin, child_stdout, rx));
    Ok(tx)
}

async fn recovery_worker(
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: ChildStdout,
    mut rx: mpsc::Receiver<WorkerMessage>,
) {
    let mut lines = BufReader::new(stdout).lines();

    while let Some(message) = rx.recv().await {
        match message {
            WorkerMessage::FireAndForget(command) => {
                if let Err(message) = send_fire_and_forget(&mut stdin, &command).await {
                    log::warn!("recovery mirrored command failed: {}", message);
                    break;
                }
            }
            WorkerMessage::Request { command, reply } => {
                let is_shutdown = matches!(command, RecoveryCommand::FlushAndShutdown);
                let result = send_request(&mut stdin, &mut lines, &command).await;
                let should_break = is_shutdown || result.is_err();
                let _ = reply.send(result);
                if should_break {
                    break;
                }
            }
        }
    }

    let _ = stdin.shutdown().await;
    wait_for_child_exit(&mut child).await;
}

async fn send_command(
    stdin: &mut tokio::process::ChildStdin,
    command: &RecoveryCommand,
) -> Result<(), String> {
    let mut line = serde_json::to_string(command)
        .map_err(|error| format!("failed to encode recovery command: {}", error))?;
    line.push('\n');

    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| format!("failed to write recovery command: {}", error))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush recovery command: {}", error))
}

async fn send_fire_and_forget(
    stdin: &mut tokio::process::ChildStdin,
    command: &RecoveryCommand,
) -> Result<(), String> {
    send_command(stdin, command).await
}

async fn send_request(
    stdin: &mut tokio::process::ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    command: &RecoveryCommand,
) -> Result<RecoveryResponse, String> {
    send_command(stdin, command).await?;

    let Some(response_line) = lines
        .next_line()
        .await
        .map_err(|error| format!("failed to read recovery response: {}", error))?
    else {
        return Err("recovery sidecar closed stdout unexpectedly".to_string());
    };

    serde_json::from_str(&response_line)
        .map_err(|error| format!("failed to parse recovery response: {}", error))
}

async fn log_recovery_stderr(stderr: tokio::process::ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => log::info!("[recovery] {}", line),
            Ok(None) => break,
            Err(error) => {
                log::warn!("failed reading recovery sidecar stderr: {}", error);
                break;
            }
        }
    }
}

async fn wait_for_child_exit(child: &mut Child) {
    match tokio::time::timeout(
        std::time::Duration::from_millis(RECOVERY_SHUTDOWN_TIMEOUT_MS),
        child.wait(),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => log::warn!("waiting for recovery sidecar failed: {}", error),
        Err(_) => {
            log::warn!("recovery sidecar did not exit in time; killing it");
            if let Err(error) = child.kill().await {
                log::warn!("failed to kill recovery sidecar: {}", error);
            }
            if let Err(error) = child.wait().await {
                log::warn!("failed to reap recovery sidecar after kill: {}", error);
            }
        }
    }
}

fn default_snapshot_dir() -> PathBuf {
    daemon_support_dir().join("terminal-recovery")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn test_slow_recovery_write_delay() -> Option<std::time::Duration> {
    if !cfg!(debug_assertions) {
        return None;
    }

    let millis = std::env::var("KANNA_DAEMON_TEST_SLOW_RECOVERY_WRITE_MS")
        .ok()?
        .parse::<u64>()
        .ok()?;
    (millis > 0).then(|| std::time::Duration::from_millis(millis))
}

fn daemon_support_dir() -> PathBuf {
    kanna_runtime_defaults::daemon_dir_for_current_runtime()
}

fn detect_launcher() -> Option<RecoveryLauncher> {
    if let Ok(path) = std::env::var("KANNA_TERMINAL_RECOVERY_BIN") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(RecoveryLauncher {
                program: candidate,
                args: Vec::new(),
            });
        }
    }

    if let Some(launcher) = bundled_runtime_launcher() {
        return Some(launcher);
    }

    if cfg!(debug_assertions) {
        return workspace_binary_launcher();
    }

    None
}

fn detect_test_launcher() -> Option<RecoveryLauncher> {
    if let Some(launcher) = workspace_binary_launcher() {
        return Some(launcher);
    }
    cargo_manifest_launcher()
}

fn workspace_binary_launcher() -> Option<RecoveryLauncher> {
    let root = workspace_root()?;
    let bin = root.join(".build/debug/kanna-terminal-recovery");
    bin.exists().then_some(RecoveryLauncher {
        program: bin,
        args: Vec::new(),
    })
}

fn cargo_manifest_launcher() -> Option<RecoveryLauncher> {
    let cargo = find_in_path("cargo")?;
    let manifest = workspace_root()?.join("packages/terminal-recovery/Cargo.toml");
    manifest.exists().then_some(RecoveryLauncher {
        program: cargo,
        args: vec![
            "run".to_string(),
            "--quiet".to_string(),
            "--manifest-path".to_string(),
            manifest.to_string_lossy().into_owned(),
        ],
    })
}

fn bundled_runtime_launcher() -> Option<RecoveryLauncher> {
    let exe = std::env::current_exe().ok()?;
    bundled_runtime_launcher_from_exe(&exe)
}

fn bundled_runtime_launcher_from_exe(exe: &Path) -> Option<RecoveryLauncher> {
    kanna_runtime_defaults::sidecar_candidates_for_exe(exe, "kanna-terminal-recovery")
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|program| RecoveryLauncher {
            program,
            args: Vec::new(),
        })
}

fn workspace_root() -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    })
}

fn unique_test_snapshot_dir() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    std::env::temp_dir().join(format!(
        "kanna-terminal-recovery-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn seeded_snapshot_is_readable_without_live_recovery_worker() {
        let snapshot_dir = unique_test_snapshot_dir();
        let manager = RecoveryManager::new(snapshot_dir.clone(), None);

        manager
            .seed_snapshot(
                "seeded-session",
                &SeededRecoverySnapshot {
                    serialized: "RECOVERY_DONE\r\n".to_string(),
                    cols: 80,
                    rows: 24,
                    cursor_row: 23,
                    cursor_col: 0,
                    cursor_visible: true,
                },
            )
            .unwrap();

        let snapshot = manager
            .get_snapshot("seeded-session")
            .await
            .unwrap()
            .expect("seeded snapshot should be readable");
        assert_eq!(snapshot.serialized, "RECOVERY_DONE\r\n");
        assert_eq!(snapshot.cols, 80);
        assert_eq!(snapshot.rows, 24);

        let _ = std::fs::remove_dir_all(&snapshot_dir);
    }
}
