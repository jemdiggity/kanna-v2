use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type AttachmentCounts = Arc<Mutex<HashMap<String, usize>>>;

#[derive(Clone, Default)]
pub(crate) struct TerminalAttachments {
    counts: AttachmentCounts,
}

pub(crate) struct TerminalAttachmentLease {
    session_id: String,
    counts: AttachmentCounts,
}

impl TerminalAttachments {
    pub(crate) fn attach(&self, session_id: impl Into<String>) -> TerminalAttachmentLease {
        let session_id = session_id.into();
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *counts.entry(session_id.clone()).or_default() += 1;
        drop(counts);
        TerminalAttachmentLease {
            session_id,
            counts: self.counts.clone(),
        }
    }

    pub(crate) fn is_attached(&self, session_id: &str) -> bool {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id)
    }
}

impl Drop for TerminalAttachmentLease {
    fn drop(&mut self) {
        let mut counts = self
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(count) = counts.get_mut(&self.session_id) else {
            return;
        };
        *count -= 1;
        if *count == 0 {
            counts.remove(&self.session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_refcounts_multiple_live_attachments_per_session() {
        let registry = TerminalAttachments::default();

        let first = registry.attach("session-1");
        let second = registry.attach("session-1");
        let other = registry.attach("session-2");
        assert!(registry.is_attached("session-1"));
        assert!(registry.is_attached("session-2"));

        drop(first);
        assert!(registry.is_attached("session-1"));

        drop(second);
        assert!(!registry.is_attached("session-1"));
        assert!(registry.is_attached("session-2"));

        drop(other);
        assert!(!registry.is_attached("session-2"));
    }
}
