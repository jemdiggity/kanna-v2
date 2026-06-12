use crate::config::Config;
use crate::db::Db;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDescriptor {
    pub id: String,
    pub name: String,
    pub connection_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobileServerStatus {
    pub state: String,
    pub desktop_id: String,
    pub desktop_name: String,
    pub server_version: Option<String>,
    pub lan_host: String,
    pub lan_port: u16,
    pub pairing_code: Option<String>,
}

pub struct MobileApi {
    config: Config,
    _db: Db,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: Option<String>,
    pub snippet: Option<String>,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub repo_id: String,
    pub prompt: String,
    pub pipeline_name: Option<String>,
    pub base_ref: Option<String>,
    pub stage: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskResponse {
    pub task_id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: String,
    pub agent_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteStageRequest {
    pub status: String,
    pub summary: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestRevisionRequest {
    pub target_stage: String,
    pub summary: String,
    pub prompt: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskActionResponse {
    pub task_id: String,
}

impl MobileApi {
    pub fn new(config: Config, db: Db) -> Self {
        Self { config, _db: db }
    }

    pub fn list_desktops(&self) -> Result<Vec<DesktopDescriptor>, String> {
        Ok(vec![DesktopDescriptor {
            id: self.config.desktop_id.clone(),
            name: self.config.desktop_name.clone(),
            connection_mode: "local".to_string(),
        }])
    }

    pub fn list_repos(&self) -> Result<Vec<RepoSummary>, String> {
        self._db
            .list_repos()
            .map(|repos| repos.into_iter().map(map_repo_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn list_repo_tasks(&self, repo_id: &str) -> Result<Vec<TaskSummary>, String> {
        self._db
            .list_pipeline_items(repo_id)
            .map(|items| items.into_iter().map(map_task_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn list_recent_tasks(&self) -> Result<Vec<TaskSummary>, String> {
        self._db
            .list_recent_pipeline_items()
            .map(|items| items.into_iter().map(map_task_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn search_tasks(&self, query: &str) -> Result<Vec<TaskSummary>, String> {
        self._db
            .search_pipeline_items(query)
            .map(|items| items.into_iter().map(map_task_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }
}

fn map_task_summary(item: crate::db::PipelineItem) -> TaskSummary {
    let title = item
        .display_name
        .clone()
        .or(item.prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    TaskSummary {
        id: item.id,
        repo_id: item.repo_id,
        title,
        stage: item.stage,
        snippet: item.last_output_preview,
        agent_type: item.agent_type,
    }
}

fn map_repo_summary(repo: crate::db::Repo) -> RepoSummary {
    RepoSummary {
        id: repo.id,
        name: repo.name,
    }
}

pub fn build_mobile_server_status(
    config: &Config,
    pairing_code: Option<String>,
) -> MobileServerStatus {
    MobileServerStatus {
        state: "running".to_string(),
        desktop_id: config.desktop_id.clone(),
        desktop_name: config.desktop_name.clone(),
        server_version: config.server_version.clone(),
        lan_host: config.lan_host.clone(),
        lan_port: config.lan_port,
        pairing_code,
    }
}

#[cfg(test)]
mod tests {
    use super::CreateTaskRequest;
    use crate::config::Config;
    use crate::db::Db;
    use serde_json::json;

    #[test]
    fn create_task_request_uses_agent_type_camel_case() {
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "repoId": "repo-1",
            "prompt": "Build the view",
            "agentProvider": "claude",
            "agentType": "agent"
        }))
        .unwrap();

        assert_eq!(request.agent_type.as_deref(), Some("agent"));
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "repoId": "repo-1",
                "prompt": "Build the view",
                "pipelineName": null,
                "baseRef": null,
                "stage": null,
                "agentProvider": "claude",
                "agentType": "agent",
                "model": null,
                "permissionMode": null,
                "allowedTools": null
            })
        );
    }

    #[test]
    fn list_desktops_returns_configured_descriptor() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("desktop-list"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        let api = super::MobileApi::new(config, db);
        let desktops = api.list_desktops().unwrap();

        assert_eq!(desktops.len(), 1);
        assert_eq!(desktops[0].id, "desktop-1");
        assert_eq!(desktops[0].name, "Studio Mac");
        assert_eq!(desktops[0].connection_mode, "local");
    }

    #[test]
    fn list_repos_returns_repo_summaries() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("repo-summaries"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();

        let api = super::MobileApi::new(config, db);
        let repos = api.list_repos().unwrap();

        assert_eq!(
            repos,
            vec![
                super::RepoSummary {
                    id: "repo-1".to_string(),
                    name: "Repo One".to_string(),
                },
                super::RepoSummary {
                    id: "repo-2".to_string(),
                    name: "Repo Two".to_string(),
                },
            ]
        );
    }

    #[test]
    fn list_recent_tasks_returns_open_tasks_in_updated_order() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("recent-tasks"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-older",
            "repo-1",
            "older prompt",
            Some("Older Task"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-newer",
            "repo-1",
            "newer prompt",
            Some("Newer Task"),
            "pr",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "done prompt",
            Some("Done Task"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_recent_tasks().unwrap();

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "task-newer");
        assert_eq!(tasks[1].id, "task-older");
    }

    #[test]
    fn list_repo_tasks_returns_only_requested_repo_tasks() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("repo-tasks"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_repo("repo-2", "Repo Two").unwrap();
        db.insert_test_pipeline_item(
            "task-repo-1",
            "repo-1",
            "repo one prompt",
            Some("Repo One Task"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-repo-2",
            "repo-2",
            "repo two prompt",
            Some("Repo Two Task"),
            "pr",
            "2026-04-17 08:00:00",
        )
        .unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_repo_tasks("repo-1").unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-repo-1");
        assert_eq!(tasks[0].repo_id, "repo-1");
    }

    #[test]
    fn list_recent_tasks_includes_last_output_preview() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("recent-task-snippet"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-preview",
            "repo-1",
            "review mobile shell",
            Some("Review Shell"),
            "pr",
            "2026-04-17 09:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_preview("task-preview", Some("Latest agent output preview"))
            .unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.list_recent_tasks().unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(
            tasks[0].snippet.as_deref(),
            Some("Latest agent output preview")
        );
    }

    #[test]
    fn search_tasks_matches_display_name_or_prompt_and_excludes_closed_tasks() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("search-tasks"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let db = Db::open_for_tests(&config.db_path).unwrap();
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-merge",
            "repo-1",
            "follow up on merge conflicts",
            Some("Merge Cleanup"),
            "in progress",
            "2026-04-17 07:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-other",
            "repo-1",
            "write release notes",
            Some("Docs"),
            "in progress",
            "2026-04-17 06:00:00",
        )
        .unwrap();
        db.insert_test_pipeline_item(
            "task-done",
            "repo-1",
            "merge old branch",
            Some("Done Merge"),
            "done",
            "2026-04-17 08:00:00",
        )
        .unwrap();
        db.close_pipeline_item("task-done").unwrap();

        let api = super::MobileApi::new(config, db);
        let tasks = api.search_tasks("merge").unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-merge");
        assert_eq!(tasks[0].title, "Merge Cleanup");
    }

    #[test]
    fn status_reflects_desktop_identity_and_pairing_code() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            cloud_base_url: "http://127.0.0.1:5001/kanna-local/us-central1".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: Some("http://127.0.0.1:9099".to_string()),
            firebase_firestore_emulator_host: Some("127.0.0.1:8080".to_string()),
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("status"),
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };

        let _db = Db::open_for_tests(&config.db_path).unwrap();
        let status = super::build_mobile_server_status(&config, Some("ABC123".to_string()));

        assert_eq!(status.state, "running");
        assert_eq!(status.desktop_id, "desktop-1");
        assert_eq!(status.desktop_name, "Studio Mac");
        assert_eq!(status.server_version.as_deref(), Some("test-version"));
        assert_eq!(status.pairing_code.as_deref(), Some("ABC123"));
    }
}
