use std::sync::Arc;

use tokio::sync::RwLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DaemonLifecycleState {
    Running,
    HandoffCommitted,
}

pub(crate) type DaemonLifecycle = Arc<RwLock<DaemonLifecycleState>>;

pub(crate) fn new_daemon_lifecycle() -> DaemonLifecycle {
    Arc::new(RwLock::new(DaemonLifecycleState::Running))
}
