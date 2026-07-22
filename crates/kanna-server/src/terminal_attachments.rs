use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

type AttachmentCounts = Arc<Mutex<HashMap<String, usize>>>;
type DetachReceiver = mpsc::UnboundedReceiver<String>;

#[derive(Clone)]
pub(crate) struct TerminalAttachments {
    counts: AttachmentCounts,
    detached_tx: mpsc::UnboundedSender<String>,
    detached_rx: Arc<Mutex<Option<DetachReceiver>>>,
}

pub(crate) struct TerminalAttachmentLease {
    session_id: String,
    counts: AttachmentCounts,
    detached_tx: mpsc::UnboundedSender<String>,
}

impl Default for TerminalAttachments {
    fn default() -> Self {
        let (detached_tx, detached_rx) = mpsc::unbounded_channel();
        Self {
            counts: Arc::default(),
            detached_tx,
            detached_rx: Arc::new(Mutex::new(Some(detached_rx))),
        }
    }
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
            detached_tx: self.detached_tx.clone(),
        }
    }

    pub(crate) fn is_attached(&self, session_id: &str) -> bool {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(session_id)
    }

    pub(crate) fn take_detach_receiver(&self) -> Option<DetachReceiver> {
        self.detached_rx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
    }
}

impl Drop for TerminalAttachmentLease {
    fn drop(&mut self) {
        let detached = {
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
                true
            } else {
                false
            }
        };

        if detached {
            let _ = self.detached_tx.send(self.session_id.clone());
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

    #[test]
    fn final_lease_drop_emits_exactly_one_detach_notification() {
        let registry = TerminalAttachments::default();
        let mut detached = registry
            .take_detach_receiver()
            .expect("detach receiver should be available once");
        let first = registry.attach("session-1");
        let second = registry.attach("session-1");

        drop(first);
        assert!(matches!(
            detached.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        drop(second);
        assert_eq!(detached.try_recv().unwrap(), "session-1");
        assert!(matches!(
            detached.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn detach_receiver_can_only_be_taken_once() {
        let registry = TerminalAttachments::default();

        assert!(registry.take_detach_receiver().is_some());
        assert!(registry.take_detach_receiver().is_none());
    }
}
