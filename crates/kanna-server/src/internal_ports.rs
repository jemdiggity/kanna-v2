use std::collections::HashSet;

/// Marks the ports an installed Kanna binds for itself as occupied before a
/// task's ports are handed out.
///
/// Without this, a repo whose `.kanna/config.json` declares a base port just
/// below one of ours walks straight into it — the allocator searches upward
/// from `preferred + 1` and only knows about ports other *tasks* hold. The
/// collision is then decided by start order: a project's dev server takes the
/// port while Kanna is down, or Kanna takes it first and the task's server
/// fails to bind. Both directions are silent.
///
/// The set is deliberately limited to installed listeners
/// (`RESERVED_INTERNAL_PORTS`); development instances derive their ports from
/// `kd` and vary per worktree, so a fixed list cannot describe them.
pub(crate) fn reserve_internal_ports(occupied: &mut HashSet<i64>) {
    for port in kanna_runtime_defaults::RESERVED_INTERNAL_PORTS {
        occupied.insert(i64::from(port));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_every_installed_listener() {
        let mut occupied = HashSet::new();
        reserve_internal_ports(&mut occupied);

        assert!(occupied.contains(&i64::from(
            kanna_runtime_defaults::PRODUCTION_MOBILE_SERVER_PORT
        )));
        assert!(occupied.contains(&i64::from(
            kanna_runtime_defaults::STAGING_MOBILE_SERVER_PORT
        )));
        assert!(occupied.contains(&i64::from(kanna_runtime_defaults::DEFAULT_TRANSFER_PORT)));
        assert!(occupied.contains(&i64::from(kanna_runtime_defaults::STAGING_TRANSFER_PORT)));
    }

    #[test]
    fn keeps_ports_a_caller_already_marked() {
        let mut occupied = HashSet::from([9_999]);
        reserve_internal_ports(&mut occupied);

        assert!(occupied.contains(&9_999));
    }
}
