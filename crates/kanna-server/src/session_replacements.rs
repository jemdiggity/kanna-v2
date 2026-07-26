use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

struct ReplacementMarker {
    id: u64,
    run_id: Option<String>,
}

/// Session ids whose daemon `Exit` event is an orchestrated kill (stage
/// swap, rerun, task close), not the agent finishing on its own.
///
/// One kill produces exactly one `Exit`, so entries are consume-once:
/// `begin` before sending the Kill (the broadcast races the Kill response),
/// `cancel` when the daemon reports the session did not exist (no Exit is
/// coming), and the Exit watcher `consume`s the entry when the event
/// arrives — regardless of how delayed its processing is. `clear` runs when
/// the watcher reconnects, since Exits broadcast while disconnected are
/// lost along with their entries.
#[derive(Clone, Default)]
pub struct SessionReplacements(
    Arc<Mutex<HashMap<String, VecDeque<ReplacementMarker>>>>,
    Arc<AtomicU64>,
);

impl SessionReplacements {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, VecDeque<ReplacementMarker>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    pub fn begin(&self, session_id: &str) -> u64 {
        self.begin_for_run(session_id, None)
    }

    /// Record the immutable run that owns the process being replaced.
    ///
    /// Mixed-version daemons can emit an ownershipless `Exit`. Keeping the
    /// captured source run here prevents that delayed event from being
    /// resolved against a newer pending run for the same task session.
    pub fn begin_for_run(&self, session_id: &str, expected_run_id: Option<&str>) -> u64 {
        let id = self.1.fetch_add(1, Ordering::Relaxed);
        self.lock()
            .entry(session_id.to_string())
            .or_default()
            .push_back(ReplacementMarker {
                id,
                run_id: expected_run_id.map(str::to_string),
            });
        id
    }

    pub fn cancel(&self, session_id: &str, marker_id: u64) {
        let mut entries = self.lock();
        let remove_entry = entries.get_mut(session_id).is_some_and(|queue| {
            if let Some(index) = queue.iter().position(|marker| marker.id == marker_id) {
                queue.remove(index);
            }
            queue.is_empty()
        });
        if remove_entry {
            entries.remove(session_id);
        }
    }

    #[cfg(test)]
    pub fn consume(&self, session_id: &str) -> bool {
        self.take(session_id).is_some()
    }

    pub fn take(&self, session_id: &str) -> Option<Option<String>> {
        let mut entries = self.lock();
        let (replacement, remove_entry) = {
            let queue = entries.get_mut(session_id)?;
            let replacement = queue.pop_front().map(|marker| marker.run_id);
            (replacement, queue.is_empty())
        };
        if remove_entry {
            entries.remove(session_id);
        }
        replacement
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::SessionReplacements;

    #[test]
    fn delayed_sequential_replacements_keep_source_runs_in_exit_order() {
        let replacements = SessionReplacements::default();
        replacements.begin_for_run("task-1", Some("run-a"));
        replacements.begin_for_run("task-1", Some("run-b"));

        assert_eq!(replacements.take("task-1"), Some(Some("run-a".to_string())));
        assert_eq!(replacements.take("task-1"), Some(Some("run-b".to_string())));
        assert_eq!(replacements.take("task-1"), None);
    }

    #[test]
    fn failed_latest_kill_cancels_only_its_queued_replacement() {
        let replacements = SessionReplacements::default();
        replacements.begin_for_run("task-1", Some("run-a"));
        let run_b = replacements.begin_for_run("task-1", Some("run-b"));
        replacements.cancel("task-1", run_b);

        assert_eq!(replacements.take("task-1"), Some(Some("run-a".to_string())));
        assert_eq!(replacements.take("task-1"), None);
    }

    #[test]
    fn failed_older_kill_cancels_its_exact_marker() {
        let replacements = SessionReplacements::default();
        let run_a = replacements.begin_for_run("task-1", Some("run-a"));
        replacements.begin_for_run("task-1", Some("run-b"));
        replacements.cancel("task-1", run_a);

        assert_eq!(replacements.take("task-1"), Some(Some("run-b".to_string())));
        assert_eq!(replacements.take("task-1"), None);
    }
}
