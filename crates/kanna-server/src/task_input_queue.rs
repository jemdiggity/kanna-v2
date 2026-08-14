use crate::daemon_client::DaemonClient;
use crate::db::{Db, TaskEventKind};
use kanna_daemon::protocol::{
    Command as DaemonCommand, Event as DaemonEvent, SessionKind, SessionState, SessionStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{mpsc, oneshot};

const SUBMIT_ENTER_DELAY_MS: u64 = 150;
const INPUT_DELIVERY_TIMEOUT_SECS: u64 = 30;
const INPUT_QUEUE_CAPACITY: usize = 256;
const AUDIT_TEXT_LIMIT: usize = 4096;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TaskInputSource {
    Human,
    QuickAction,
    #[default]
    Api,
    CompletionNotification,
    StagePost,
    System,
}

impl TaskInputSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::QuickAction => "quick_action",
            Self::Api => "api",
            Self::CompletionNotification => "completion_notification",
            Self::StagePost => "stage_post",
            Self::System => "system",
        }
    }
}

#[derive(Debug)]
pub(crate) enum TaskInputError {
    SessionNotFound,
    Other(String),
    /// Submission may have reached the PTY even though its response was lost.
    /// Retrying this result could duplicate terminal bytes.
    Uncertain(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionIncarnation {
    session_id: String,
    pid: u32,
}

struct MessageRequest {
    task_id: String,
    text: String,
    source: TaskInputSource,
    response: oneshot::Sender<Result<(), TaskInputError>>,
    sequence: Option<u64>,
}

struct OperatorRequest {
    task_id: String,
    data: Vec<u8>,
    source: TaskInputSource,
    response: oneshot::Sender<Result<(), TaskInputError>>,
}

enum InputRequest {
    Message(MessageRequest),
    Operator(OperatorRequest),
}

#[derive(Clone, Default)]
struct TerminalInputParser {
    state: TerminalParserState,
    bracketed_paste: bool,
}

#[derive(Clone, Default)]
enum TerminalParserState {
    #[default]
    Normal,
    Escape,
    Ss3,
    Csi(Vec<u8>),
    Osc,
    OscEscape,
}

enum OperatorAction {
    Printable,
    Boundary {
        delivery: &'static str,
        boundary: &'static str,
    },
}

struct OperatorSegment {
    data: Vec<u8>,
    actions: Vec<OperatorAction>,
    parser_after: TerminalInputParser,
}

impl TerminalInputParser {
    fn segments(&self, data: &[u8]) -> Vec<OperatorSegment> {
        let mut parser = self.clone();
        let mut segments = Vec::new();
        let mut segment_data = Vec::new();
        let mut segment_actions = Vec::new();
        for &byte in data {
            segment_data.push(byte);
            if let Some(action) = parser.parse_byte(byte) {
                let is_boundary = matches!(action, OperatorAction::Boundary { .. });
                segment_actions.push(action);
                if is_boundary {
                    segments.push(OperatorSegment {
                        data: std::mem::take(&mut segment_data),
                        actions: std::mem::take(&mut segment_actions),
                        parser_after: parser.clone(),
                    });
                }
            }
        }
        if !segment_data.is_empty() {
            segments.push(OperatorSegment {
                data: segment_data,
                actions: segment_actions,
                parser_after: parser,
            });
        }
        segments
    }

    fn parse_byte(&mut self, byte: u8) -> Option<OperatorAction> {
        match &mut self.state {
            TerminalParserState::Normal => {
                if byte == b'\x1b' {
                    self.state = TerminalParserState::Escape;
                    None
                } else if self.bracketed_paste {
                    Some(OperatorAction::Printable)
                } else {
                    match byte {
                        b'\r' | b'\n' => Some(OperatorAction::Boundary {
                            delivery: "delivered",
                            boundary: "terminal-enter",
                        }),
                        b'\x03' => Some(OperatorAction::Boundary {
                            delivery: "cancelled",
                            boundary: "terminal-cancel",
                        }),
                        b' '..=b'~' | 0x80..=0xff => Some(OperatorAction::Printable),
                        _ => None,
                    }
                }
            }
            TerminalParserState::Escape => {
                if byte == b'[' {
                    self.state = TerminalParserState::Csi(Vec::new());
                    None
                } else if !self.bracketed_paste && byte == b'O' {
                    self.state = TerminalParserState::Ss3;
                    None
                } else if !self.bracketed_paste && byte == b']' {
                    self.state = TerminalParserState::Osc;
                    None
                } else {
                    self.state = TerminalParserState::Normal;
                    self.parse_byte(byte)
                }
            }
            TerminalParserState::Ss3 => {
                self.state = TerminalParserState::Normal;
                None
            }
            TerminalParserState::Csi(bytes) => {
                if bytes.len() < 16 {
                    bytes.push(byte);
                }
                if (0x40..=0x7e).contains(&byte) {
                    let bracketed_paste = self.bracketed_paste;
                    let marker = std::mem::take(bytes);
                    self.state = TerminalParserState::Normal;
                    if marker == b"200~" && !bracketed_paste {
                        self.bracketed_paste = true;
                        None
                    } else if marker == b"201~" && bracketed_paste {
                        self.bracketed_paste = false;
                        None
                    } else if bracketed_paste {
                        Some(OperatorAction::Printable)
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            TerminalParserState::Osc => {
                if byte == b'\x07' {
                    self.state = TerminalParserState::Normal;
                } else if byte == b'\x1b' {
                    self.state = TerminalParserState::OscEscape;
                }
                None
            }
            TerminalParserState::OscEscape => {
                if byte == b'\\' {
                    self.state = TerminalParserState::Normal;
                } else if byte != b'\x1b' {
                    self.state = TerminalParserState::Osc;
                }
                None
            }
        }
    }
}

#[derive(Clone)]
pub(crate) struct TaskInputCoordinator {
    daemon_dir: String,
    db_path: String,
    workers: Arc<StdMutex<HashMap<SessionIncarnation, mpsc::Sender<InputRequest>>>>,
    current_pid: Arc<StdMutex<HashMap<String, u32>>>,
    next_sequence: Arc<AtomicU64>,
    #[cfg(test)]
    admitted_count: Arc<AtomicU64>,
    #[cfg(test)]
    admitted: Arc<Notify>,
}

impl TaskInputCoordinator {
    pub(crate) fn new(daemon_dir: String, db_path: String) -> Self {
        Self {
            daemon_dir,
            db_path,
            workers: Arc::new(StdMutex::new(HashMap::new())),
            current_pid: Arc::new(StdMutex::new(HashMap::new())),
            next_sequence: Arc::new(AtomicU64::new(1)),
            #[cfg(test)]
            admitted_count: Arc::new(AtomicU64::new(0)),
            #[cfg(test)]
            admitted: Arc::new(Notify::new()),
        }
    }

    pub(crate) async fn live_pty_session(
        &self,
        session_id: &str,
    ) -> Result<(u32, SessionStatus), TaskInputError> {
        let mut daemon = DaemonClient::connect(&self.daemon_dir)
            .await
            .map_err(|error| TaskInputError::Other(format!("daemon unavailable: {error}")))?;
        match daemon
            .send_command(&DaemonCommand::List)
            .await
            .map_err(|error| TaskInputError::Uncertain(format!("daemon response lost: {error}")))?
        {
            DaemonEvent::SessionList { sessions } => sessions
                .into_iter()
                .find(|session| {
                    session.session_id == session_id
                        && session.kind == SessionKind::Pty
                        && matches!(session.state, SessionState::Active)
                })
                .map(|session| (session.pid, session.status))
                .ok_or(TaskInputError::SessionNotFound),
            DaemonEvent::Error {
                code: Some(kanna_daemon::protocol::ErrorCode::SessionNotFound),
                ..
            } => Err(TaskInputError::SessionNotFound),
            DaemonEvent::Error { message, .. } => Err(TaskInputError::Other(message)),
            other => Err(TaskInputError::Other(format!(
                "unexpected daemon response: {other:?}"
            ))),
        }
    }

    pub(crate) async fn submit_message(
        &self,
        task_id: &str,
        session_id: &str,
        source: TaskInputSource,
        input: &str,
    ) -> Result<(), TaskInputError> {
        let (pid, _) = self.live_pty_session(session_id).await?;
        self.submit_message_if_session(task_id, session_id, pid, source, input)
            .await
    }

    pub(crate) async fn submit_message_if_session(
        &self,
        task_id: &str,
        session_id: &str,
        expected_pid: u32,
        source: TaskInputSource,
        input: &str,
    ) -> Result<(), TaskInputError> {
        let incarnation = SessionIncarnation {
            session_id: session_id.to_string(),
            pid: expected_pid,
        };
        let result = match tokio::time::timeout(
            std::time::Duration::from_secs(INPUT_DELIVERY_TIMEOUT_SECS),
            async {
                let (_, response) = self
                    .queue_message_if_session(task_id, session_id, expected_pid, source, input)
                    .await?;
                response
                    .await
                    .map_err(|_| TaskInputError::Other("task input worker stopped".to_string()))?
            },
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(TaskInputError::Other(format!(
                "task input delivery timed out after {INPUT_DELIVERY_TIMEOUT_SECS}s"
            ))),
        };
        if matches!(result, Err(TaskInputError::SessionNotFound)) {
            self.workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&incarnation);
        }
        result
    }

    async fn queue_message_if_session(
        &self,
        task_id: &str,
        session_id: &str,
        expected_pid: u32,
        source: TaskInputSource,
        input: &str,
    ) -> Result<
        (
            SessionIncarnation,
            oneshot::Receiver<Result<(), TaskInputError>>,
        ),
        TaskInputError,
    > {
        validate_task_input(source, input).map_err(TaskInputError::Other)?;
        let (response, result) = oneshot::channel();
        let incarnation = SessionIncarnation {
            session_id: session_id.to_string(),
            pid: expected_pid,
        };
        self.enqueue(
            incarnation.clone(),
            InputRequest::Message(MessageRequest {
                task_id: task_id.to_string(),
                text: task_input_message(input).to_string(),
                source,
                response,
                sequence: None,
            }),
        )
        .await?;
        Ok((incarnation, result))
    }

    pub(crate) async fn send_operator_bytes(
        &self,
        task_id: &str,
        session_id: &str,
        data: Vec<u8>,
    ) -> Result<(), TaskInputError> {
        let incarnation = {
            let current_pid = self
                .current_pid
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            current_pid.get(session_id).map(|pid| SessionIncarnation {
                session_id: session_id.to_string(),
                pid: *pid,
            })
        };
        let incarnation = match incarnation {
            Some(incarnation) => incarnation,
            None => {
                let (pid, _) = self.live_pty_session(session_id).await?;
                SessionIncarnation {
                    session_id: session_id.to_string(),
                    pid,
                }
            }
        };
        self.send_operator_bytes_if_session(task_id, incarnation, data)
            .await
    }

    async fn send_operator_bytes_if_session(
        &self,
        task_id: &str,
        incarnation: SessionIncarnation,
        data: Vec<u8>,
    ) -> Result<(), TaskInputError> {
        let (response, result) = oneshot::channel();
        self.enqueue(
            incarnation.clone(),
            InputRequest::Operator(OperatorRequest {
                task_id: task_id.to_string(),
                data,
                source: TaskInputSource::Human,
                response,
            }),
        )
        .await?;
        let result = result
            .await
            .map_err(|_| TaskInputError::Other("task input worker stopped".to_string()))?;
        if matches!(result, Err(TaskInputError::SessionNotFound)) {
            self.workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&incarnation);
            let mut current_pid = self
                .current_pid
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if current_pid.get(&incarnation.session_id) == Some(&incarnation.pid) {
                current_pid.remove(&incarnation.session_id);
            }
        }
        result
    }

    async fn enqueue(
        &self,
        incarnation: SessionIncarnation,
        request: InputRequest,
    ) -> Result<(), TaskInputError> {
        self.current_pid
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(incarnation.session_id.clone(), incarnation.pid);
        let sender = {
            let mut workers = self
                .workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            workers.retain(|worker_incarnation, _| {
                worker_incarnation.session_id != incarnation.session_id
                    || worker_incarnation.pid == incarnation.pid
            });
            workers
                .entry(incarnation.clone())
                .or_insert_with(|| {
                    let (sender, receiver) = mpsc::channel(INPUT_QUEUE_CAPACITY);
                    tokio::spawn(run_session_input_worker(
                        self.daemon_dir.clone(),
                        self.db_path.clone(),
                        Arc::clone(&self.next_sequence),
                        incarnation,
                        receiver,
                    ));
                    sender
                })
                .clone()
        };
        sender
            .send(request)
            .await
            .map_err(|_| TaskInputError::Other("task input queue is unavailable".to_string()))?;
        #[cfg(test)]
        {
            self.admitted_count.fetch_add(1, Ordering::Release);
            self.admitted.notify_waiters();
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_admissions(&self, expected: u64) {
        loop {
            let notified = self.admitted.notified();
            if self.admitted_count.load(Ordering::Acquire) >= expected {
                return;
            }
            notified.await;
        }
    }
}

pub(crate) fn task_input_message(input: &str) -> &str {
    input.trim_end_matches(['\r', '\n'])
}

async fn run_session_input_worker(
    daemon_dir: String,
    db_path: String,
    next_sequence: Arc<AtomicU64>,
    incarnation: SessionIncarnation,
    mut requests: mpsc::Receiver<InputRequest>,
) {
    let mut daemon: Option<DaemonClient> = None;
    let mut deferred_messages = VecDeque::new();
    let mut draft: Option<(u64, String, TaskInputSource)> = None;
    let mut parser = TerminalInputParser::default();
    let mut poisoned: Option<String> = None;

    while let Some(request) = requests.recv().await {
        if let Some(reason) = poisoned.as_ref() {
            answer_request(request, Err(TaskInputError::Uncertain(reason.clone())));
            continue;
        }
        match request {
            InputRequest::Message(message) if message.response.is_closed() => {}
            InputRequest::Message(mut message) if draft.is_some() => {
                message.sequence = Some(next_sequence.fetch_add(1, Ordering::Relaxed));
                if deferred_messages.len() >= INPUT_QUEUE_CAPACITY {
                    let _ = message.response.send(Err(TaskInputError::Other(format!(
                        "deferred task input queue reached capacity {INPUT_QUEUE_CAPACITY}"
                    ))));
                } else {
                    deferred_messages.push_back(message);
                }
            }
            InputRequest::Message(mut message) => {
                message.sequence = Some(next_sequence.fetch_add(1, Ordering::Relaxed));
                if let Some(reason) = deliver_message(
                    &daemon_dir,
                    &db_path,
                    &next_sequence,
                    &incarnation,
                    &mut daemon,
                    message,
                )
                .await
                {
                    poisoned = Some(reason);
                }
            }
            InputRequest::Operator(operator) => {
                let outcome = deliver_operator_bytes(
                    &daemon_dir,
                    &db_path,
                    &next_sequence,
                    &incarnation,
                    &mut daemon,
                    &mut draft,
                    &mut parser,
                    &mut deferred_messages,
                    operator,
                )
                .await;
                if let Some(reason) = outcome {
                    poisoned = Some(reason);
                }
            }
        }
        if let Some(reason) = poisoned.as_ref() {
            while let Some(message) = deferred_messages.pop_front() {
                let _ = message
                    .response
                    .send(Err(TaskInputError::Uncertain(reason.clone())));
            }
        }
    }
}

fn answer_request(request: InputRequest, result: Result<(), TaskInputError>) {
    match request {
        InputRequest::Message(request) => {
            let _ = request.response.send(result);
        }
        InputRequest::Operator(request) => {
            let _ = request.response.send(result);
        }
    }
}

async fn daemon_for_input<'a>(
    daemon_dir: &str,
    daemon: &'a mut Option<DaemonClient>,
) -> Result<&'a mut DaemonClient, TaskInputError> {
    if daemon.is_none() {
        *daemon = Some(
            DaemonClient::connect(daemon_dir)
                .await
                .map_err(|error| TaskInputError::Other(format!("daemon unavailable: {error}")))?,
        );
    }
    daemon
        .as_mut()
        .ok_or_else(|| TaskInputError::Other("daemon connection unavailable".to_string()))
}

async fn send_fenced_input(
    daemon_dir: &str,
    daemon: &mut Option<DaemonClient>,
    incarnation: &SessionIncarnation,
    data: Vec<u8>,
) -> Result<(), TaskInputError> {
    let daemon = daemon_for_input(daemon_dir, daemon).await?;
    let event = daemon
        .send_command(&DaemonCommand::InputIfSession {
            session_id: incarnation.session_id.clone(),
            expected_pid: incarnation.pid,
            data,
        })
        .await
        .map_err(|error| TaskInputError::Uncertain(format!("daemon response lost: {error}")))?;
    match event {
        DaemonEvent::Ok => Ok(()),
        DaemonEvent::Error {
            code:
                Some(
                    kanna_daemon::protocol::ErrorCode::SessionNotFound
                    | kanna_daemon::protocol::ErrorCode::SessionIncarnationMismatch,
                ),
            ..
        } => Err(TaskInputError::SessionNotFound),
        DaemonEvent::Error {
            code: Some(kanna_daemon::protocol::ErrorCode::WriteFailed),
            message,
        } => Err(TaskInputError::Uncertain(message)),
        DaemonEvent::Error { message, .. } => Err(TaskInputError::Other(message)),
        other => Err(TaskInputError::Other(format!(
            "unexpected daemon response: {other:?}"
        ))),
    }
}

async fn deliver_message(
    daemon_dir: &str,
    db_path: &str,
    next_sequence: &AtomicU64,
    incarnation: &SessionIncarnation,
    daemon: &mut Option<DaemonClient>,
    request: MessageRequest,
) -> Option<String> {
    let sequence = request
        .sequence
        .unwrap_or_else(|| next_sequence.fetch_add(1, Ordering::Relaxed));
    let mut wrote_message = false;
    let result = async {
        if !request.text.is_empty() {
            send_fenced_input(
                daemon_dir,
                daemon,
                incarnation,
                request.text.as_bytes().to_vec(),
            )
            .await?;
            wrote_message = true;
            tokio::time::sleep(std::time::Duration::from_millis(SUBMIT_ENTER_DELAY_MS)).await;
        }
        send_fenced_input(daemon_dir, daemon, incarnation, vec![b'\r'])
            .await
            .map_err(|error| {
                if wrote_message {
                    TaskInputError::Uncertain(match error {
                        TaskInputError::SessionNotFound => format!(
                            "session disappeared after message bytes were accepted: {}",
                            incarnation.session_id
                        ),
                        TaskInputError::Other(message) | TaskInputError::Uncertain(message) => {
                            message
                        }
                    })
                } else {
                    error
                }
            })
    }
    .await;

    let poison = match &result {
        Err(TaskInputError::Uncertain(reason)) => {
            record_input_event(
                db_path,
                &request.task_id,
                incarnation,
                sequence,
                request.source,
                "uncertain",
                "message",
                Some(&request.text),
            )
            .await;
            Some(reason.clone())
        }
        _ => None,
    };
    if result.is_ok() {
        record_input_event(
            db_path,
            &request.task_id,
            incarnation,
            sequence,
            request.source,
            "delivered",
            "message",
            Some(&request.text),
        )
        .await;
    }
    let _ = request.response.send(result);
    poison
}

#[allow(clippy::too_many_arguments)]
async fn deliver_operator_bytes(
    daemon_dir: &str,
    db_path: &str,
    next_sequence: &AtomicU64,
    incarnation: &SessionIncarnation,
    daemon: &mut Option<DaemonClient>,
    draft: &mut Option<(u64, String, TaskInputSource)>,
    parser: &mut TerminalInputParser,
    deferred_messages: &mut VecDeque<MessageRequest>,
    request: OperatorRequest,
) -> Option<String> {
    if request.data.is_empty() {
        let _ = request.response.send(Ok(()));
        return None;
    }
    let segments = parser.segments(&request.data);
    let mut delivered_segment = false;
    for segment in segments {
        let previous_draft = draft.clone();
        let mut completed_drafts = Vec::new();
        for action in segment.actions {
            match action {
                OperatorAction::Printable if draft.is_none() => {
                    *draft = Some((
                        next_sequence.fetch_add(1, Ordering::Relaxed),
                        request.task_id.clone(),
                        request.source,
                    ));
                }
                OperatorAction::Printable => {}
                OperatorAction::Boundary { delivery, boundary } => {
                    if let Some(draft) = draft.take() {
                        completed_drafts.push((draft, delivery, boundary));
                    }
                }
            }
        }

        match send_fenced_input(daemon_dir, daemon, incarnation, segment.data).await {
            Ok(()) => {
                delivered_segment = true;
                *parser = segment.parser_after;
                for ((sequence, task_id, source), delivery, boundary) in completed_drafts {
                    record_input_event(
                        db_path,
                        &task_id,
                        incarnation,
                        sequence,
                        source,
                        delivery,
                        boundary,
                        None,
                    )
                    .await;
                }
                if draft.is_none() {
                    if let Some(reason) = flush_deferred_messages(
                        daemon_dir,
                        db_path,
                        next_sequence,
                        incarnation,
                        daemon,
                        deferred_messages,
                    )
                    .await
                    {
                        let _ = request
                            .response
                            .send(Err(TaskInputError::Uncertain(reason.clone())));
                        return Some(reason);
                    }
                }
            }
            Err(TaskInputError::Other(reason)) if !delivered_segment => {
                *draft = previous_draft;
                let _ = request.response.send(Err(TaskInputError::Other(reason)));
                return None;
            }
            Err(TaskInputError::Other(reason)) => {
                let reason = format!(
                    "operator request was partly delivered before a later segment failed: {reason}"
                );
                draft.take();
                *parser = TerminalInputParser::default();
                let _ = request
                    .response
                    .send(Err(TaskInputError::Uncertain(reason.clone())));
                return Some(reason);
            }
            Err(TaskInputError::SessionNotFound) => {
                draft.take();
                *parser = TerminalInputParser::default();
                let _ = request.response.send(Err(TaskInputError::SessionNotFound));
                return Some(format!(
                    "session incarnation ended: {}",
                    incarnation.session_id
                ));
            }
            Err(TaskInputError::Uncertain(reason)) => {
                for ((sequence, task_id, source), _, boundary) in completed_drafts {
                    record_input_event(
                        db_path,
                        &task_id,
                        incarnation,
                        sequence,
                        source,
                        "uncertain",
                        boundary,
                        None,
                    )
                    .await;
                }
                if let Some((sequence, task_id, source)) = draft.take() {
                    record_input_event(
                        db_path,
                        &task_id,
                        incarnation,
                        sequence,
                        source,
                        "uncertain",
                        "terminal-enter",
                        None,
                    )
                    .await;
                }
                *parser = TerminalInputParser::default();
                let _ = request
                    .response
                    .send(Err(TaskInputError::Uncertain(reason.clone())));
                return Some(reason);
            }
        }
    }
    let _ = request.response.send(Ok(()));
    None
}

async fn flush_deferred_messages(
    daemon_dir: &str,
    db_path: &str,
    next_sequence: &AtomicU64,
    incarnation: &SessionIncarnation,
    daemon: &mut Option<DaemonClient>,
    deferred_messages: &mut VecDeque<MessageRequest>,
) -> Option<String> {
    while let Some(message) = deferred_messages.pop_front() {
        if message.response.is_closed() {
            continue;
        }
        if let Some(reason) = deliver_message(
            daemon_dir,
            db_path,
            next_sequence,
            incarnation,
            daemon,
            message,
        )
        .await
        {
            return Some(reason);
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
async fn record_input_event(
    db_path: &str,
    task_id: &str,
    incarnation: &SessionIncarnation,
    sequence: u64,
    source: TaskInputSource,
    delivery: &str,
    boundary: &str,
    text: Option<&str>,
) {
    let db_path = db_path.to_string();
    let task_id = task_id.to_string();
    let incarnation = incarnation.clone();
    let delivery = delivery.to_string();
    let boundary = boundary.to_string();
    let text = text.map(|text| {
        let value = text.chars().take(AUDIT_TEXT_LIMIT).collect::<String>();
        let truncated = value.len() < text.len();
        (value, truncated)
    });
    let result = tokio::task::spawn_blocking(move || {
        let db = Db::open(&db_path)?;
        let Some(resolved_task_id) = db.resolve_pipeline_item_id(&task_id)? else {
            return Ok::<(), rusqlite::Error>(());
        };
        let mut payload = json!({
            "source": source.as_str(),
            "queueSequence": sequence,
            "sessionPid": incarnation.pid,
            "delivery": delivery,
            "boundary": boundary,
        });
        if let Some((text, truncated)) = text {
            payload["text"] = json!(text);
            payload["truncated"] = json!(truncated);
        }
        db.append_task_event(&resolved_task_id, TaskEventKind::InputSubmitted, payload)
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => log::warn!("failed to record task input attribution: {error}"),
        Err(error) => log::warn!("task input attribution worker failed: {error}"),
    }
}

pub(crate) fn validate_task_input(source: TaskInputSource, input: &str) -> Result<(), String> {
    if source == TaskInputSource::QuickAction && contains_unresolved_placeholder(input) {
        return Err("quick-action input contains an unresolved template placeholder".to_string());
    }
    Ok(())
}

fn contains_unresolved_placeholder(input: &str) -> bool {
    let bytes = input.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'{' {
            index += 1;
            continue;
        }
        let name_start = index + 1;
        let Some(first) = bytes.get(name_start).copied() else {
            return false;
        };
        if !(first.is_ascii_alphabetic() || first == b'_') {
            index += 1;
            continue;
        }
        let mut cursor = name_start + 1;
        while let Some(byte) = bytes.get(cursor).copied() {
            if byte == b'}' {
                return true;
            }
            if !(byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')) {
                break;
            }
            cursor += 1;
        }
        index += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use kanna_daemon::protocol::Command as DaemonCommand;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    fn spawn_recording_daemon(
        daemon_dir: &std::path::Path,
    ) -> (
        mpsc::UnboundedReceiver<DaemonCommand>,
        tokio::task::JoinHandle<()>,
    ) {
        let socket_path = kanna_runtime_defaults::socket_path(daemon_dir);
        let listener = UnixListener::bind(&socket_path).unwrap();
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let command = serde_json::from_str::<DaemonCommand>(line.trim()).unwrap();
                if commands_tx.send(command).is_err() {
                    break;
                }
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        (commands_rx, daemon)
    }

    async fn next_input_bytes(commands: &mut mpsc::UnboundedReceiver<DaemonCommand>) -> Vec<u8> {
        match commands.recv().await.unwrap() {
            DaemonCommand::InputIfSession {
                session_id,
                expected_pid,
                data,
            } => {
                assert_eq!(session_id, "task-target");
                assert_eq!(expected_pid, 4242);
                data
            }
            other => panic!("expected fenced input, got {other:?}"),
        }
    }

    #[test]
    fn api_is_the_wire_default() {
        assert_eq!(TaskInputSource::default(), TaskInputSource::Api);
        assert_eq!(
            serde_json::from_str::<TaskInputSource>("\"quick_action\"").unwrap(),
            TaskInputSource::QuickAction
        );
    }

    #[test]
    fn quick_actions_reject_unresolved_placeholders() {
        assert!(validate_task_input(TaskInputSource::QuickAction, "Implement {feature}").is_err());
        assert!(validate_task_input(TaskInputSource::QuickAction, "Open {file.name}").is_err());
    }

    #[test]
    fn validation_does_not_blacklist_legitimate_phrases() {
        for input in [
            "Explain this codebase",
            "Run /review on my current changes",
            "Implement the feature",
            "Use a JSON object like { value: 1 }",
        ] {
            assert_eq!(
                validate_task_input(TaskInputSource::QuickAction, input),
                Ok(())
            );
        }
    }

    #[test]
    fn non_quick_action_sources_may_send_literal_braces() {
        assert_eq!(
            validate_task_input(TaskInputSource::Api, "Implement {feature}"),
            Ok(())
        );
    }

    #[tokio::test]
    async fn bracketed_paste_newline_stays_in_draft_until_external_enter() {
        let unique = format!(
            "kanna-bracketed-paste-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let db_path = Db::test_db_path(&unique);
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo").unwrap();
        db.insert_test_pipeline_item(
            "task-target",
            "repo-1",
            "Target",
            None,
            "in progress",
            "2026-08-15T00:00:00Z",
        )
        .unwrap();
        drop(db);

        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            db_path.clone(),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };
        let paste_frames = [
            b"\x1b[20".as_slice(),
            b"0~line1\n".as_slice(),
            b"line2\x1b[201".as_slice(),
            b"~".as_slice(),
        ];

        for frame in paste_frames {
            coordinator
                .send_operator_bytes_if_session("task-target", incarnation.clone(), frame.to_vec())
                .await
                .unwrap();
            assert_eq!(next_input_bytes(&mut commands).await, frame);
        }
        assert!(Db::open(&db_path)
            .unwrap()
            .list_recent_input_events("task-target", 10)
            .unwrap()
            .is_empty());

        let (_, mut message) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "queued message",
            )
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            message.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(commands.try_recv().is_err());

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, vec![b'\r'])
            .await
            .unwrap();
        message.await.unwrap().unwrap();
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);
        assert_eq!(next_input_bytes(&mut commands).await, b"queued message");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);

        let events = Db::open(&db_path)
            .unwrap()
            .list_recent_input_events("task-target", 10)
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["boundary"], "terminal-enter");
        assert_eq!(events[1].payload["boundary"], "message");

        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn cursor_and_clipboard_protocol_bytes_do_not_open_a_draft() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-terminal-protocol"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };
        let protocol = b"\x1b[D\x1b]52;c;Y2xpcGJvYXJk\x07".to_vec();

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, protocol.clone())
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.submit_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "message",
            ),
        )
        .await;
        assert!(matches!(result, Ok(Ok(()))));
        assert_eq!(next_input_bytes(&mut commands).await, protocol);
        assert_eq!(next_input_bytes(&mut commands).await, b"message");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);

        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn application_cursor_protocol_bytes_do_not_open_a_draft() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-application-cursor-protocol"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };
        let protocol = b"\x1bOA".to_vec();

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, protocol.clone())
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.submit_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "message",
            ),
        )
        .await;
        assert!(matches!(result, Ok(Ok(()))));
        assert_eq!(next_input_bytes(&mut commands).await, protocol);
        assert_eq!(next_input_bytes(&mut commands).await, b"message");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);

        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn printable_operator_bytes_open_a_draft() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-printable-draft"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), b"x".to_vec())
            .await
            .unwrap();
        let (_, mut message) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "message",
            )
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert!(matches!(
            message.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, vec![b'\x03'])
            .await
            .unwrap();
        message.await.unwrap().unwrap();
        assert_eq!(next_input_bytes(&mut commands).await, b"x");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\x03']);
        assert_eq!(next_input_bytes(&mut commands).await, b"message");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);

        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn genuine_boundary_flushes_deferred_message_before_later_operator_bytes() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-boundary-fifo"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), b"draft".to_vec())
            .await
            .unwrap();
        let (_, mut message) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "queued",
            )
            .await
            .unwrap();
        tokio::task::yield_now().await;

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), b"\rnext".to_vec())
            .await
            .unwrap();
        assert!(matches!(message.try_recv(), Ok(Ok(()))));
        assert_eq!(next_input_bytes(&mut commands).await, b"draft");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);
        assert_eq!(next_input_bytes(&mut commands).await, b"queued");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);
        assert_eq!(next_input_bytes(&mut commands).await, b"next");

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, vec![b'\x03'])
            .await
            .unwrap();
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\x03']);
        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn boundary_after_cross_frame_escape_closes_draft_and_preserves_fifo() {
        let unique = format!(
            "kanna-escape-boundary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let db_path = Db::test_db_path(&unique);
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo").unwrap();
        db.insert_test_pipeline_item(
            "task-target",
            "repo-1",
            "Target",
            None,
            "in progress",
            "2026-08-15T00:00:00Z",
        )
        .unwrap();
        drop(db);

        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            db_path.clone(),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), b"draft".to_vec())
            .await
            .unwrap();
        let (_, mut message) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "queued",
            )
            .await
            .unwrap();
        tokio::task::yield_now().await;
        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), vec![b'\x1b'])
            .await
            .unwrap();
        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), b"\rnext".to_vec())
            .await
            .unwrap();

        assert!(matches!(message.try_recv(), Ok(Ok(()))));
        assert_eq!(next_input_bytes(&mut commands).await, b"draft");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\x1b']);
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);
        assert_eq!(next_input_bytes(&mut commands).await, b"queued");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);
        assert_eq!(next_input_bytes(&mut commands).await, b"next");

        let events = Db::open(&db_path)
            .unwrap()
            .list_recent_input_events("task-target", 10)
            .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload["boundary"], "terminal-enter");
        assert_eq!(events[1].payload["boundary"], "message");

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, vec![b'\x03'])
            .await
            .unwrap();
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\x03']);
        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_deferred_message_is_cancelled_before_draft_closes() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let (mut commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-deferred-timeout"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation.clone(), b"draft".to_vec())
            .await
            .unwrap();
        let submit_coordinator = coordinator.clone();
        let submit = tokio::spawn(async move {
            submit_coordinator
                .submit_message_if_session(
                    "task-target",
                    "task-target",
                    4242,
                    TaskInputSource::Api,
                    "must not arrive",
                )
                .await
        });
        coordinator.wait_for_admissions(2).await;

        tokio::time::advance(Duration::from_secs(30)).await;
        tokio::task::yield_now().await;
        assert!(submit.is_finished(), "delivery deadline did not fire");
        assert!(matches!(
            submit.await.unwrap(),
            Err(TaskInputError::Other(message)) if message.contains("timed out")
        ));

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, vec![b'\r'])
            .await
            .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(next_input_bytes(&mut commands).await, b"draft");
        assert_eq!(next_input_bytes(&mut commands).await, vec![b'\r']);
        assert!(commands.try_recv().is_err());

        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn deferred_message_queue_is_capped_independently_of_mailbox() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let (_commands, daemon) = spawn_recording_daemon(daemon_dir.path());
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-deferred-capacity"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, b"draft".to_vec())
            .await
            .unwrap();
        let mut responses = Vec::new();
        for index in 0..=INPUT_QUEUE_CAPACITY {
            let (_, response) = coordinator
                .queue_message_if_session(
                    "task-target",
                    "task-target",
                    4242,
                    TaskInputSource::Api,
                    &format!("message {index}"),
                )
                .await
                .unwrap();
            responses.push(response);
        }
        coordinator
            .wait_for_admissions((INPUT_QUEUE_CAPACITY + 2) as u64)
            .await;
        tokio::task::yield_now().await;

        let overflow = responses.last_mut().unwrap().try_recv();
        assert!(matches!(
            overflow,
            Ok(Err(TaskInputError::Other(message))) if message.contains("capacity")
        ));

        drop(responses);
        drop(coordinator);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn partial_human_draft_holds_logical_messages_and_preserves_boundaries() {
        let unique = format!(
            "kanna-input-queue-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let daemon_dir = tempfile::tempdir().unwrap();
        let socket_path = kanna_runtime_defaults::socket_path(daemon_dir.path());
        let listener = UnixListener::bind(&socket_path).unwrap();
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut commands = Vec::new();
            for _ in 0..8 {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                let command = serde_json::from_str::<DaemonCommand>(line.trim()).unwrap();
                commands.push(command);
                write_half
                    .write_all(
                        format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            commands
        });

        let db_path = Db::test_db_path(&unique);
        let db = Db::open_for_tests(&db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo").unwrap();
        db.insert_test_pipeline_item(
            "task-target",
            "repo-1",
            "Target",
            None,
            "in progress",
            "2026-08-15T00:00:00Z",
        )
        .unwrap();
        drop(db);

        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            db_path.clone(),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-target".to_string(),
            pid: 4242,
        };

        coordinator
            .send_operator_bytes_if_session(
                "task-target",
                incarnation.clone(),
                b"approved".to_vec(),
            )
            .await
            .unwrap();

        let (_, mobile) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Human,
                "mobile reply",
            )
            .await
            .unwrap();
        let (_, api) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::Api,
                "api steer",
            )
            .await
            .unwrap();
        let (_, completion) = coordinator
            .queue_message_if_session(
                "task-target",
                "task-target",
                4242,
                TaskInputSource::CompletionNotification,
                "TASK child DONE [success]: Child",
            )
            .await
            .unwrap();

        coordinator
            .send_operator_bytes_if_session("task-target", incarnation, vec![b'\r'])
            .await
            .unwrap();
        mobile.await.unwrap().unwrap();
        api.await.unwrap().unwrap();
        completion.await.unwrap().unwrap();

        let commands = daemon.await.unwrap();
        let writes = commands
            .into_iter()
            .map(|command| match command {
                DaemonCommand::InputIfSession {
                    session_id,
                    expected_pid,
                    data,
                } => {
                    assert_eq!(session_id, "task-target");
                    assert_eq!(expected_pid, 4242);
                    data
                }
                other => panic!("expected fenced input, got {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            writes,
            vec![
                b"approved".to_vec(),
                vec![b'\r'],
                b"mobile reply".to_vec(),
                vec![b'\r'],
                b"api steer".to_vec(),
                vec![b'\r'],
                b"TASK child DONE [success]: Child".to_vec(),
                vec![b'\r'],
            ]
        );

        let db = Db::open(&db_path).unwrap();
        let events = db.list_recent_input_events("task-target", 10).unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].payload["source"], "human");
        assert_eq!(events[0].payload["boundary"], "terminal-enter");
        assert_eq!(events[1].payload["source"], "human");
        assert_eq!(events[1].payload["text"], "mobile reply");
        assert_eq!(events[2].payload["source"], "api");
        assert_eq!(events[3].payload["source"], "completion_notification");
        let sequences = events
            .iter()
            .map(|event| event.payload["queueSequence"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(sequences, vec![1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn definite_connect_failure_does_not_poison_session_queue() {
        let daemon_dir = tempfile::tempdir().unwrap();
        let coordinator = TaskInputCoordinator::new(
            daemon_dir.path().to_string_lossy().to_string(),
            Db::test_db_path("input-definite-reconnect"),
        );
        let incarnation = SessionIncarnation {
            session_id: "task-reconnect".to_string(),
            pid: 7373,
        };

        assert!(matches!(
            coordinator
                .send_operator_bytes_if_session(
                    "task-reconnect",
                    incarnation.clone(),
                    b"before".to_vec(),
                )
                .await,
            Err(TaskInputError::Other(_))
        ));

        let socket_path = kanna_runtime_defaults::socket_path(daemon_dir.path());
        let listener = UnixListener::bind(&socket_path).unwrap();
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let command = serde_json::from_str::<DaemonCommand>(line.trim()).unwrap();
            write_half
                .write_all(
                    format!("{}\n", serde_json::to_string(&DaemonEvent::Ok).unwrap()).as_bytes(),
                )
                .await
                .unwrap();
            command
        });

        coordinator
            .send_operator_bytes_if_session("task-reconnect", incarnation, b"after\r".to_vec())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(daemon.await.unwrap()).unwrap(),
            serde_json::to_value(DaemonCommand::InputIfSession {
                session_id: "task-reconnect".to_string(),
                expected_pid: 7373,
                data: b"after\r".to_vec(),
            })
            .unwrap()
        );
    }
}
