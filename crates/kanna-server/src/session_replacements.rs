use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// What the replacement bookkeeping knows about an arriving `Exit`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ConsumedReplacement {
    /// True when this `Exit` belongs to an orchestrated kill.
    pub replaced: bool,
    /// The stage run the killed session was serving, when its killer named
    /// one and no overlapping kill contradicted it.
    pub outgoing_run_id: Option<String>,
}

/// Session ids whose daemon `Exit` event is an orchestrated kill (stage
/// swap, rerun, task close), not the agent finishing on its own.
///
/// One kill produces exactly one `Exit`, so entries are consume-once:
/// `begin_for_run` before sending the Kill (the broadcast races the Kill
/// response), `cancel` when the daemon reports the session did not exist (no
/// Exit is coming), and the Exit watcher `consume`s the entry when the event
/// arrives — regardless of how delayed its processing is. `clear` runs when
/// the watcher reconnects, since Exits broadcast while disconnected are
/// lost along with their entries.
///
/// An entry also carries the stage run the outgoing session was serving,
/// when its killer knows it. The provider session id the daemon discovers on
/// the way out (Codex's rollout uuid) belongs to that run and to no other:
/// a stage transition respawns the same session id for the next stage, so by
/// the time the `Exit` is processed the task's latest run is usually the
/// replacement, not the run that held the conversation.
#[derive(Clone, Default)]
pub struct SessionReplacements(Arc<Mutex<HashMap<String, Option<String>>>>);

impl SessionReplacements {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Option<String>>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register a kill, naming the stage run the outgoing session was serving
    /// when the killer knows it. Kills that retire a session without a run of
    /// their own (a worktree shell, a teardown session, a post-spawn cleanup)
    /// pass `None`.
    ///
    /// Entries are consume-once per session id, so overlapping kills share
    /// one entry and one `Exit`. When they disagree about the outgoing run —
    /// including an unnamed kill overlapping a named one — the entry keeps no
    /// run at all: an ambiguous attribution is worse than none, because it
    /// would write one conversation's id onto another run.
    pub fn begin_for_run(&self, session_id: &str, outgoing_run_id: Option<&str>) {
        let outgoing_run_id = outgoing_run_id
            .map(str::trim)
            .filter(|run_id| !run_id.is_empty());
        let mut sessions = self.lock();
        match sessions.get_mut(session_id) {
            Some(existing) => {
                if existing.as_deref() != outgoing_run_id {
                    *existing = None;
                }
            }
            None => {
                sessions.insert(session_id.to_string(), outgoing_run_id.map(str::to_string));
            }
        }
    }

    pub fn cancel(&self, session_id: &str) {
        self.lock().remove(session_id);
    }

    pub fn consume(&self, session_id: &str) -> ConsumedReplacement {
        match self.lock().remove(session_id) {
            Some(outgoing_run_id) => ConsumedReplacement {
                replaced: true,
                outgoing_run_id,
            },
            None => ConsumedReplacement::default(),
        }
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consume_returns_the_run_its_killer_named_exactly_once() {
        let replacements = SessionReplacements::default();
        replacements.begin_for_run("session-1", Some("run-impl"));

        let consumed = replacements.consume("session-1");
        assert!(consumed.replaced);
        assert_eq!(consumed.outgoing_run_id.as_deref(), Some("run-impl"));
        assert_eq!(
            replacements.consume("session-1"),
            ConsumedReplacement::default(),
            "a duplicate Exit must not be classified as another replacement"
        );
    }

    #[test]
    fn overlapping_kills_that_disagree_attribute_to_no_run() {
        let replacements = SessionReplacements::default();
        replacements.begin_for_run("session-1", Some("run-impl"));
        // A second kill of the same session id — the cleanup kills on the
        // transition's failure paths take this shape — shares the one entry.
        replacements.begin_for_run("session-1", None);

        let consumed = replacements.consume("session-1");
        assert!(consumed.replaced);
        assert_eq!(
            consumed.outgoing_run_id, None,
            "an Exit that two kills could claim must not be attributed to either"
        );
    }

    #[test]
    fn repeating_the_same_run_keeps_it() {
        let replacements = SessionReplacements::default();
        replacements.begin_for_run("session-1", Some("run-impl"));
        replacements.begin_for_run("session-1", Some("run-impl"));

        assert_eq!(
            replacements.consume("session-1").outgoing_run_id.as_deref(),
            Some("run-impl")
        );
    }

    #[test]
    fn cancel_and_clear_drop_the_recorded_run() {
        let replacements = SessionReplacements::default();
        replacements.begin_for_run("session-1", Some("run-impl"));
        replacements.cancel("session-1");
        assert!(!replacements.consume("session-1").replaced);

        replacements.begin_for_run("session-2", Some("run-other"));
        replacements.clear();
        assert!(!replacements.consume("session-2").replaced);
    }
}
