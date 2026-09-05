use super::events::RuntimeError;
use super::utils::CURRENT_PROTOCOL_VERSION;
use crate::discovery::{
    encode_txt_record, hostname_for_peer, resolved_service_to_peer_entry, SERVICE_TYPE,
};
use crate::protocol::PeerRegistryEntry;
use crate::registry::PeerRegistry;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Clone)]
pub(super) enum PeerDiscovery {
    Registry(PeerRegistry),
    Mdns(Arc<MdnsDiscovery>),
    #[cfg(test)]
    MdnsFixture(Arc<Mutex<MdnsState>>),
}

#[derive(Debug, Default)]
pub(super) struct MdnsState {
    peers_by_id: HashMap<String, PeerRegistryEntry>,
    peer_ids_by_fullname: HashMap<String, String>,
}

pub(super) struct MdnsDiscovery {
    daemon: ServiceDaemon,
    state: Arc<Mutex<MdnsState>>,
    browse_task: JoinHandle<()>,
    service_fullname: String,
}

impl PeerDiscovery {
    pub(super) async fn list_peers(
        &self,
        self_peer_id: &str,
    ) -> Result<Vec<PeerRegistryEntry>, RuntimeError> {
        match self {
            Self::Registry(registry) => Ok(registry.list_peers(self_peer_id)?),
            Self::Mdns(discovery) => discovery.list_peers(self_peer_id).await,
            #[cfg(test)]
            Self::MdnsFixture(state) => Ok(state.lock().await.list_peers(self_peer_id)),
        }
    }

    pub(super) fn shutdown(&self) {
        if let Self::Mdns(discovery) = self {
            discovery.shutdown();
        }
    }
}

impl MdnsDiscovery {
    pub(super) async fn spawn(
        peer_id: &str,
        display_name: &str,
        public_key: &str,
        listen_port: u16,
    ) -> Result<Self, RuntimeError> {
        let daemon =
            ServiceDaemon::new().map_err(|error| RuntimeError::Discovery(error.to_string()))?;
        let txt = encode_txt_record(
            peer_id,
            display_name,
            public_key,
            CURRENT_PROTOCOL_VERSION,
            true,
        )
        .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;
        let properties = txt
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        let hostname = hostname_for_peer(peer_id)
            .map_err(|error| RuntimeError::InvalidConfig(error.to_string()))?;
        let service_info = ServiceInfo::new(
            SERVICE_TYPE,
            peer_id,
            &hostname,
            "",
            listen_port,
            &properties[..],
        )
        .map_err(|error| RuntimeError::Discovery(error.to_string()))?
        .enable_addr_auto();
        let service_fullname = service_info.get_fullname().to_string();
        daemon
            .register(service_info)
            .map_err(|error| RuntimeError::Discovery(error.to_string()))?;

        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|error| RuntimeError::Discovery(error.to_string()))?;
        let state = Arc::new(Mutex::new(MdnsState::default()));
        let browse_state = Arc::clone(&state);
        let browse_task = tokio::spawn(async move {
            while let Ok(event) = receiver.recv_async().await {
                handle_mdns_event(&browse_state, event).await;
            }
        });

        Ok(Self {
            daemon,
            state,
            browse_task,
            service_fullname,
        })
    }

    async fn list_peers(&self, self_peer_id: &str) -> Result<Vec<PeerRegistryEntry>, RuntimeError> {
        let state = self.state.lock().await;
        Ok(state.list_peers(self_peer_id))
    }

    fn shutdown(&self) {
        self.browse_task.abort();
        let _ = self.daemon.unregister(&self.service_fullname);
        let _ = self.daemon.shutdown();
    }
}

impl MdnsState {
    fn list_peers(&self, self_peer_id: &str) -> Vec<PeerRegistryEntry> {
        let mut peers = self
            .peers_by_id
            .values()
            .filter(|peer| peer.peer_id != self_peer_id)
            .cloned()
            .collect::<Vec<_>>();
        peers.sort_by(|left, right| left.peer_id.cmp(&right.peer_id));
        peers
    }
}

pub(super) async fn handle_mdns_event(state: &Arc<Mutex<MdnsState>>, event: ServiceEvent) {
    match event {
        ServiceEvent::ServiceResolved(service) => {
            let peer = match resolved_service_to_peer_entry(&service) {
                Ok(peer) => peer,
                Err(_) => return,
            };

            let mut state = state.lock().await;
            if let Some(previous_peer_id) = state
                .peer_ids_by_fullname
                .insert(service.get_fullname().to_owned(), peer.peer_id.clone())
            {
                state.peers_by_id.remove(&previous_peer_id);
            }
            state.peers_by_id.insert(peer.peer_id.clone(), peer);
        }
        ServiceEvent::ServiceRemoved(_, fullname) => {
            let mut state = state.lock().await;
            if let Some(peer_id) = state.peer_ids_by_fullname.remove(&fullname) {
                state.peers_by_id.remove(&peer_id);
            }
        }
        _ => {}
    }
}
