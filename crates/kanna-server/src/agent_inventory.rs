//! Which agent provider CLIs this machine can actually run.
//!
//! Kanna supports a fixed set of providers, but a given Mac usually has only
//! some of them installed. Anything that offers a provider *choice* to a remote
//! client — mobile's create-task composer above all — has to know the
//! difference: a task created for a provider whose executable does not resolve
//! here is accepted, gets a worktree and a branch, and then never connects,
//! because the spawn wraps a command that does not exist.
//!
//! The answer has to come from the same resolution a spawn uses
//! (`task_creator::resolve_agent_executable`): process PATH, then the cached
//! login-shell PATH, then live user install locations. A Finder-launched Kanna
//! inherits the launchd PATH, which contains none of the places these CLIs live,
//! so a naive `PATH` check would report an empty machine on exactly the install
//! this exists to serve.
use kanna_agent_protocol::AgentProvider;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The inventory rides on payloads that are polled (`/v1/status`) or rebuilt on
/// a timer (the cloud task snapshot), so it is memoized. The window is short
/// enough that installing a CLI shows up on the phone without restarting the
/// desktop, and long enough that a polling client does not re-stat the PATH on
/// every request.
const INVENTORY_TTL: Duration = Duration::from_secs(30);

static CACHED_INVENTORY: Mutex<Option<(Instant, Vec<AgentProvider>)>> = Mutex::new(None);

/// Providers whose executable resolves on this machine, in the registry's
/// canonical order.
pub(crate) fn installed_agent_providers() -> Vec<AgentProvider> {
    let now = Instant::now();
    let mut cache = match CACHED_INVENTORY.lock() {
        Ok(cache) => cache,
        // A poisoned lock means a previous scan panicked; an inventory is
        // advisory, so recover rather than take the process down with it.
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some((scanned_at, providers)) = cache.as_ref() {
        if now.duration_since(*scanned_at) < INVENTORY_TTL {
            return providers.clone();
        }
    }
    let providers = scan_installed_agent_providers(|provider| {
        crate::task_creator::resolve_agent_executable(provider).is_ok()
    });
    *cache = Some((now, providers.clone()));
    providers
}

fn scan_installed_agent_providers(
    mut is_installed: impl FnMut(AgentProvider) -> bool,
) -> Vec<AgentProvider> {
    AgentProvider::ALL
        .into_iter()
        .filter(|provider| is_installed(*provider))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{installed_agent_providers, scan_installed_agent_providers};
    use kanna_agent_protocol::AgentProvider;

    #[test]
    fn scan_keeps_registry_order_and_drops_missing_providers() {
        let providers = scan_installed_agent_providers(|provider| {
            matches!(provider, AgentProvider::Opencode | AgentProvider::Claude)
        });
        assert_eq!(
            providers,
            vec![AgentProvider::Claude, AgentProvider::Opencode]
        );
    }

    #[test]
    fn scan_reports_an_empty_inventory_when_nothing_resolves() {
        assert!(scan_installed_agent_providers(|_| false).is_empty());
    }

    #[test]
    fn cached_inventory_is_a_subset_of_the_registry() {
        for provider in installed_agent_providers() {
            assert!(AgentProvider::ALL.contains(&provider));
        }
    }
}
