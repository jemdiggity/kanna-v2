use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::fanout::SessionFanouts;
use crate::protocol::TerminalViewerRole;

/// A single client's writer handle.
pub(crate) type SessionWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;

pub(crate) type TerminalEmulatorClients = Arc<Mutex<HashMap<String, HashSet<usize>>>>;

/// A live, measured terminal viewer. The writer id is the attachment fence:
/// it cannot be reused by a replacement socket, and generation rejects stale
/// messages from a replaced viewer on a connection that is being reused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalViewer {
    pub viewer_id: String,
    pub role: TerminalViewerRole,
    pub cols: u16,
    pub rows: u16,
    pub visible: bool,
    pub generation: u64,
}

impl TerminalViewer {
    fn eligible(&self) -> bool {
        self.visible && self.cols > 0 && self.rows > 0
    }
}

/// The daemon-owned size policy for one PTY. `legacy_sizes` exists only for
/// undeclared peers; once any viewer registers, legacy resize requests cannot
/// displace its controller. `last_applied` deliberately survives the last
/// detach so an empty session never jumps back to 80x24.
#[derive(Debug, Clone)]
pub(crate) struct SessionSizeState {
    pub last_applied: (u16, u16),
    pub viewers: HashMap<usize, TerminalViewer>,
    pub legacy_sizes: HashMap<usize, (u16, u16)>,
    pub controller: Option<usize>,
    pub explicit_controller: Option<usize>,
}

impl SessionSizeState {
    pub(crate) fn new(spawn_size: (u16, u16)) -> Self {
        Self {
            last_applied: spawn_size,
            viewers: HashMap::new(),
            legacy_sizes: HashMap::new(),
            controller: None,
            explicit_controller: None,
        }
    }

    /// Compatibility helper for old tests and legacy callers.
    #[cfg(test)]
    pub(crate) fn insert(&mut self, writer_id: usize, size: (u16, u16)) {
        self.legacy_sizes.insert(writer_id, size);
    }

    fn elected_candidate(&self) -> Option<usize> {
        let mut candidates: Vec<(u8, &str, usize)> = self
            .viewers
            .iter()
            .filter(|(_, viewer)| viewer.eligible())
            .map(|(writer_id, viewer)| {
                let class = match viewer.role {
                    TerminalViewerRole::Local => 0,
                    TerminalViewerRole::Remote => 1,
                };
                (class, viewer.viewer_id.as_str(), *writer_id)
            })
            .collect();
        candidates.sort_unstable_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(right.1))
                .then_with(|| left.2.cmp(&right.2))
        });
        candidates.first().map(|candidate| candidate.2)
    }

    fn has_eligible_local(&self) -> bool {
        self.viewers
            .values()
            .any(|viewer| viewer.eligible() && viewer.role == TerminalViewerRole::Local)
    }

    fn elect(&mut self) -> bool {
        let old_controller = self.controller;
        if let Some(explicit) = self.explicit_controller {
            if self
                .viewers
                .get(&explicit)
                .is_some_and(TerminalViewer::eligible)
            {
                self.controller = Some(explicit);
                return old_controller != self.controller;
            }
            self.explicit_controller = None;
        }

        let current_is_eligible = self
            .controller
            .and_then(|writer_id| self.viewers.get(&writer_id))
            .is_some_and(TerminalViewer::eligible);
        let current_is_remote = self
            .controller
            .and_then(|writer_id| self.viewers.get(&writer_id))
            .is_some_and(|viewer| viewer.role == TerminalViewerRole::Remote);
        if current_is_eligible && !(current_is_remote && self.has_eligible_local()) {
            return false;
        }
        self.controller = self.elected_candidate();
        old_controller != self.controller
    }

    fn proposed_size(&self) -> (u16, u16) {
        if let Some(controller) = self.controller.and_then(|id| self.viewers.get(&id)) {
            return (controller.cols, controller.rows);
        }
        if self.viewers.is_empty() {
            return effective_terminal_size(&self.legacy_sizes, self.last_applied);
        }
        self.last_applied
    }

    fn pending_resize(&self) -> Option<(u16, u16)> {
        let proposed = self.proposed_size();
        (proposed != self.last_applied).then_some(proposed)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn register(
        &mut self,
        writer_id: usize,
        viewer_id: String,
        role: TerminalViewerRole,
        cols: u16,
        rows: u16,
        visible: bool,
        generation: u64,
    ) -> Option<(u16, u16)> {
        if self
            .viewers
            .get(&writer_id)
            .is_some_and(|viewer| viewer.generation > generation)
        {
            return None;
        }
        self.viewers.insert(
            writer_id,
            TerminalViewer {
                viewer_id,
                role,
                cols,
                rows,
                visible,
                generation,
            },
        );
        self.elect();
        self.pending_resize()
    }

    pub(crate) fn resize(&mut self, writer_id: usize, cols: u16, rows: u16) -> Option<(u16, u16)> {
        if let Some(viewer) = self.viewers.get_mut(&writer_id) {
            if viewer.visible && cols > 0 && rows > 0 {
                viewer.cols = cols;
                viewer.rows = rows;
            }
            self.elect();
            if self.controller == Some(writer_id) {
                return self.pending_resize();
            }
            return None;
        }
        // Legacy behavior is retained only while every participant is legacy.
        self.legacy_sizes.insert(writer_id, (cols, rows));
        self.pending_resize()
    }

    pub(crate) fn takeover(&mut self, writer_id: usize) -> Option<(u16, u16)> {
        if self
            .viewers
            .get(&writer_id)
            .is_some_and(TerminalViewer::eligible)
        {
            self.explicit_controller = Some(writer_id);
            self.controller = Some(writer_id);
            return self.pending_resize();
        }
        None
    }

    pub(crate) fn release(&mut self, writer_id: usize) -> Option<(u16, u16)> {
        if self.explicit_controller == Some(writer_id) {
            self.explicit_controller = None;
            self.controller = None;
            self.elect();
            return self.pending_resize();
        }
        None
    }

    pub(crate) fn remove(&mut self, writer_id: usize) -> Option<(u16, u16)> {
        self.viewers.remove(&writer_id);
        let removed_legacy = self.legacy_sizes.remove(&writer_id).is_some();
        let controlled =
            self.controller == Some(writer_id) || self.explicit_controller == Some(writer_id);
        if controlled {
            self.controller = None;
            self.explicit_controller = None;
            self.elect();
            return self.pending_resize();
        }
        if removed_legacy && self.viewers.is_empty() {
            return self.pending_resize();
        }
        None
    }

    pub(crate) fn mark_applied(&mut self, size: (u16, u16)) {
        self.last_applied = size;
    }
}

impl Default for SessionSizeState {
    fn default() -> Self {
        Self::new((80, 24))
    }
}

/// Per-session size controllers.
pub(crate) type SessionSizes = Arc<Mutex<HashMap<String, SessionSizeState>>>;

pub(crate) type LostHandoffSessions = Arc<Mutex<HashMap<String, String>>>;

/// Compatibility-only minimum policy for sessions whose viewers have not
/// registered geometry support yet.
pub(crate) fn effective_terminal_size(
    client_sizes: &HashMap<usize, (u16, u16)>,
    fallback: (u16, u16),
) -> (u16, u16) {
    let min_cols = client_sizes
        .values()
        .map(|(cols, _)| *cols)
        .min()
        .unwrap_or(fallback.0);
    let min_rows = client_sizes
        .values()
        .map(|(_, rows)| *rows)
        .min()
        .unwrap_or(fallback.1);
    (min_cols, min_rows)
}

pub(crate) async fn register_terminal_emulator_client(
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    writer: &SessionWriter,
) {
    let writer_id = Arc::as_ptr(writer) as usize;
    let mut terminal_clients = terminal_emulator_clients.lock().await;
    let client_ids = terminal_clients.entry(session_id.to_string()).or_default();
    client_ids.insert(writer_id);
}

pub(crate) async fn unregister_terminal_emulator_client(
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_id: &str,
    writer: &SessionWriter,
) {
    let writer_id = Arc::as_ptr(writer) as usize;
    let mut terminal_clients = terminal_emulator_clients.lock().await;
    let Some(client_ids) = terminal_clients.get_mut(session_id) else {
        return;
    };
    client_ids.remove(&writer_id);
    let empty = client_ids.is_empty();
    if empty {
        terminal_clients.remove(session_id);
    }
}

pub(crate) async fn cleanup_client_writer_registries(
    writer: &SessionWriter,
    fanouts: &SessionFanouts,
    terminal_emulator_clients: &TerminalEmulatorClients,
    session_sizes: &SessionSizes,
) -> Vec<(String, u16, u16)> {
    let writer_id = Arc::as_ptr(writer) as usize;

    let mut sizes = session_sizes.lock().await;
    let mut remaining_sizes = Vec::new();
    for (session_id, state) in sizes.iter_mut() {
        if state.viewers.contains_key(&writer_id) || state.legacy_sizes.contains_key(&writer_id) {
            if let Some(size) = state.remove(writer_id) {
                remaining_sizes.push((session_id.clone(), size.0, size.1));
            }
        }
    }
    sizes.retain(|_, state| !state.viewers.is_empty() || !state.legacy_sizes.is_empty());
    drop(sizes);

    let mut terminal_clients = terminal_emulator_clients.lock().await;
    for client_ids in terminal_clients.values_mut() {
        client_ids.remove(&writer_id);
    }
    terminal_clients.retain(|_, client_ids| !client_ids.is_empty());
    drop(terminal_clients);

    let session_fanouts: Vec<Arc<crate::fanout::SessionFanout>> =
        fanouts.lock().await.values().cloned().collect();
    for fanout in session_fanouts {
        fanout
            .state
            .lock()
            .await
            .remove_writer_everywhere(writer_id);
    }

    remaining_sizes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn register(
        state: &mut SessionSizeState,
        writer_id: usize,
        viewer_id: &str,
        role: TerminalViewerRole,
        cols: u16,
        rows: u16,
    ) {
        let resize = state.register(writer_id, viewer_id.to_string(), role, cols, rows, true, 1);
        if let Some(size) = resize {
            state.mark_applied(size);
        }
    }

    #[test]
    fn local_controller_wins_without_minimum_sizing() {
        let mut state = SessionSizeState::new((80, 24));
        register(&mut state, 1, "phone", TerminalViewerRole::Remote, 40, 20);
        register(&mut state, 2, "desktop", TerminalViewerRole::Local, 220, 48);

        assert_eq!(state.controller, Some(2));
        assert_eq!(state.proposed_size(), (220, 48));
        assert_eq!(state.last_applied, (220, 48));
    }

    #[test]
    fn same_class_candidates_are_deterministic_and_followers_do_not_resize() {
        let mut state = SessionSizeState::new((80, 24));
        register(&mut state, 2, "z", TerminalViewerRole::Remote, 200, 40);
        register(&mut state, 1, "a", TerminalViewerRole::Remote, 120, 30);
        // The first eligible same-class viewer remains controller; a later
        // viewer does not compete merely because it proposed a smaller grid.
        assert_eq!(state.controller, Some(2));
        assert_eq!(state.proposed_size(), (200, 40));
        assert_eq!(state.resize(1, 20, 10), None);
        assert_eq!(state.proposed_size(), (200, 40));
    }

    #[test]
    fn takeover_lasts_until_release_then_re_elects_local() {
        let mut state = SessionSizeState::new((80, 24));
        register(&mut state, 1, "desktop", TerminalViewerRole::Local, 220, 48);
        register(&mut state, 2, "phone", TerminalViewerRole::Remote, 40, 20);
        assert_eq!(state.takeover(2), Some((40, 20)));
        state.mark_applied((40, 20));
        assert_eq!(state.resize(1, 240, 50), None);
        assert_eq!(state.release(2), Some((240, 50)));
        assert_eq!(state.controller, Some(1));
    }

    #[test]
    fn no_viewer_retains_last_geometry_and_stale_generation_is_ignored() {
        let mut state = SessionSizeState::new((100, 30));
        register(&mut state, 1, "desktop", TerminalViewerRole::Local, 220, 48);
        assert_eq!(state.remove(1), None);
        assert_eq!(state.proposed_size(), (220, 48));
        register(
            &mut state,
            1,
            "replacement",
            TerminalViewerRole::Local,
            80,
            24,
        );
        assert_eq!(
            state.register(
                1,
                "stale".to_string(),
                TerminalViewerRole::Local,
                40,
                10,
                true,
                0,
            ),
            None
        );
        assert_eq!(state.viewers[&1].viewer_id, "replacement");
    }
}
