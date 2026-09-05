use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// mDNS service instance names are visible to the whole host and LAN, not just
/// this process. Fixed names collide with concurrent runs of this suite in
/// other worktrees (or other machines on the same network), making discovery
/// resolve a foreign process's endpoint and pairing requests park there until
/// PeerRequestTimeout. Every spawned test peer gets a per-spawn unique id.
pub fn unique_mdns_peer_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!(
        "{prefix}-{}-{nanos:x}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
