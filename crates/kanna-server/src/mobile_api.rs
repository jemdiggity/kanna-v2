use crate::config::Config;
use crate::db::{Db, NewRepo, NewStageRun};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
pub struct RepoDetail {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub hidden: Option<i64>,
    pub sort_order: Option<i64>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
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
    pub activity: Option<String>,
    pub snippet: Option<String>,
    pub waiting_prompt_snippet: Option<String>,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: Option<String>,
    pub pipeline_name: Option<String>,
    pub stage_transition: Option<String>,
    pub activity: Option<String>,
    pub snippet: Option<String>,
    pub waiting_prompt_snippet: Option<String>,
    pub agent_type: Option<String>,
    pub agent_provider: Option<String>,
    pub branch: Option<String>,
    pub pr_url: Option<String>,
    pub closed_at: Option<String>,
    pub worktree_path: Option<String>,
    pub commits_ahead: i64,
    pub commits_behind: i64,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddRepoRequest {
    pub path: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub repo_id: String,
    pub prompt: String,
    #[serde(alias = "display_name")]
    pub display_name: Option<String>,
    pub pipeline_name: Option<String>,
    pub stage: Option<String>,
    pub base_ref: Option<String>,
    pub agent: Option<String>,
    pub agent_provider: Option<String>,
    pub agent_type: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub disallowed_tools: Option<Vec<String>>,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub setup_cmds: Option<Vec<String>>,
    pub resume_session_id: Option<String>,
    pub blocker_task_ids: Option<Vec<String>>,
    pub notify_task_id: Option<String>,
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskResponse {
    pub task_id: String,
    pub repo_id: String,
    pub title: String,
    pub stage: String,
    pub agent_type: String,
    pub worktree_path: Option<String>,
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
pub struct BlockTaskRequest {
    pub blocker_task_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskParentRequest {
    #[serde(default)]
    pub parent_task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskActionResponse {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_task: Option<bool>,
}

impl MobileApi {
    pub fn new(config: Config, db: Db) -> Self {
        Self { config, _db: db }
    }

    pub fn list_desktops(&self) -> Result<Vec<DesktopDescriptor>, String> {
        Ok(vec![DesktopDescriptor {
            id: self.config.desktop_id.clone(),
            name: self.config.desktop_name.clone(),
            connection_mode: "both".to_string(),
        }])
    }

    pub fn list_repos(&self) -> Result<Vec<RepoSummary>, String> {
        self._db
            .list_repos()
            .map(|repos| repos.into_iter().map(map_repo_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn add_repo(&self, request: AddRepoRequest) -> Result<RepoDetail, AddRepoError> {
        let canonical_path = validate_git_repo_path(&request.path)?;
        let path_string = canonical_path.to_string_lossy().to_string();
        if self
            ._db
            .repo_path_exists(&path_string)
            .map_err(|e| AddRepoError::Internal(format!("db error: {}", e)))?
        {
            return Err(AddRepoError::DuplicatePath);
        }
        let name = request
            .name
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                canonical_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
            })
            .ok_or_else(|| {
                AddRepoError::InvalidPath("repo name could not be derived".to_string())
            })?;
        let default_branch = git_default_branch(&canonical_path).ok();
        let id = generate_repo_id()?;
        self._db
            .insert_repo(NewRepo {
                id: &id,
                path: &path_string,
                name: &name,
                default_branch: default_branch.as_deref(),
            })
            .map_err(|e| AddRepoError::Internal(format!("db error: {}", e)))?;
        let repo = self
            ._db
            .get_repo(&id)
            .map_err(|e| AddRepoError::Internal(format!("db error: {}", e)))?
            .ok_or_else(|| AddRepoError::Internal("created repo was not found".to_string()))?;
        Ok(map_repo_detail(repo))
    }

    pub fn list_repo_tasks(&self, repo_id: &str) -> Result<Vec<TaskSummary>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        self._db
            .list_pipeline_items(repo_id)
            .map(|items| items.into_iter().map(map_task_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn list_recent_tasks(&self) -> Result<Vec<TaskSummary>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        self._db
            .list_recent_pipeline_items()
            .map(|items| items.into_iter().map(map_task_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn search_tasks(&self, query: &str) -> Result<Vec<TaskSummary>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        self._db
            .search_pipeline_items(query)
            .map(|items| items.into_iter().map(map_task_summary).collect())
            .map_err(|e| format!("db error: {}", e))
    }

    pub fn get_task(&self, task_or_branch_id: &str) -> Result<Option<TaskDetail>, String> {
        record_orphaned_initialized_tasks(&self._db)?;
        let task_id = self
            ._db
            .resolve_pipeline_item_id(task_or_branch_id)
            .map_err(|e| format!("db error: {}", e))?;
        let Some(task_id) = task_id else {
            return Ok(None);
        };
        let Some(item) = self
            ._db
            .get_pipeline_item(&task_id)
            .map_err(|e| format!("db error: {}", e))?
        else {
            return Ok(None);
        };
        let repo = self
            ._db
            .get_repo(&item.repo_id)
            .map_err(|e| format!("db error: {}", e))?;
        let worktree_path = self
            ._db
            .get_task_worktree_path(&item.id)
            .map_err(|e| format!("db error: {}", e))?;
        Ok(Some(map_task_detail(item, repo.as_ref(), worktree_path)))
    }
}

pub fn record_orphaned_initialized_tasks(db: &Db) -> Result<bool, String> {
    let worktree_paths = db
        .list_open_task_worktree_paths()
        .map_err(|e| format!("db error: {}", e))?;
    let mut recorded_any = false;
    for (task_id, worktree_path) in worktree_paths {
        if Path::new(&worktree_path).exists() {
            continue;
        }
        let result = format!(
            "task workspace missing: {worktree_path}. Use rerun-stage to recreate the workspace and restart the current stage."
        );
        let already_recorded = db
            .latest_stage_run(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        if already_recorded
            .as_ref()
            .and_then(|run| run.result.as_deref())
            .is_some_and(|existing| existing == result)
        {
            continue;
        }
        log::warn!("recording orphaned task {task_id}: worktree missing at {worktree_path}");
        db.cancel_running_stage_runs(&task_id)
            .map_err(|e| format!("db error: {}", e))?;
        db.update_pipeline_item_activity(&task_id, "unread")
            .map_err(|e| format!("db error: {}", e))?;
        let run_id = durable_failure_run_id(&task_id);
        db.insert_stage_run(NewStageRun {
            id: &run_id,
            task_id: &task_id,
            stage: already_recorded
                .as_ref()
                .map(|run| run.stage.as_str())
                .unwrap_or("in progress"),
            kind: "main",
            agent: already_recorded
                .as_ref()
                .and_then(|run| run.agent.as_deref()),
            agent_provider: already_recorded
                .as_ref()
                .and_then(|run| run.agent_provider.as_deref()),
            model: already_recorded
                .as_ref()
                .and_then(|run| run.model.as_deref()),
            status: "failed",
            result: Some(&result),
            feedback: Some("worktree missing"),
            session_id: Some(&task_id),
            provider_session_id: None,
            cwd: Some(&worktree_path),
            resumed_from_run_id: None,
        })
        .map_err(|e| format!("db error: {}", e))?;
        recorded_any = true;
    }
    Ok(recorded_any)
}

fn durable_failure_run_id(task_id: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("run-{task_id}-{nanos}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AddRepoError {
    InvalidPath(String),
    DuplicatePath,
    Internal(String),
}

impl AddRepoError {
    pub fn message(&self) -> String {
        match self {
            AddRepoError::InvalidPath(message) => message.clone(),
            AddRepoError::DuplicatePath => "repo path is already registered".to_string(),
            AddRepoError::Internal(message) => message.clone(),
        }
    }
}

fn map_task_summary(item: crate::db::PipelineItem) -> TaskSummary {
    let title = item
        .display_name
        .clone()
        .or(item.prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    let waiting_prompt_snippet = item.last_output_preview.clone();
    TaskSummary {
        id: item.id,
        repo_id: item.repo_id,
        title,
        stage: item.stage,
        activity: item.activity,
        snippet: waiting_prompt_snippet.clone(),
        waiting_prompt_snippet,
        agent_type: item.agent_type,
    }
}

fn map_task_detail(
    item: crate::db::PipelineItem,
    repo: Option<&crate::db::Repo>,
    worktree_path: Option<String>,
) -> TaskDetail {
    let title = item
        .display_name
        .clone()
        .or(item.prompt.clone())
        .unwrap_or_else(|| item.id.clone());
    let git_state = worktree_path
        .as_deref()
        .and_then(|path| {
            Path::new(path)
                .exists()
                .then(|| task_git_state(path, task_base_ref(&item, repo).as_deref()))
        })
        .and_then(Result::ok)
        .unwrap_or_default();
    let existing_worktree_path = worktree_path.filter(|path| Path::new(path).exists());
    let pipeline_name = item.pipeline.clone();
    let stage_transition = repo
        .zip(pipeline_name.as_deref())
        .zip(item.stage.as_deref())
        .and_then(|((repo, pipeline_name), stage_name)| {
            crate::task_creator::resolve_stage_transition(
                repo,
                pipeline_name,
                item.pipeline_def.as_deref(),
                stage_name,
            )
            .ok()
            .flatten()
        });
    let waiting_prompt_snippet = item.last_output_preview.clone();
    TaskDetail {
        id: item.id,
        repo_id: item.repo_id,
        title,
        stage: item.stage,
        pipeline_name,
        stage_transition,
        activity: item.activity,
        snippet: waiting_prompt_snippet.clone(),
        waiting_prompt_snippet,
        agent_type: item.agent_type,
        agent_provider: item.agent_provider,
        branch: item.branch,
        pr_url: item.pr_url,
        closed_at: item.closed_at,
        worktree_path: existing_worktree_path,
        commits_ahead: git_state.commits_ahead,
        commits_behind: git_state.commits_behind,
        dirty: git_state.dirty,
    }
}

fn map_repo_summary(repo: crate::db::Repo) -> RepoSummary {
    RepoSummary {
        id: repo.id,
        name: repo.name,
    }
}

fn map_repo_detail(repo: crate::db::Repo) -> RepoDetail {
    RepoDetail {
        id: repo.id,
        path: repo.path,
        name: repo.name,
        default_branch: repo.default_branch,
        hidden: repo.hidden,
        sort_order: repo.sort_order,
        created_at: repo.created_at,
        last_opened_at: repo.last_opened_at,
    }
}

#[derive(Default)]
struct TaskGitState {
    commits_ahead: i64,
    commits_behind: i64,
    dirty: bool,
}

fn validate_git_repo_path(path: &str) -> Result<PathBuf, AddRepoError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| AddRepoError::InvalidPath(format!("path does not exist: {}", e)))?;
    if !canonical.is_dir() {
        return Err(AddRepoError::InvalidPath(
            "path must be a directory".to_string(),
        ));
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&canonical)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .output()
        .map_err(|e| AddRepoError::Internal(format!("failed to run git: {}", e)))?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "true" {
        return Err(AddRepoError::InvalidPath(
            "path is not a git repository".to_string(),
        ));
    }
    Ok(canonical)
}

fn git_default_branch(repo_path: &Path) -> Result<String, String> {
    let remote_head = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        .map_err(|e| format!("failed to run git symbolic-ref: {}", e))?;
    if remote_head.status.success() {
        let branch = String::from_utf8_lossy(&remote_head.stdout)
            .trim()
            .strip_prefix("origin/")
            .map(str::to_string)
            .or_else(|| {
                let trimmed = String::from_utf8_lossy(&remote_head.stdout)
                    .trim()
                    .to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
        if let Some(branch) = branch {
            return Ok(branch);
        }
    }

    let head = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["branch", "--show-current"])
        .output()
        .map_err(|e| format!("failed to run git branch: {}", e))?;
    if head.status.success() {
        let branch = String::from_utf8_lossy(&head.stdout).trim().to_string();
        if !branch.is_empty() {
            return Ok(branch);
        }
    }
    Err("could not determine default branch".to_string())
}

fn task_base_ref(item: &crate::db::PipelineItem, repo: Option<&crate::db::Repo>) -> Option<String> {
    item.base_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| repo.and_then(|repo| repo.default_branch.clone()))
}

fn task_git_state(worktree_path: &str, base_ref: Option<&str>) -> Result<TaskGitState, String> {
    let dirty = git_status_dirty(worktree_path)?;
    let (commits_ahead, commits_behind) = match base_ref {
        Some(base_ref) => git_ahead_behind(worktree_path, base_ref).unwrap_or((0, 0)),
        None => (0, 0),
    };
    Ok(TaskGitState {
        commits_ahead,
        commits_behind,
        dirty,
    })
}

fn git_status_dirty(worktree_path: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("failed to run git status: {}", e))?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(!output.stdout.is_empty())
}

fn git_ahead_behind(worktree_path: &str, base_ref: &str) -> Result<(i64, i64), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(["rev-list", "--left-right", "--count"])
        .arg(format!("{base_ref}...HEAD"))
        .output()
        .map_err(|e| format!("failed to run git rev-list: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut parts = stdout.split_whitespace();
    let behind = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let ahead = parts
        .next()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    Ok((ahead, behind))
}

fn generate_repo_id() -> Result<String, AddRepoError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AddRepoError::Internal(format!("system clock error: {}", e)))?
        .as_nanos();
    Ok(format!("repo-{nanos:x}"))
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
            "displayName": "Short task title",
            "agentProvider": "claude",
            "agentType": "agent"
        }))
        .unwrap();

        assert_eq!(request.display_name.as_deref(), Some("Short task title"));
        assert_eq!(request.agent_type.as_deref(), Some("agent"));
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "repoId": "repo-1",
                "prompt": "Build the view",
                "displayName": "Short task title",
                "pipelineName": null,
                "stage": null,
                "baseRef": null,
                "agent": null,
                "agentProvider": "claude",
                "agentType": "agent",
                "model": null,
                "permissionMode": null,
                "allowedTools": null,
                "disallowedTools": null,
                "maxTurns": null,
                "maxBudgetUsd": null,
                "setupCmds": null,
                "resumeSessionId": null,
                "blockerTaskIds": null,
                "notifyTaskId": null,
                "parentTaskId": null
            })
        );
    }

    #[test]
    fn create_task_request_does_not_retain_body_task_id() {
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "taskId": "0123456789abcdef",
            "repoId": "repo-1",
            "prompt": "Build the view"
        }))
        .unwrap();

        let serialized = serde_json::to_value(request).unwrap();
        assert!(serialized.get("taskId").is_none());
    }

    #[test]
    fn create_task_request_accepts_display_name_snake_case_alias() {
        let request: CreateTaskRequest = serde_json::from_value(json!({
            "repoId": "repo-1",
            "prompt": "Build the view",
            "display_name": "Short task title"
        }))
        .unwrap();

        assert_eq!(request.display_name.as_deref(), Some("Short task title"));
    }

    #[test]
    fn list_desktops_returns_configured_descriptor() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("desktop-list"),
            kanna_cli_path: None,
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
        assert_eq!(desktops[0].connection_mode, "both");
    }

    #[test]
    fn list_repos_returns_repo_summaries() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("repo-summaries"),
            kanna_cli_path: None,
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
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("recent-tasks"),
            kanna_cli_path: None,
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
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("repo-tasks"),
            kanna_cli_path: None,
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
    fn list_recent_tasks_includes_waiting_prompt_snippet() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("recent-task-snippet"),
            kanna_cli_path: None,
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
        assert_eq!(
            tasks[0].waiting_prompt_snippet.as_deref(),
            Some("Latest agent output preview")
        );
    }

    #[test]
    fn task_detail_uses_stored_pipeline_transition_when_origin_definition_is_unavailable() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("task-detail-stored-transition"),
            kanna_cli_path: None,
            desktop_id: "desktop-1".to_string(),
            desktop_secret: Some("desktop-secret".to_string()),
            desktop_name: "Studio Mac".to_string(),
            server_version: Some("test-version".to_string()),
            lan_host: "0.0.0.0".to_string(),
            lan_port: 48120,
            pairing_store_path: "/tmp/kanna-pairings.json".to_string(),
        };
        let db = Db::open_for_tests(&config.db_path).unwrap();
        // This path intentionally has no Git repository or origin definition.
        // A durable task snapshot must be sufficient for task-detail metadata.
        db.insert_test_repo("repo-1", "Repo One").unwrap();
        db.insert_test_pipeline_item(
            "task-stored",
            "repo-1",
            "frozen task",
            Some("Frozen Task"),
            "frozen",
            "2026-04-17 09:00:00",
        )
        .unwrap();
        db.update_test_pipeline_item_pipeline_def(
            "task-stored",
            &json!({
                "name": "default",
                "stages": [{
                    "name": "frozen",
                    "transition": "manual"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let api = super::MobileApi::new(config, db);
        let detail = api.get_task("task-stored").unwrap().unwrap();

        assert_eq!(detail.stage_transition.as_deref(), Some("manual"));
    }

    #[test]
    fn search_tasks_matches_display_name_or_prompt_and_excludes_closed_tasks() {
        let config = Config {
            relay_url: "wss://relay.example".to_string(),
            device_token: "device-token".to_string(),
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("search-tasks"),
            kanna_cli_path: None,
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
            firebase_project_id: "kanna-local".to_string(),
            firebase_auth_emulator_url: None,
            firebase_firestore_emulator_host: None,
            daemon_dir: "/tmp/kanna-daemon".to_string(),
            db_path: Db::test_db_path("status"),
            kanna_cli_path: None,
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
