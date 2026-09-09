use std::io::Write;
use std::process;
use std::time::Duration;

use serde_json::Value;

use crate::api::{
    advance_stage_via_api, block_task_via_api, close_task_via_api, create_task_via_api,
    dependent_tasks_exist_via_api, get_task_via_api, get_task_with_agent_view_via_api,
    list_repo_tasks_via_api, list_task_children_via_api, list_tasks_via_api,
    list_tasks_with_options_via_api, notify_mobile_via_api, parse_wait_until, rename_task_via_api,
    request_revision_via_api, rerun_stage_via_api, resume_task_via_api, search_tasks_via_api,
    search_tasks_with_options_via_api, send_task_input_via_api, send_task_raw_input_via_api,
    set_task_parent_via_api, set_task_workflow_via_api, signal_merge_handoff_via_api,
    task_inputs_via_api, task_logs_with_agent_view_via_api, unblock_task_via_api,
    wait_task_events_via_api, wait_task_via_api, NextStageProviderOverride, WaitTaskOutcome,
};
use crate::commands::{parse_metadata_json, print_json};
use crate::config::resolve_server_base_url_from_env;
use crate::models::{
    BlockTaskRequest, CreateTaskRequest, MergeHandoffRequest, MobileNotificationRequest,
    RequestRevisionRequest, SetTaskParentRequest, SetTaskWorkflowRequest, TaskCreateOptions,
    TaskDetail, TaskInputRequest, TaskRawInputRequest, TaskRenameRequest, TaskStatusRow,
    TaskSummary,
};
use crate::TaskCommands;
use kanna_tool_catalog::{task_event_self_exclusion, wait_resolved_result, wait_timeout_result};

const WATCH_CURSOR_RECORD_TYPE: &str = "watch.cursor";

#[derive(Debug, Clone)]
pub(crate) struct TaskWatchOptions {
    pub(crate) task_ids: Vec<String>,
    pub(crate) repo_id: Option<String>,
    /// Effective exclusions — see [`resolve_task_event_exclusions`].
    pub(crate) exclude_task_ids: Vec<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) all_events: bool,
    pub(crate) budget_secs: Option<u64>,
    pub(crate) follow: bool,
}

/// The typed CLI's application of the shared self-exclusion policy
/// (`kanna_tool_catalog::task_event_self_exclusion`): explicit
/// `--exclude-task-id` values always apply, and a repository-scoped wait from
/// inside a task session (`KANNA_TASK_ID`) also drops the caller's own task
/// unless `--include-self` was passed. The same rule the catalog applies to
/// `kanna_wait_events`, so an agent on the CLI fallback is not woken by
/// events the MCP tool would have filtered.
pub(crate) fn resolve_task_event_exclusions(
    explicit_exclusions: Vec<String>,
    explicit_task_scope: bool,
    include_self: bool,
    current_task_id: Option<&str>,
) -> Vec<String> {
    let mut exclusions: Vec<String> = Vec::new();
    for value in explicit_exclusions {
        let value = value.trim().to_string();
        if !value.is_empty() && !exclusions.contains(&value) {
            exclusions.push(value);
        }
    }
    if let Some(self_task_id) =
        task_event_self_exclusion(explicit_task_scope, include_self, current_task_id)
    {
        if !exclusions.contains(&self_task_id) {
            exclusions.push(self_task_id);
        }
    }
    exclusions
}

fn insert_optional(args: &mut Value, key: &str, value: Option<String>) {
    if let (Some(object), Some(value)) = (args.as_object_mut(), value) {
        object.insert(key.to_string(), Value::String(value));
    }
}

/// Run a task-transfer tool through the shared catalog.
///
/// These four commands deliberately have no typed HTTP path of their own. The
/// transfer surface is the one an agent reaches for when a task has to change
/// machines, and the CLI and MCP answers to "did it move?" must be the same
/// object — so both resolve the same catalog declaration and print what the
/// server returned, rather than each rendering its own idea of the result.
async fn run_transfer_tool(name: &str, args: &Value, server_url: Option<&str>) {
    let catalog =
        crate::commands::tool::load_tool_catalog_from_current_dir().unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            process::exit(1);
        });
    let base_url = resolve_server_base_url_from_env(server_url);
    let (_, value) = crate::commands::tool::call_catalog_tool(&base_url, &catalog, name, args)
        .await
        .unwrap_or_else(|error| {
            eprintln!("Error: {error}");
            process::exit(1);
        });
    if let Err(error) = print_json(&value) {
        eprintln!("Error: {error}");
        process::exit(1);
    }
}

fn current_task_id_from_env() -> Option<String> {
    std::env::var("KANNA_TASK_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn run_finished_has_running_successor(event: &Value) -> bool {
    let payload = &event["payload"];
    let finished_run_id = payload.get("runId").and_then(Value::as_str);
    let latest_run = &payload["currentTask"]["latestRun"];
    latest_run.get("status").and_then(Value::as_str) == Some("running")
        && match (
            finished_run_id,
            latest_run.get("id").and_then(Value::as_str),
        ) {
            (Some(finished), Some(latest)) => finished != latest,
            // A running latest run is necessarily a successor even when an
            // older server omitted one of the ids from its enrichment.
            _ => true,
        }
}

pub(crate) fn is_actionable_task_event(event: &Value) -> bool {
    match event.get("type").and_then(Value::as_str) {
        Some("run.started" | "stage.changed" | "task.created" | "task.input_delivered") => false,
        // The read/unread display dimension. A person opening a task in the
        // desktop moves it, which is information for that person and never a
        // reason to wake the watcher; `task.runtime_changed` carries the
        // runtime edge underneath it.
        Some("task.activity_changed") => false,
        // Deprecated alias of the busy-to-non-busy subset of
        // `task.runtime_changed`, appended in the same transaction — so it is
        // always redundant with an event already in this batch.
        Some("task.runtime_settled") => false,
        Some("run.finished") => !run_finished_has_running_successor(event),
        _ => true,
    }
}

fn write_ndjson<W: Write>(writer: &mut W, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value)
        .map_err(|error| format!("failed to render watch output: {error}"))?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| format!("failed to write watch output: {error}"))
}

fn write_watch_cursor<W: Write>(
    writer: &mut W,
    cursor: &str,
    watch_outcome: &str,
) -> Result<(), String> {
    write_ndjson(
        writer,
        &serde_json::json!({
            "type": WATCH_CURSOR_RECORD_TYPE,
            "watchOutcome": watch_outcome,
            "cursor": cursor,
        }),
    )
}

/// Own the long-running cursor loop while each individual HTTP request keeps
/// the shared client-safe clamp. The cursor is advanced before filtering so a
/// restart never replays suppressed engine mechanics.
pub(crate) async fn watch_task_events<W: Write>(
    base_url: &str,
    options: TaskWatchOptions,
    writer: &mut W,
) -> Result<(), String> {
    let mut cursor = options.cursor;
    let mut first_call = true;
    let mut quiet_since = tokio::time::Instant::now();

    loop {
        let remaining_budget = options.budget_secs.map(|budget_secs| {
            Duration::from_secs(budget_secs).saturating_sub(quiet_since.elapsed())
        });
        if !first_call && remaining_budget.is_some_and(|remaining| remaining.is_zero()) {
            let cursor = cursor
                .as_deref()
                .ok_or_else(|| "task watch ended without receiving a cursor".to_string())?;
            return write_watch_cursor(writer, cursor, "budget_expired");
        }

        let timeout_secs = remaining_budget
            .map(|remaining| {
                remaining
                    .as_secs()
                    .saturating_add(u64::from(remaining.subsec_nanos() != 0))
                    .min(kanna_tool_catalog::MAX_WAIT_TIMEOUT_SECS)
            })
            .unwrap_or(kanna_tool_catalog::MAX_WAIT_TIMEOUT_SECS);
        let params = crate::api::TaskEventsParams {
            task_ids: &options.task_ids,
            parent_task_id: None,
            repo_id: options.repo_id.as_deref(),
            repo_remote_url_hash: None,
            exclude_task_ids: &options.exclude_task_ids,
            // The watch owns its own actionable filter, which suppresses the
            // display dimension client-side while still advancing the cursor
            // past it — `--all` must still be able to show it.
            exclude_event_types: &[],
            local_only: false,
            include_current_activity: false,
            short_cursor: true,
            from: (first_call && cursor.is_none()).then_some("now"),
            cursor: cursor.as_deref(),
            timeout_secs,
            limit: None,
        };
        let batch = wait_task_events_via_api(base_url, &params).await?;
        first_call = false;
        let next_cursor = batch
            .get("cursor")
            .and_then(Value::as_str)
            .ok_or_else(|| "task event response did not include a cursor".to_string())?
            .to_string();
        cursor = Some(next_cursor.clone());
        let events = batch
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| "task event response did not include an events array".to_string())?;
        let actionable = events
            .iter()
            .filter(|event| options.all_events || is_actionable_task_event(event))
            .collect::<Vec<_>>();

        if !actionable.is_empty() {
            for event in actionable {
                write_ndjson(writer, event)?;
            }
            if !options.follow {
                return write_watch_cursor(writer, &next_cursor, "actionable");
            }
            // Follow mode emits a checkpoint after each batch so an
            // interactive caller can resume after interruption.
            write_watch_cursor(writer, &next_cursor, "following")?;
            quiet_since = tokio::time::Instant::now();
        }
    }
}

pub(crate) fn build_create_task_request(options: TaskCreateOptions) -> CreateTaskRequest {
    CreateTaskRequest {
        repo_id: options.repo_id,
        prompt: options.prompt,
        display_name: options.display_name,
        workflow_name: options.workflow_name,
        base_ref: options.base_ref,
        diff_base_ref: options.diff_base_ref,
        agent: options.agent,
        agent_provider: options.agent_provider,
        agent_type: options.agent_type.or_else(|| Some("pty".to_string())),
        model: options.model,
        effort: options.effort,
        permission_mode: options.permission_mode,
        allowed_tools: (!options.allowed_tool.is_empty()).then_some(options.allowed_tool),
        blocker_task_ids: (!options.blocker_task_id.is_empty()).then_some(options.blocker_task_id),
        parent_task_id: options.parent_task,
    }
}

pub(crate) fn build_request_revision_request(
    target_stage: String,
    summary: String,
    prompt: String,
    metadata: Option<Value>,
) -> RequestRevisionRequest {
    RequestRevisionRequest {
        run_id: None,
        target_stage,
        summary,
        prompt,
        metadata,
    }
}

pub(crate) fn build_send_task_input_request(
    message: String,
    source: Option<String>,
) -> TaskInputRequest {
    // Send the message text as-is. Submitting it to the agent terminal (typing
    // the text, then a discrete Enter keystroke) is the daemon's job at
    // /v1/tasks/{id}/input — keeping that policy server-side means kanna-cli,
    // kanna-mcp, and the mobile app all submit consistently.
    TaskInputRequest {
        input: message,
        source,
    }
}

/// Turn the CLI's flags into one raw-input request.
///
/// The exclusivity check lives here rather than only at the server so that a
/// mistake costs an error message instead of a round trip into somebody's live
/// terminal — and so the rule is stated in the place a reader of the CLI looks
/// for it. Everything else (the key vocabulary, the byte limits, the
/// carriage-return rule) is deliberately the server's: one definition, checked
/// where the write happens.
pub(crate) fn build_task_raw_input_request(
    keys: Vec<String>,
    bytes: Option<String>,
    encoding: Option<String>,
    source: Option<String>,
) -> Result<TaskRawInputRequest, String> {
    match (keys.is_empty(), bytes.as_ref()) {
        (false, Some(_)) => Err(
            "--keys and --bytes are mutually exclusive: pass named keys, or explicit bytes, not both"
                .to_string(),
        ),
        (true, None) => Err(
            "pass --keys (for example --keys down,enter) or --bytes (for example --bytes 1b5b42)"
                .to_string(),
        ),
        (false, None) => {
            if encoding.is_some() {
                return Err("--encoding applies to --bytes, not to --keys".to_string());
            }
            Ok(TaskRawInputRequest {
                keys: Some(keys),
                bytes: None,
                encoding: None,
                source,
            })
        }
        (true, Some(bytes)) => Ok(TaskRawInputRequest {
            keys: None,
            bytes: Some(bytes.clone()),
            encoding,
            source,
        }),
    }
}

/// The accepted key names, as `--list-keys` prints them.
pub(crate) fn rendered_key_vocabulary() -> String {
    let mut rendered = String::from(
        "Named keys accepted by `kanna-cli task send-raw-input --keys` (comma-separated, in \
         order):\n\n",
    );
    for name in kanna_runtime_defaults::terminal_keys::terminal_key_names() {
        rendered.push_str("  ");
        rendered.push_str(name);
        rendered.push('\n');
    }
    rendered.push_str(
        "\nOnly `enter` declares a submission boundary. `ctrl-i` and `ctrl-m` are absent: use \
         `tab` and `enter`, which write the same bytes and declare the right composer meaning. \
         Anything not listed goes through `--bytes` as hex, e.g. `--bytes 1b4f42` for the \
         application-cursor form of Down.\n",
    );
    rendered
}

pub(crate) fn build_block_task_request(blocker_task_ids: Vec<String>) -> BlockTaskRequest {
    BlockTaskRequest { blocker_task_ids }
}

pub(crate) fn build_merge_handoff_request(
    branch: String,
    target: String,
    pr_url: Option<String>,
    summary: String,
) -> MergeHandoffRequest {
    MergeHandoffRequest {
        branch,
        target,
        pr_url,
        summary,
    }
}

/// Render a wait the same way the MCP tool does — the task detail plus the
/// `waitOutcome` discriminator — so an agent looping on `kanna-cli task wait`
/// reads the same field an MCP caller reads.
pub(crate) fn render_wait_outcome(
    outcome: WaitTaskOutcome,
    task_id: &str,
) -> Result<Value, String> {
    match outcome {
        WaitTaskOutcome::Resolved(task) => serde_json::to_value(task)
            .map(wait_resolved_result)
            .map_err(|e| format!("failed to render json: {e}")),
        WaitTaskOutcome::TimedOut { task, timeout_secs } => serde_json::to_value(task)
            .map(|task| wait_timeout_result(task, task_id, timeout_secs))
            .map_err(|e| format!("failed to render json: {e}")),
    }
}

pub(crate) fn task_status_row(task: &TaskSummary) -> TaskStatusRow {
    TaskStatusRow {
        id: task.id.clone(),
        repo_id: task.repo_id.clone(),
        stage: task.stage.clone().unwrap_or_default(),
        activity: task.activity.clone().unwrap_or_default(),
        title: task.title.clone(),
    }
}

pub(crate) fn task_detail_status_row(task: &TaskDetail) -> TaskStatusRow {
    TaskStatusRow {
        id: task.id.clone(),
        repo_id: task.repo_id.clone(),
        stage: task.stage.clone().unwrap_or_default(),
        activity: task.activity.clone().unwrap_or_default(),
        title: task.title.clone(),
    }
}

pub(crate) fn task_status_rows(tasks: &[TaskSummary]) -> Vec<TaskStatusRow> {
    tasks.iter().map(task_status_row).collect()
}

pub(crate) fn format_task_list(tasks: &[TaskSummary]) -> Result<String, String> {
    serde_json::to_string_pretty(&task_status_rows(tasks))
        .map_err(|e| format!("failed to render json: {e}"))
}

#[cfg(test)]
pub(crate) fn find_task_status_row(tasks: &[TaskSummary], task_id: &str) -> Option<TaskStatusRow> {
    tasks
        .iter()
        .find(|task| task.id == task_id)
        .map(task_status_row)
}

pub(crate) fn format_task_status(task: &TaskStatusRow) -> Result<String, String> {
    serde_json::to_string_pretty(task).map_err(|e| format!("failed to render json: {e}"))
}

#[cfg(test)]
pub(crate) fn task_not_found_error(task_id: &str) -> String {
    format!("Task '{task_id}' was not found")
}
pub(crate) async fn run(command: TaskCommands) {
    match command {
        TaskCommands::List {
            repo_id,
            all_repos,
            limit,
            all_machines,
            include_closed,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            if let Some(repo_id) = repo_id {
                if all_repos {
                    eprintln!("Error: --repo-id and --all-repos cannot be used together");
                    process::exit(1);
                }
                let tasks = list_repo_tasks_via_api(&base_url, &repo_id)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
                let rendered = format_task_list(&tasks).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                println!("{rendered}");
            } else if all_repos || limit.is_some() || all_machines || include_closed {
                let tasks = list_tasks_with_options_via_api(
                    &base_url,
                    all_repos,
                    limit,
                    all_machines,
                    include_closed,
                )
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                print_json(&tasks).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            } else {
                let tasks = list_tasks_via_api(&base_url).await.unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                let rendered = format_task_list(&tasks).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                println!("{rendered}");
            }
        }
        TaskCommands::Search {
            query,
            repo_id,
            all_repos,
            all_machines,
            include_closed,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            if repo_id.is_some() || all_repos || all_machines || include_closed {
                let tasks = search_tasks_with_options_via_api(
                    &base_url,
                    &query,
                    repo_id.as_deref(),
                    all_repos,
                    all_machines,
                    include_closed,
                )
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                print_json(&tasks).unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
                return;
            }
            let tasks = search_tasks_via_api(&base_url, &query)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            let rendered = format_task_list(&tasks).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            println!("{rendered}");
        }
        TaskCommands::Status {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let task = get_task_via_api(&base_url, &task_id)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            let row = task_detail_status_row(&task);
            let rendered = format_task_status(&row).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            println!("{rendered}");
        }
        TaskCommands::Get {
            task_id,
            agent_view,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let task = get_task_with_agent_view_via_api(&base_url, &task_id, agent_view)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&task) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Children {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let children = list_task_children_via_api(&base_url, &task_id)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&children) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::DependentTasksExist {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let response = dependent_tasks_exist_via_api(&base_url, &task_id)
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
        TaskCommands::Wait {
            task_id,
            timeout_secs,
            poll_secs,
            until,
            server_url,
        } => {
            let until = parse_wait_until(&until).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let outcome = wait_task_via_api(&base_url, &task_id, timeout_secs, poll_secs, until)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            let rendered = render_wait_outcome(outcome, &task_id).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            if let Err(e) = print_json(&rendered) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Inputs {
            task_id,
            tail,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let inputs = task_inputs_via_api(&base_url, &task_id, tail)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&inputs) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Logs {
            task_id,
            tail,
            agent_view,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let logs = task_logs_with_agent_view_via_api(&base_url, &task_id, tail, agent_view)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            println!("{logs}");
        }
        TaskCommands::Create {
            repo_id,
            prompt,
            display_name,
            server_url,
            workflow_name,
            base_ref,
            diff_base_ref,
            agent,
            agent_provider,
            agent_type,
            model,
            effort,
            permission_mode,
            allowed_tool,
            blocker_task_id,
            parent_task,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_create_task_request(TaskCreateOptions {
                repo_id,
                prompt,
                display_name,
                workflow_name,
                base_ref,
                diff_base_ref,
                agent,
                agent_provider,
                agent_type,
                model,
                effort,
                permission_mode,
                allowed_tool,
                blocker_task_id,
                parent_task,
            });
            let created = create_task_via_api(&base_url, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&created) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::RequestRevision {
            task_id,
            target_stage,
            summary,
            prompt,
            metadata,
            server_url,
        } => {
            let metadata_value = parse_metadata_json(&metadata).unwrap_or_else(|e| {
                eprintln!("Error: {e}");
                process::exit(1);
            });
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let mut request =
                build_request_revision_request(target_stage, summary, prompt, metadata_value);
            bind_revision_request(&mut request).unwrap_or_else(|error| {
                eprintln!("Error: {error}");
                process::exit(1);
            });
            let created = request_revision_via_api(&base_url, &task_id, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&created) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::SendInput {
            task_id,
            message,
            source,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_send_task_input_request(message, source);
            let response = send_task_input_via_api(&base_url, &task_id, &request)
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
        TaskCommands::SendRawInput {
            task_id,
            keys,
            bytes,
            encoding,
            source,
            list_keys,
            server_url,
        } => {
            if list_keys {
                print!("{}", rendered_key_vocabulary());
                return;
            }
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_task_raw_input_request(keys, bytes, encoding, source)
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            let response = send_task_raw_input_via_api(&base_url, &task_id, &request)
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
        TaskCommands::Rename {
            task_id,
            name,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = TaskRenameRequest { display_name: name };
            let renamed = rename_task_via_api(&base_url, &task_id, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&renamed) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::AdvanceStage {
            task_id,
            source,
            next_stage_agent_provider,
            next_stage_model,
            next_stage_effort,
            next_stage_provider_source,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let next_stage = NextStageProviderOverride {
                provider: next_stage_agent_provider.as_deref(),
                model: next_stage_model.as_deref(),
                effort: next_stage_effort.as_deref(),
                source: next_stage_provider_source.as_deref(),
            };
            let advanced =
                advance_stage_via_api(&base_url, &task_id, source.as_deref(), next_stage)
                    .await
                    .unwrap_or_else(|e| {
                        eprintln!("Error: {e}");
                        process::exit(1);
                    });
            if let Err(e) = print_json(&advanced) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Push {
            task_id,
            to_machine,
            transport,
            intent_key,
            machine_id,
            server_url,
        } => {
            let mut args = serde_json::json!({
                "task_id": task_id,
                "to_machine": to_machine,
            });
            insert_optional(&mut args, "transport", transport);
            insert_optional(&mut args, "intent_key", intent_key);
            insert_optional(&mut args, "machine_id", machine_id);
            run_transfer_tool("kanna_push_task", &args, server_url.as_deref()).await;
        }
        TaskCommands::Pull {
            source_task_id,
            from_machine,
            transport,
            server_url,
        } => {
            let mut args = serde_json::json!({
                "source_task_id": source_task_id,
                "from_machine": from_machine,
            });
            insert_optional(&mut args, "transport", transport);
            run_transfer_tool("kanna_pull_task", &args, server_url.as_deref()).await;
        }
        TaskCommands::Transfers {
            task_id,
            machine_id,
            server_url,
        } => {
            let mut args = serde_json::json!({ "task_id": task_id });
            insert_optional(&mut args, "machine_id", machine_id);
            run_transfer_tool("kanna_task_transfers", &args, server_url.as_deref()).await;
        }
        TaskCommands::SignalMerge {
            task_id,
            branch,
            target,
            pr_url,
            summary,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_merge_handoff_request(branch, target, pr_url, summary);
            let response = signal_merge_handoff_via_api(&base_url, &task_id, &request)
                .await
                .unwrap_or_else(|error| {
                    eprintln!("Error: {error}");
                    process::exit(1);
                });
            if let Err(error) = print_json(&response) {
                eprintln!("Error: {error}");
                process::exit(1);
            }
        }
        TaskCommands::RerunStage {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let rerun = rerun_stage_via_api(&base_url, &task_id)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&rerun) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Resume {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let resumed = resume_task_via_api(&base_url, &task_id)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&resumed) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Block {
            task_id,
            blocker_task_id,
            server_url,
        } => {
            if blocker_task_id.is_empty() {
                eprintln!("Error: at least one --blocker-task-id is required");
                process::exit(1);
            }
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_block_task_request(blocker_task_id);
            let blocked = block_task_via_api(&base_url, &task_id, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&blocked) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Unblock {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let unblocked = unblock_task_via_api(&base_url, &task_id)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&unblocked) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Close {
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            close_task_via_api(&base_url, &task_id)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&serde_json::json!({ "taskId": task_id, "closed": true })) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::SetParent {
            task_id,
            parent_task,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = SetTaskParentRequest {
                parent_task_id: parent_task,
            };
            let updated = set_task_parent_via_api(&base_url, &task_id, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&updated) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::NotifyMobile {
            title,
            body,
            task_id,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = MobileNotificationRequest {
                title,
                body,
                task_id,
            };
            let delivery = notify_mobile_via_api(&base_url, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&delivery) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::SetWorkflow {
            task_id,
            workflow_name,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = SetTaskWorkflowRequest { workflow_name };
            let updated = set_task_workflow_via_api(&base_url, &task_id, &request)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&updated) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::ReplaceWorkflow {
            task_id,
            workflow_definition,
            expected_definition,
            source,
            machine_id,
            server_url,
        } => {
            let mut arg = vec![
                format!("task_id={task_id}"),
                format!("workflow_definition={workflow_definition}"),
                format!("expected_definition={expected_definition}"),
            ];
            if let Some(source) = source {
                arg.push(format!("source={source}"));
            }
            super::tool::run(crate::ToolCommands::Call {
                name: "kanna_replace_task_workflow".into(),
                json: None,
                arg,
                machine_id,
                server_url,
            })
            .await;
        }
        TaskCommands::WaitEvents {
            task_id,
            parent_task_id,
            repo_id,
            repo_remote_url_hash,
            exclude_task_id,
            exclude_event_type,
            include_self,
            local_only,
            include_current_activity,
            short_cursor,
            from,
            cursor,
            timeout_secs,
            limit,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let exclude_task_ids = resolve_task_event_exclusions(
                exclude_task_id,
                !task_id.is_empty() || parent_task_id.is_some(),
                include_self,
                current_task_id_from_env().as_deref(),
            );
            let params = crate::api::TaskEventsParams {
                task_ids: &task_id,
                parent_task_id: parent_task_id.as_deref(),
                repo_id: repo_id.as_deref(),
                repo_remote_url_hash: repo_remote_url_hash.as_deref(),
                exclude_task_ids: &exclude_task_ids,
                exclude_event_types: &exclude_event_type,
                local_only,
                include_current_activity,
                short_cursor,
                from: from.as_deref(),
                cursor: cursor.as_deref(),
                timeout_secs,
                limit,
            };
            let events = wait_task_events_via_api(&base_url, &params)
                .await
                .unwrap_or_else(|e| {
                    eprintln!("Error: {e}");
                    process::exit(1);
                });
            if let Err(e) = print_json(&events) {
                eprintln!("Error: {e}");
                process::exit(1);
            }
        }
        TaskCommands::Watch {
            task_id,
            repo_id,
            exclude_task_id,
            include_self,
            cursor,
            all_events,
            budget_secs,
            follow,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let exclude_task_ids = resolve_task_event_exclusions(
                exclude_task_id,
                !task_id.is_empty(),
                include_self,
                current_task_id_from_env().as_deref(),
            );
            let options = TaskWatchOptions {
                task_ids: task_id,
                repo_id,
                exclude_task_ids,
                cursor,
                all_events,
                budget_secs,
                follow,
            };
            if let Err(error) = watch_task_events(&base_url, options, &mut std::io::stdout()).await
            {
                eprintln!("Error: {error}");
                process::exit(1);
            }
        }
    }
}

fn bind_revision_request(request: &mut RequestRevisionRequest) -> Result<(), String> {
    if let Some(path) = std::env::var_os(kanna_tool_catalog::KANNA_COMPLETION_CONTEXT_ENV) {
        let context = kanna_tool_catalog::read_completion_context(std::path::Path::new(&path))?;
        request.run_id = Some(context.run_id);
    } else if let Ok(run_id) = std::env::var(kanna_tool_catalog::KANNA_STAGE_RUN_ID_ENV) {
        if !run_id.trim().is_empty() {
            request.run_id = Some(run_id);
        }
    }
    Ok(())
}
