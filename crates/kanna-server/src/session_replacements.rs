use std::collections::HashSet;
use std::sync::{Arc, Mutex};

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
pub struct SessionReplacements(Arc<Mutex<HashSet<String>>>);

impl SessionReplacements {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self, session_id: &str) {
        self.lock().insert(session_id.to_string());
    }

    pub fn cancel(&self, session_id: &str) {
        self.lock().remove(session_id);
    }

    pub fn consume(&self, session_id: &str) -> bool {
        self.lock().remove(session_id)
    }

    pub fn clear(&self) {
        self.lock().clear();
    }
}
