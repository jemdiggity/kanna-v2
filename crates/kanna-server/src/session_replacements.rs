use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Session ids whose daemon `Exit` event is an orchestrated kill (stage
/// swap, rerun, task close), not the agent finishing on its own.
///
/// One kill produces exactly one `Exit`, so `begin` increments the outstanding
/// count before sending the Kill (the broadcast races the Kill response),
/// `cancel` decrements it when the daemon reports the session did not exist
/// (no Exit is coming), and the Exit watcher `consume`s one count when the
/// event arrives — regardless of how delayed its processing is. Counting is
/// required because replacement kills for one session id can overlap. `clear`
/// runs when the watcher reconnects, since Exits broadcast while disconnected
/// are lost along with their entries.
#[derive(Clone, Default)]
pub struct SessionReplacements {
    sessions: Arc<Mutex<HashMap<String, usize>>>,
    task_input: Option<crate::task_input_queue::TaskInputCoordinator>,
}

impl SessionReplacements {
    pub(crate) fn with_task_input(
        task_input: crate::task_input_queue::TaskInputCoordinator,
    ) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            task_input: Some(task_input),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, usize>> {
        self.sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self, session_id: &str) {
        let mut sessions = self.lock();
        let outstanding = sessions.entry(session_id.to_string()).or_insert(0);
        *outstanding = outstanding.saturating_add(1);
        drop(sessions);
        if let Some(task_input) = &self.task_input {
            task_input.begin_session_replacement(session_id);
        }
    }

    pub fn finish(&self, session_id: &str) {
        if let Some(task_input) = &self.task_input {
            task_input.finish_session_replacement(session_id);
        }
    }

    pub fn cancel(&self, session_id: &str) {
        if self.consume(session_id) {
            self.finish(session_id);
        }
    }

    pub fn consume(&self, session_id: &str) -> bool {
        let mut sessions = self.lock();
        let Some(outstanding) = sessions.get_mut(session_id) else {
            return false;
        };
        *outstanding = outstanding.saturating_sub(1);
        if *outstanding == 0 {
            sessions.remove(session_id);
        }
        true
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}
