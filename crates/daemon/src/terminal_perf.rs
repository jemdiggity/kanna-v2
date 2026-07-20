use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const STALL_THRESHOLD: Duration = Duration::from_millis(500);
pub const STALL_REPEAT_INTERVAL: Duration = Duration::from_secs(10);
pub const OUTPUT_GAP_THRESHOLD: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalPerfContext {
    pub component: &'static str,
    pub session_id: String,
    pub task_id: Option<String>,
    pub stage: &'static str,
    pub chunk: u64,
    pub bytes: usize,
    pub pending_chunks: Option<usize>,
    pub pending_bytes: Option<usize>,
    pub queue_available: Option<usize>,
    pub queue_capacity: Option<usize>,
    pub prior_stage: Option<&'static str>,
}

impl TerminalPerfContext {
    pub fn new(
        component: &'static str,
        session_id: impl Into<String>,
        stage: &'static str,
    ) -> Self {
        Self {
            component,
            session_id: session_id.into(),
            task_id: None,
            stage,
            chunk: 0,
            bytes: 0,
            pending_chunks: None,
            pending_bytes: None,
            queue_available: None,
            queue_capacity: None,
            prior_stage: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalPerfEventKind {
    Stall,
    Recovered,
    Gap,
}

impl TerminalPerfEventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stall => "stall",
            Self::Recovered => "recovered",
            Self::Gap => "gap",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalPerfEvent {
    pub context: TerminalPerfContext,
    pub kind: TerminalPerfEventKind,
    pub duration: Duration,
}

#[derive(Debug)]
struct ActiveOperation {
    context: TerminalPerfContext,
    started_at: Instant,
    last_reported_at: Option<Instant>,
}

#[derive(Debug, Default)]
struct MonitorState {
    next_id: u64,
    active: HashMap<u64, ActiveOperation>,
}

#[derive(Clone, Debug)]
pub struct TerminalPerfMonitor {
    state: Arc<Mutex<MonitorState>>,
    stall_threshold: Duration,
    repeat_interval: Duration,
}

impl Default for TerminalPerfMonitor {
    fn default() -> Self {
        Self::with_thresholds(STALL_THRESHOLD, STALL_REPEAT_INTERVAL)
    }
}

impl TerminalPerfMonitor {
    pub fn with_thresholds(stall_threshold: Duration, repeat_interval: Duration) -> Self {
        Self {
            state: Arc::new(Mutex::new(MonitorState::default())),
            stall_threshold,
            repeat_interval,
        }
    }

    pub fn begin(&self, context: TerminalPerfContext) -> TerminalPerfGuard {
        self.begin_at(context, Instant::now())
    }

    pub fn begin_at(&self, context: TerminalPerfContext, started_at: Instant) -> TerminalPerfGuard {
        let id = self.with_state(|state| {
            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1);
            state.active.insert(
                id,
                ActiveOperation {
                    context,
                    started_at,
                    last_reported_at: None,
                },
            );
            id
        });

        TerminalPerfGuard {
            monitor: self.clone(),
            id: Some(id),
        }
    }

    pub fn poll(&self) -> Vec<TerminalPerfEvent> {
        self.poll_at(Instant::now())
    }

    pub fn poll_at(&self, now: Instant) -> Vec<TerminalPerfEvent> {
        let stall_threshold = self.stall_threshold;
        let repeat_interval = self.repeat_interval;
        self.with_state(|state| {
            let mut events = Vec::new();
            for operation in state.active.values_mut() {
                let duration = now.saturating_duration_since(operation.started_at);
                if duration < stall_threshold {
                    continue;
                }

                let should_report = operation
                    .last_reported_at
                    .map(|last| now.saturating_duration_since(last) >= repeat_interval)
                    .unwrap_or(true);
                if should_report {
                    operation.last_reported_at = Some(now);
                    events.push(TerminalPerfEvent {
                        context: operation.context.clone(),
                        kind: TerminalPerfEventKind::Stall,
                        duration,
                    });
                }
            }
            events
        })
    }

    pub fn active_count(&self) -> usize {
        self.with_state(|state| state.active.len())
    }

    fn finish_at(&self, id: u64, now: Instant) -> Vec<TerminalPerfEvent> {
        let stall_threshold = self.stall_threshold;
        self.with_state(|state| {
            let Some(operation) = state.active.remove(&id) else {
                return Vec::new();
            };
            let duration = now.saturating_duration_since(operation.started_at);
            if duration < stall_threshold {
                return Vec::new();
            }

            let mut events = Vec::with_capacity(2);
            if operation.last_reported_at.is_none() {
                events.push(TerminalPerfEvent {
                    context: operation.context.clone(),
                    kind: TerminalPerfEventKind::Stall,
                    duration,
                });
            }
            events.push(TerminalPerfEvent {
                context: operation.context,
                kind: TerminalPerfEventKind::Recovered,
                duration,
            });
            events
        })
    }

    fn with_state<T>(&self, f: impl FnOnce(&mut MonitorState) -> T) -> T {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        f(&mut state)
    }
}

#[derive(Debug)]
pub struct TerminalPerfGuard {
    monitor: TerminalPerfMonitor,
    id: Option<u64>,
}

impl TerminalPerfGuard {
    pub fn finish_at(&mut self, now: Instant) -> Vec<TerminalPerfEvent> {
        let Some(id) = self.id.take() else {
            return Vec::new();
        };
        self.monitor.finish_at(id, now)
    }

    pub fn finish(mut self) {
        let events = self.finish_at(Instant::now());
        emit_events(events);
    }
}

impl Drop for TerminalPerfGuard {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            emit_events(self.monitor.finish_at(id, Instant::now()));
        }
    }
}

pub fn format_event(event: &TerminalPerfEvent, at_ms: u128) -> String {
    let context = &event.context;
    let mut fields = vec![
        "terminal_perf".to_string(),
        format!("at_ms={at_ms}"),
        format!("component={}", context.component),
        format!("session_id={}", context.session_id),
        format!("stage={}", context.stage),
        format!("event={}", event.kind.as_str()),
        format!("duration_ms={}", event.duration.as_millis()),
        format!("chunk={}", context.chunk),
        format!("bytes={}", context.bytes),
    ];
    if let Some(task_id) = &context.task_id {
        fields.push(format!("task_id={task_id}"));
    }
    if let Some(pending_chunks) = context.pending_chunks {
        fields.push(format!("pending_chunks={pending_chunks}"));
    }
    if let Some(pending_bytes) = context.pending_bytes {
        fields.push(format!("pending_bytes={pending_bytes}"));
    }
    if let Some(queue_available) = context.queue_available {
        fields.push(format!("queue_available={queue_available}"));
    }
    if let Some(queue_capacity) = context.queue_capacity {
        fields.push(format!("queue_capacity={queue_capacity}"));
    }
    if let Some(prior_stage) = context.prior_stage {
        fields.push(format!("prior_stage={prior_stage}"));
    }
    fields.join(" ")
}

pub fn emit_event(event: TerminalPerfEvent) {
    let at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    log::warn!("{}", format_event(&event, at_ms));
}

pub fn emit_events(events: impl IntoIterator<Item = TerminalPerfEvent>) {
    for event in events {
        emit_event(event);
    }
}

pub fn emit_gap(context: TerminalPerfContext, duration: Duration) {
    emit_event(TerminalPerfEvent {
        context,
        kind: TerminalPerfEventKind::Gap,
        duration,
    });
}

static GLOBAL_MONITOR: OnceLock<TerminalPerfMonitor> = OnceLock::new();
static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);

pub fn global_monitor() -> &'static TerminalPerfMonitor {
    GLOBAL_MONITOR.get_or_init(TerminalPerfMonitor::default)
}

pub fn start_global_watchdog() {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    if WATCHDOG_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    let monitor = global_monitor().clone();
    runtime.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            emit_events(monitor.poll());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn context() -> TerminalPerfContext {
        TerminalPerfContext {
            component: "daemon",
            session_id: "session-123".to_string(),
            task_id: Some("task-456".to_string()),
            stage: "attached_writer",
            chunk: 7,
            bytes: 4096,
            pending_chunks: Some(2),
            pending_bytes: Some(8192),
            queue_available: Some(0),
            queue_capacity: Some(64),
            prior_stage: None,
        }
    }

    #[test]
    fn operation_reports_once_at_threshold_then_recovers() {
        let monitor = TerminalPerfMonitor::with_thresholds(
            Duration::from_millis(500),
            Duration::from_secs(10),
        );
        let start = Instant::now();
        let mut operation = monitor.begin_at(context(), start);

        assert!(monitor
            .poll_at(start + Duration::from_millis(499))
            .is_empty());

        let stalled = monitor.poll_at(start + Duration::from_millis(500));
        assert_eq!(stalled.len(), 1);
        assert_eq!(stalled[0].kind, TerminalPerfEventKind::Stall);
        assert_eq!(stalled[0].duration, Duration::from_millis(500));

        assert!(monitor
            .poll_at(start + Duration::from_millis(501))
            .is_empty());

        let recovered = operation.finish_at(start + Duration::from_millis(750));
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].kind, TerminalPerfEventKind::Recovered);
        assert_eq!(recovered[0].duration, Duration::from_millis(750));
        assert_eq!(monitor.active_count(), 0);
    }

    #[test]
    fn continuing_stall_is_rate_limited() {
        let monitor = TerminalPerfMonitor::with_thresholds(
            Duration::from_millis(500),
            Duration::from_secs(10),
        );
        let start = Instant::now();
        let _operation = monitor.begin_at(context(), start);

        assert_eq!(monitor.poll_at(start + Duration::from_millis(500)).len(), 1);
        assert!(monitor
            .poll_at(start + Duration::from_millis(10_499))
            .is_empty());
        assert_eq!(
            monitor.poll_at(start + Duration::from_millis(10_500)).len(),
            1
        );
    }

    #[test]
    fn finishing_unpolled_slow_operation_still_reports_stall_and_recovery() {
        let monitor = TerminalPerfMonitor::with_thresholds(
            Duration::from_millis(500),
            Duration::from_secs(10),
        );
        let start = Instant::now();
        let mut operation = monitor.begin_at(context(), start);

        let events = operation.finish_at(start + Duration::from_millis(750));

        assert_eq!(
            events.iter().map(|event| event.kind).collect::<Vec<_>>(),
            vec![
                TerminalPerfEventKind::Stall,
                TerminalPerfEventKind::Recovered
            ]
        );
        assert!(events
            .iter()
            .all(|event| event.duration == Duration::from_millis(750)));
    }

    #[test]
    fn dropping_guard_removes_operation() {
        let monitor = TerminalPerfMonitor::with_thresholds(
            Duration::from_millis(500),
            Duration::from_secs(10),
        );
        let operation = monitor.begin_at(context(), Instant::now());
        assert_eq!(monitor.active_count(), 1);

        drop(operation);

        assert_eq!(monitor.active_count(), 0);
    }

    #[test]
    fn formatted_record_is_stable_and_contains_no_terminal_payload() {
        let event = TerminalPerfEvent {
            context: context(),
            kind: TerminalPerfEventKind::Stall,
            duration: Duration::from_millis(625),
        };

        let record = format_event(&event, 1_721_526_400_000);

        assert!(record.starts_with("terminal_perf "));
        assert!(record.contains("at_ms=1721526400000"));
        assert!(record.contains("event=stall"));
        assert!(record.contains("stage=attached_writer"));
        assert!(record.contains("duration_ms=625"));
        assert!(record.contains("pending_chunks=2"));
        assert!(record.contains("queue_capacity=64"));
        assert!(!record.contains("TOP_SECRET_TERMINAL_PAYLOAD"));
    }
}
