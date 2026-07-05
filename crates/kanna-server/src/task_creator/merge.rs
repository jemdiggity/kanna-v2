use super::definitions::read_agent_definition;
use super::lifecycle::spawn_prepared_task_for_api_recording_stage_run;
use super::types::{PreparedTaskSpawn, TaskCreationRequest};
use crate::config::Config;
use crate::daemon_client::DaemonClient;
use crate::db::{Db, Repo};

pub async fn run_merge_agent(
    db: &Db,
    daemon: &mut DaemonClient,
    config: &Config,
    source_task_id: &str,
) -> Result<String, String> {
    let prepared = prepare_merge_agent_for_api(db, config, source_task_id)?;
    spawn_merge_agent_task(&config.db_path, daemon, prepared).await
}

pub(crate) fn prepare_merge_agent_for_api(
    db: &Db,
    config: &Config,
    source_task_id: &str,
) -> Result<PreparedTaskSpawn, String> {
    let repo = load_merge_source_repo(db, source_task_id)?;
    let request = build_merge_task_request(&repo.path)?;
    super::prepare_task_spawn(db, config, &repo, request)
}

async fn spawn_merge_agent_task(
    db_path: &str,
    daemon: &mut DaemonClient,
    prepared: PreparedTaskSpawn,
) -> Result<String, String> {
    spawn_prepared_task_for_api_recording_stage_run(db_path, daemon, prepared)
        .await
        .map(|created| created.task_id)
}

fn load_merge_source_repo(db: &Db, source_task_id: &str) -> Result<Repo, String> {
    let source_task = db
        .get_pipeline_item(source_task_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("task not found: {}", source_task_id))?;
    db.get_repo(&source_task.repo_id)
        .map_err(|e| format!("db error: {}", e))?
        .ok_or_else(|| format!("repo not found for task: {}", source_task_id))
}

fn build_merge_task_request(repo_path: &str) -> Result<TaskCreationRequest, String> {
    let merge_agent = read_agent_definition(repo_path, "merge")?;
    Ok(TaskCreationRequest {
        task_prompt: merge_agent.prompt,
        display_name: Some("Merge Master".to_string()),
        pipeline_name: None,
        pipeline_def: None,
        base_ref: None,
        stored_base_ref: None,
        stage_override: None,
        explicit_provider: None,
        default_provider: None,
        agent_type: None,
        model: None,
        permission_mode: None,
        allowed_tools: Vec::new(),
        disallowed_tools: Vec::new(),
        max_turns: None,
        max_budget_usd: None,
        setup_cmds: Vec::new(),
        notify_task_id: None,
        parent_task_id: None,
    })
}
