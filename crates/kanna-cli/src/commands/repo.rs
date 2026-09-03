use std::process;

use crate::api::{
    add_repo_via_api, list_repo_agents_via_api, list_repos_via_api,
    reconcile_repo_metadata_via_api, signal_agent_via_api,
};
use crate::commands::print_json;
use crate::config::resolve_server_base_url_from_env;
use crate::models::{AddRepoRequest, ReconcileRepoMetadataRequest, SignalAgentRequest};
use crate::{RepoAgentCommands, RepoCommands};

pub(crate) fn build_add_repo_request(path: String, name: Option<String>) -> AddRepoRequest {
    AddRepoRequest { path, name }
}

pub(crate) fn build_reconcile_repo_metadata_request(apply: bool) -> ReconcileRepoMetadataRequest {
    ReconcileRepoMetadataRequest { apply }
}

pub(crate) fn build_signal_agent_request(
    message: String,
    agent_provider: Option<String>,
    effort: Option<String>,
) -> SignalAgentRequest {
    SignalAgentRequest {
        message,
        agent_provider,
        effort,
    }
}

pub(crate) async fn run(command: RepoCommands) {
    match command {
        RepoCommands::List { server_url } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let repos = list_repos_via_api(&base_url).await.unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            if let Err(e) = print_json(&repos) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        RepoCommands::Add {
            path,
            name,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_add_repo_request(path, name);
            let repo = add_repo_via_api(&base_url, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&repo) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        RepoCommands::ReconcileMetadata {
            repo_id,
            apply,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_reconcile_repo_metadata_request(apply);
            let response = reconcile_repo_metadata_via_api(&base_url, &repo_id, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&response) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        RepoCommands::Agent { command } => match command {
            RepoAgentCommands::List {
                repo_id,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let agents = list_repo_agents_via_api(&base_url, &repo_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&agents) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
            RepoAgentCommands::Signal {
                repo_id,
                agent,
                message,
                agent_provider,
                effort,
                server_url,
            } => {
                let base_url = resolve_server_base_url_from_env(server_url.as_deref());
                let request = build_signal_agent_request(message, agent_provider, effort);
                let response = signal_agent_via_api(&base_url, &repo_id, &agent, &request)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                if let Err(e) = print_json(&response) {
                    eprintln!("Error: {e}");
                    process::exit(1);
                }
            }
        },
    }
}
