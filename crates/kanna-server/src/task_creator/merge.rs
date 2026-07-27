use super::definitions::{
    PipelineDefinition, PipelineStage, PipelineStagePolicy, PipelineStageTransition,
};
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
    let request = build_merge_task_request()?;
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

fn build_merge_task_request() -> Result<TaskCreationRequest, String> {
    let pipeline_name = "singleton-merge".to_string();
    let pipeline = PipelineDefinition {
        name: Some(pipeline_name.clone()),
        description: None,
        stages: vec![PipelineStage {
            name: "in progress".to_string(),
            description: None,
            agent: Some("merge".to_string()),
            prompt: Some("$TASK_PROMPT".to_string()),
            agent_provider: None,
            environment: None,
            policy: PipelineStagePolicy {
                transition: PipelineStageTransition::Manual,
                revision_transition: None,
            },
            post: None,
        }],
        environments: None,
        revision_limit: None,
    };
    let pipeline_def =
        serde_json::to_string(&pipeline).map_err(|e| format!("serialize error: {}", e))?;
    Ok(TaskCreationRequest {
        requested_task_id: None,
        create_intent_json: None,
        task_prompt: String::new(),
        display_name: Some("Merge Master".to_string()),
        pipeline_name: Some(pipeline_name),
        pipeline_def: Some(pipeline_def),
        base_ref: None,
        stored_base_ref: None,
        stage_override: None,
        agent: None,
        explicit_provider: None,
        default_provider: None,
        agent_type: None,
        initial_terminal_geometry: None,
        model: None,
        permission_mode: None,
        allowed_tools: Vec::new(),
        disallowed_tools: Vec::new(),
        max_turns: None,
        max_budget_usd: None,
        setup_cmds: Vec::new(),
        task_template: None,
        resume_session_id: None,
        recovery_snapshot: None,
        notify_task_id: None,
        parent_task_id: None,
    })
}
