//! Where a task can be moved, resolved once, in the server.
//!
//! Choosing a transfer destination used to be renderer arithmetic:
//! `desktopTransferMachines.ts` merged the sidecar's LAN peer list with the
//! account's cloud machine list, decided which transport each machine
//! preferred, and handed `pushTaskToPeer` a peer id plus three routing options.
//! Nothing outside a signed-in window could make that choice, so an agent on
//! the CLI or MCP had no way to name a destination at all — it had to read
//! desktop code and post peer ids straight at the transfer API.
//!
//! The same merge lives here now, over the two things this process already
//! owns: the sidecar's peer registry and the cloud transfer proxies it binds.
//! A caller names a machine by its canonical machine (desktop) id or its
//! transfer peer id and gets back the route, so peer ids and relay credentials
//! stay inside the server.
//!
//! What this module deliberately does *not* do is repair a route. The Firebase
//! credential a cloud tunnel dials with belongs to the renderer
//! (`cloud_transfer_proxy`), so a stale one is reported, never refreshed —
//! reporting it before any work is queued is the difference between an
//! actionable error and a transfer that reports `scheduled` and then dies on a
//! relay socket nobody is watching.

use crate::cloud_transfer_proxy::CloudTransferRoute;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Transports a caller may ask for, matching the sidecar's own vocabulary.
pub const TRANSPORTS: [&str; 3] = ["auto", "lan", "cloud"];

/// One machine this one can move a task to or from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTarget {
    pub peer_id: String,
    pub name: String,
    /// The canonical machine (desktop) id, when this peer is a same-account
    /// sibling whose cloud route the desktop has provisioned. A peer trusted
    /// only by LAN pairing has no account-wide identity here, which is why
    /// both spellings address a target.
    pub machine_id: Option<String>,
    pub trusted: bool,
    pub accepting_transfers: bool,
    pub lan_available: bool,
    pub cloud_available: bool,
    /// `lan` whenever a LAN route exists, matching the desktop picker.
    pub preferred_transport: String,
    /// Whether the engine may fall back to the cloud route mid-transfer.
    pub cloud_fallback: bool,
    pub cloud_route: Option<CloudTransferRoute>,
    /// Whether a transfer to this machine can be started right now.
    pub transferable: bool,
    /// Why not, when `transferable` is false.
    pub unavailable_reason: Option<String>,
}

/// The routing a scheduled transfer will actually use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub transport: String,
    pub cloud_fallback: bool,
    pub target_machine_id: Option<String>,
    /// Set when a requested capability was quietly dropped rather than failing
    /// the request — today, a cloud fallback behind a healthy LAN route whose
    /// credential is stale.
    pub note: Option<String>,
}

/// Build the destination list from the sidecar's peer registry and this
/// process's cloud proxies.
///
/// `peers` is the `list-peers` control reply, which is itself already a merge:
/// `task-transfer`'s `list_peers` returns every discovered peer and then
/// appends each registered external peer discovery did not already produce. So
/// an entry is LAN-discovered unless it *is* this machine's own cloud proxy —
/// the loopback endpoint `cloud_transfer_proxy` bound for that peer, which is
/// why the route carries it.
///
/// The discriminator the desktop uses, a non-zero `pid`, is wrong here: `pid`
/// is only populated by the registry discovery used in development, and an
/// mDNS peer on a real LAN carries `pid: 0` exactly like an external one
/// (`task-transfer`'s `resolved_service_to_peer_entry`).
pub fn transfer_targets(
    peers: &[Value],
    cloud_routes: &[CloudTransferRoute],
) -> Vec<TransferTarget> {
    let routes_by_peer = cloud_routes
        .iter()
        .map(|route| (route.peer_id.as_str(), route))
        .collect::<BTreeMap<_, _>>();
    let mut targets = peers
        .iter()
        .filter_map(|peer| {
            let peer_id = string_field(peer, &["peer_id", "peerId"])?;
            let name = string_field(peer, &["display_name", "displayName"])
                .unwrap_or_else(|| peer_id.clone());
            let cloud_route = routes_by_peer
                .get(peer_id.as_str())
                .map(|route| (*route).clone());
            let endpoint = string_field(peer, &["endpoint"]);
            let lan_available = match (&cloud_route, &endpoint) {
                (Some(route), Some(endpoint)) => route.endpoint != *endpoint,
                _ => true,
            };
            Some(build_target(
                peer_id,
                name,
                bool_field(peer, &["trusted"]).unwrap_or(false),
                bool_field(peer, &["accepting_transfers", "acceptingTransfers"]).unwrap_or(false),
                lan_available,
                cloud_route,
            ))
        })
        .collect::<Vec<_>>();
    targets.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.peer_id.cmp(&right.peer_id))
    });
    targets
}

fn build_target(
    peer_id: String,
    name: String,
    trusted: bool,
    accepting_transfers: bool,
    lan_available: bool,
    cloud_route: Option<CloudTransferRoute>,
) -> TransferTarget {
    let cloud_available = cloud_route.is_some();
    let cloud_usable = cloud_route.as_ref().is_some_and(CloudTransferRoute::ready);
    let preferred_transport = if lan_available { "lan" } else { "cloud" }.to_string();
    let unavailable_reason = if !trusted {
        Some(format!(
            "machine {name} is not a trusted transfer peer; pair it in the desktop app, or sign \
             both machines into the same account so its cloud route is provisioned"
        ))
    } else if !accepting_transfers {
        Some(format!("machine {name} is not accepting transfers"))
    } else if !lan_available && !cloud_usable {
        // The only way to lose the LAN route is to *be* this machine's cloud
        // proxy, so an unreachable peer always has a cloud route to report on.
        Some(cloud_route_problem(&name, cloud_route.as_ref()))
    } else {
        None
    };
    TransferTarget {
        peer_id,
        name,
        machine_id: cloud_route.as_ref().map(|route| route.machine_id.clone()),
        trusted,
        accepting_transfers,
        lan_available,
        cloud_available,
        preferred_transport,
        cloud_fallback: lan_available && cloud_usable,
        cloud_route,
        transferable: unavailable_reason.is_none(),
        unavailable_reason,
    }
}

fn cloud_route_problem(name: &str, cloud_route: Option<&CloudTransferRoute>) -> String {
    let detail = cloud_route
        .and_then(|route| route.detail.clone())
        .unwrap_or_else(|| "no cloud route is provisioned for it".to_string());
    format!(
        "machine {name} can only be reached through the cloud right now, and that route is not \
         usable: {detail}. Open the signed-in Kanna desktop app on this machine so it refreshes \
         the route, or move the task while both machines are on the same network."
    )
}

/// Find the machine a caller named.
///
/// A selector is a canonical machine (desktop) id or a transfer peer id.
/// Nothing else: a display name is not identity, and resolving one would make
/// "which machine did this go to?" depend on what somebody called their laptop.
pub fn resolve_transfer_target<'a>(
    targets: &'a [TransferTarget],
    selector: &str,
) -> Result<&'a TransferTarget, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("machine selector must not be empty".to_string());
    }
    if let Some(target) = targets.iter().find(|target| target.peer_id == selector) {
        return Ok(target);
    }
    let by_machine = targets
        .iter()
        .filter(|target| target.machine_id.as_deref() == Some(selector))
        .collect::<Vec<_>>();
    match by_machine.as_slice() {
        [target] => Ok(target),
        [] => Err(format!(
            "no transfer peer matches machine {selector}. Known transfer peers: {}",
            render_candidates(targets)
        )),
        _ => Err(format!(
            "machine {selector} matches more than one transfer peer ({}); name the peer id instead",
            by_machine
                .iter()
                .map(|target| target.peer_id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn render_candidates(targets: &[TransferTarget]) -> String {
    if targets.is_empty() {
        return "none are reachable from this machine".to_string();
    }
    targets
        .iter()
        .map(|target| match &target.machine_id {
            Some(machine_id) => {
                format!("{} (machine {machine_id}, {})", target.peer_id, target.name)
            }
            None => format!("{} ({}, LAN-paired only)", target.peer_id, target.name),
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Decide how a transfer to this machine will travel, refusing before any work
/// is queued when the requested route cannot carry it.
///
/// `requested` is the caller's `transport` argument: `auto` (or absent) takes
/// the machine's preferred route, which is LAN whenever one exists.
pub fn plan_route(target: &TransferTarget, requested: Option<&str>) -> Result<RoutePlan, String> {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    if let Some(requested) = requested {
        if !TRANSPORTS.contains(&requested) {
            return Err(format!(
                "unsupported transfer transport {requested}; use one of {}",
                TRANSPORTS.join(", ")
            ));
        }
    }
    if !target.trusted {
        return Err(target
            .unavailable_reason
            .clone()
            .unwrap_or_else(|| format!("machine {} is not a trusted transfer peer", target.name)));
    }
    if !target.accepting_transfers {
        return Err(format!(
            "machine {} is not accepting transfers",
            target.name
        ));
    }
    let transport = match requested {
        None | Some("auto") => target.preferred_transport.clone(),
        Some(explicit) => explicit.to_string(),
    };
    match transport.as_str() {
        "lan" if !target.lan_available => Err(format!(
            "machine {} is not reachable on this LAN right now{}",
            target.name,
            if target.cloud_available {
                "; retry with transport \"cloud\", or omit transport to take the route this \
                 machine prefers"
            } else {
                ""
            }
        )),
        "cloud" if !target.cloud_available => Err(format!(
            "no cloud transfer route is provisioned for machine {}. That route is bound by the \
             signed-in desktop app, not by this API, so open Kanna on this machine while signed \
             in — or use transport \"lan\" while both machines share a network.",
            target.name
        )),
        "cloud"
            if !target
                .cloud_route
                .as_ref()
                .is_some_and(CloudTransferRoute::ready) =>
        {
            Err(cloud_route_problem(
                &target.name,
                target.cloud_route.as_ref(),
            ))
        }
        _ => Ok(RoutePlan {
            note: lan_note(target, &transport),
            transport,
            cloud_fallback: target.cloud_fallback,
            target_machine_id: target.machine_id.clone(),
        }),
    }
}

/// A LAN transfer whose cloud fallback is unusable still runs; it just has no
/// second route to fall back to. Saying so is better than failing a transfer
/// the LAN can carry, and better than a silent downgrade.
fn lan_note(target: &TransferTarget, transport: &str) -> Option<String> {
    if transport != "lan" || !target.cloud_available || target.cloud_fallback {
        return None;
    }
    Some(format!(
        "this transfer has no cloud fallback: {}",
        target
            .cloud_route
            .as_ref()
            .and_then(|route| route.detail.clone())
            .unwrap_or_else(|| "the cloud route for this machine is not usable".to_string())
    ))
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn bool_field(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_bool))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Where this machine's own proxy for that peer listens. A merged peer
    /// entry pointing here came from the external registry, not from LAN
    /// discovery.
    fn proxy_endpoint(peer_id: &str) -> String {
        format!("127.0.0.1:4{:03}", peer_id.len())
    }

    fn route(peer_id: &str, machine_id: &str, status: &str) -> CloudTransferRoute {
        CloudTransferRoute {
            peer_id: peer_id.to_string(),
            endpoint: proxy_endpoint(peer_id),
            machine_id: machine_id.to_string(),
            status: status.to_string(),
            credential_expires_at: None,
            detail: (status != "ready").then(|| format!("cloud route is {status}")),
        }
    }

    /// A peer as `list-peers` returns it.
    ///
    /// `pid` is deliberately 0 on the LAN peers here: that is what a real mDNS
    /// peer carries, and a discriminator that keyed on it would call every
    /// production LAN peer cloud-only.
    fn peer(peer_id: &str, name: &str, endpoint: &str, trusted: bool) -> Value {
        json!({
            "peer_id": peer_id,
            "display_name": name,
            "endpoint": endpoint,
            "pid": 0,
            "public_key": "key",
            "protocol_version": 1,
            "accepting_transfers": true,
            "trusted": trusted,
        })
    }

    /// A LAN-discovered peer: some address that is not this machine's proxy.
    fn lan_peer(peer_id: &str, name: &str, trusted: bool) -> Value {
        peer(peer_id, name, "192.168.1.24:4455", trusted)
    }

    /// A peer that exists only as this machine's cloud proxy, which is how
    /// `list_peers` renders a registered external peer discovery never saw.
    fn cloud_peer(peer_id: &str, name: &str) -> Value {
        peer(peer_id, name, &proxy_endpoint(peer_id), true)
    }

    /// The renderer's merge, restated: a peer discovered on the LAN prefers
    /// LAN, a same-account sibling reachable both ways prefers LAN and keeps
    /// the cloud as a fallback, and a cloud-only sibling carries the machine
    /// id that makes it addressable without a peer id at all.
    #[test]
    fn targets_merge_lan_discovery_with_provisioned_cloud_routes() {
        let targets = transfer_targets(
            &[
                lan_peer("peer-lan", "Laptop", true),
                lan_peer("peer-both", "Studio", true),
                cloud_peer("peer-cloud", "Mini"),
            ],
            &[
                route("peer-both", "desktop-studio", "ready"),
                route("peer-cloud", "desktop-mini", "ready"),
            ],
        );
        let by_peer = |peer_id: &str| {
            targets
                .iter()
                .find(|target| target.peer_id == peer_id)
                .expect("target")
                .clone()
        };

        let lan = by_peer("peer-lan");
        assert_eq!(lan.machine_id, None);
        assert_eq!(lan.preferred_transport, "lan");
        assert!(!lan.cloud_fallback);
        assert!(lan.transferable);

        let both = by_peer("peer-both");
        assert_eq!(both.machine_id.as_deref(), Some("desktop-studio"));
        assert_eq!(both.preferred_transport, "lan");
        assert!(both.cloud_fallback);

        let cloud = by_peer("peer-cloud");
        assert_eq!(cloud.machine_id.as_deref(), Some("desktop-mini"));
        assert_eq!(cloud.preferred_transport, "cloud");
        assert!(!cloud.lan_available);
        assert!(cloud.transferable);
    }

    /// The trap under the obvious implementation.
    ///
    /// `pid` looks like the LAN/cloud discriminator — the desktop's own peer
    /// parsing keys on it — but only the registry discovery used in development
    /// fills it in. Every peer on a real mDNS LAN carries `pid: 0`, exactly
    /// like a registered cloud peer, so a `pid`-based rule would report every
    /// production LAN machine as cloud-only: LAN transfers would be refused,
    /// and every move would be pushed at the relay instead.
    #[test]
    fn a_real_mdns_peer_is_lan_reachable_even_though_it_carries_no_pid() {
        let targets = transfer_targets(&[lan_peer("peer-mdns", "Laptop", true)], &[]);
        assert_eq!(targets[0].peer_id, "peer-mdns");
        assert!(targets[0].lan_available, "{:?}", targets[0]);
        assert_eq!(targets[0].preferred_transport, "lan");
        assert!(targets[0].transferable);

        // …and the same peer, once this machine has also provisioned a cloud
        // route for it, keeps its LAN route and gains the fallback. The entry
        // still names the LAN endpoint, because that is the half `list_peers`
        // prefers when a peer is both.
        let targets = transfer_targets(
            &[lan_peer("peer-mdns", "Laptop", true)],
            &[route("peer-mdns", "desktop-laptop", "ready")],
        );
        assert!(targets[0].lan_available);
        assert!(targets[0].cloud_available);
        assert!(targets[0].cloud_fallback);
        assert_eq!(targets[0].machine_id.as_deref(), Some("desktop-laptop"));
    }

    #[test]
    fn an_untrusted_or_unreachable_peer_says_what_would_make_it_reachable() {
        let targets = transfer_targets(
            &[
                lan_peer("peer-untrusted", "Stranger", false),
                // Reachable only through a cloud route this machine has bound
                // but whose credential is spent. That is the one way a trusted,
                // listed peer can be unreachable: losing the LAN route means
                // *being* this machine's own proxy, which always has a route to
                // report on.
                cloud_peer("peer-stale", "Mini"),
            ],
            &[route("peer-stale", "desktop-mini", "proxy_stopped")],
        );
        let untrusted = &targets[1];
        assert_eq!(untrusted.peer_id, "peer-untrusted");
        assert!(!untrusted.transferable);
        assert!(
            untrusted
                .unavailable_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("pair it")),
            "{untrusted:?}"
        );

        let stale = &targets[0];
        assert_eq!(stale.peer_id, "peer-stale");
        assert!(!stale.lan_available);
        assert!(!stale.transferable);
        assert!(
            stale
                .unavailable_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("proxy_stopped")),
            "{stale:?}"
        );
    }

    /// The failure this surface exists to stop repeating: a cloud-only machine
    /// whose credential the renderer last refreshed an hour ago accepted the
    /// intent, answered `scheduled: true`, and then failed inside the engine on
    /// a relay socket with `expected auth_ok text frame`. The refusal has to
    /// happen here, before anything is queued, and it has to name the thing a
    /// person can actually do.
    #[test]
    fn a_stale_cloud_credential_refuses_the_route_instead_of_scheduling_it() {
        let targets = transfer_targets(
            &[cloud_peer("peer-cloud", "Mini")],
            &[route("peer-cloud", "desktop-mini", "credential_expired")],
        );
        let target = &targets[0];
        assert!(!target.transferable);

        let error = plan_route(target, Some("cloud")).expect_err("a stale route cannot carry work");
        assert!(error.contains("credential_expired"), "{error}");
        assert!(error.contains("signed-in Kanna desktop app"), "{error}");

        let error = plan_route(target, None).expect_err("auto must not paper over it either");
        assert!(error.contains("credential_expired"), "{error}");
    }

    /// …but the same stale credential must not fail a transfer the LAN can
    /// carry. It costs the fallback, and the caller is told so.
    #[test]
    fn a_stale_cloud_credential_only_costs_the_fallback_when_lan_works() {
        let targets = transfer_targets(
            &[lan_peer("peer-both", "Studio", true)],
            &[route("peer-both", "desktop-studio", "credential_expired")],
        );
        let target = &targets[0];
        assert!(target.transferable);

        let plan = plan_route(target, None).expect("LAN still carries it");
        assert_eq!(plan.transport, "lan");
        assert!(!plan.cloud_fallback);
        assert_eq!(plan.target_machine_id.as_deref(), Some("desktop-studio"));
        assert!(
            plan.note
                .as_deref()
                .is_some_and(|note| note.contains("no cloud fallback")),
            "{plan:?}"
        );
    }

    #[test]
    fn a_target_resolves_by_peer_id_or_machine_id_and_says_what_exists_otherwise() {
        let targets = transfer_targets(
            &[
                lan_peer("peer-both", "Studio", true),
                lan_peer("peer-lan", "Laptop", true),
            ],
            &[route("peer-both", "desktop-studio", "ready")],
        );

        assert_eq!(
            resolve_transfer_target(&targets, "peer-lan")
                .expect("by peer id")
                .name,
            "Laptop"
        );
        assert_eq!(
            resolve_transfer_target(&targets, "desktop-studio")
                .expect("by machine id")
                .peer_id,
            "peer-both"
        );

        let error = resolve_transfer_target(&targets, "desktop-unknown").expect_err("unknown");
        assert!(
            error.contains("peer-both (machine desktop-studio, Studio)"),
            "{error}"
        );
        assert!(
            error.contains("peer-lan (Laptop, LAN-paired only)"),
            "{error}"
        );
    }

    #[test]
    fn an_explicit_transport_the_machine_cannot_take_is_refused_with_the_alternative() {
        let targets = transfer_targets(
            &[cloud_peer("peer-cloud", "Mini")],
            &[route("peer-cloud", "desktop-mini", "ready")],
        );
        let error = plan_route(&targets[0], Some("lan")).expect_err("no LAN route");
        assert!(error.contains("not reachable on this LAN"), "{error}");
        assert!(error.contains("transport \"cloud\""), "{error}");

        let error = plan_route(&targets[0], Some("carrier-pigeon")).expect_err("unknown transport");
        assert!(error.contains("unsupported transfer transport"), "{error}");
    }

    #[test]
    fn a_lan_only_machine_asked_for_cloud_names_who_owns_that_route() {
        let targets = transfer_targets(&[lan_peer("peer-lan", "Laptop", true)], &[]);
        let error = plan_route(&targets[0], Some("cloud")).expect_err("no cloud route");
        assert!(
            error.contains("is provisioned for machine Laptop"),
            "{error}"
        );
        assert!(error.contains("not by this API"), "{error}");
    }
}
