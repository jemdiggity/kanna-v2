use std::process;

use serde_json::Value;

use crate::api::{
    advance_stage_via_api, block_task_via_api, close_task_via_api, create_task_via_api,
    dependent_tasks_exist_via_api, get_task_via_api, get_task_with_agent_view_via_api,
    list_repo_tasks_via_api, list_task_children_via_api, list_tasks_via_api,
    list_tasks_with_options_via_api, notify_mobile_via_api, parse_wait_until, rename_task_via_api,
    request_revision_via_api, rerun_stage_via_api, resume_task_via_api, search_tasks_via_api,
    search_tasks_with_options_via_api, send_task_input_via_api, set_task_notify_via_api,
    set_task_parent_via_api, set_task_workflow_via_api, signal_merge_handoff_via_api,
    task_inputs_via_api, task_logs_with_agent_view_via_api, unblock_task_via_api,
    wait_task_events_via_api, wait_task_via_api, WaitTaskOutcome,
};
use crate::commands::{parse_metadata_json, print_json};
use crate::config::resolve_server_base_url_from_env;
use crate::models::{
    BlockTaskRequest, CreateTaskRequest, MergeHandoffRequest, MobileNotificationRequest,
    RequestRevisionRequest, SetTaskNotifyRequest, SetTaskParentRequest, SetTaskWorkflowRequest,
    TaskCreateOptions, TaskDetail, TaskInputRequest, TaskRenameRequest, TaskStatusRow, TaskSummary,
};
use crate::TaskCommands;
use kanna_tool_catalog::{wait_resolved_result, wait_timeout_result};

pub(crate) fn build_create_task_request(options: TaskCreateOptions) -> CreateTaskRequest {
    CreateTaskRequest {
        repo_id: options.repo_id,
        prompt: options.prompt,
        display_name: options.display_name,
        workflow_name: options.workflow_name,
        base_ref: options.base_ref,
        agent: options.agent,
        agent_provider: options.agent_provider,
        agent_type: options.agent_type.or_else(|| Some("pty".to_string())),
        model: options.model,
        effort: options.effort,
        permission_mode: options.permission_mode,
        allowed_tools: (!options.allowed_tool.is_empty()).then_some(options.allowed_tool),
        blocker_task_ids: (!options.blocker_task_id.is_empty()).then_some(options.blocker_task_id),
        notify_task_id: options.notify_task,
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
            all_machines,
            include_closed,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            if let Some(repo_id) = repo_id {
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
            } else if all_machines || include_closed {
                let tasks =
                    list_tasks_with_options_via_api(&base_url, all_machines, include_closed)
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
            all_machines,
            include_closed,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            if all_machines || include_closed {
                let tasks = search_tasks_with_options_via_api(
                    &base_url,
                    &query,
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
            agent,
            agent_provider,
            agent_type,
            model,
            effort,
            permission_mode,
            allowed_tool,
            blocker_task_id,
            notify_task,
            parent_task,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = build_create_task_request(TaskCreateOptions {
                repo_id,
                prompt,
                display_name,
                workflow_name,
                base_ref,
                agent,
                agent_provider,
                agent_type,
                model,
                effort,
                permission_mode,
                allowed_tool,
                blocker_task_id,
                notify_task,
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
            let request =
                build_request_revision_request(target_stage, summary, prompt, metadata_value);
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
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let advanced = advance_stage_via_api(&base_url, &task_id)
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
        TaskCommands::SetNotify {
            task_id,
            notify_task,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let request = SetTaskNotifyRequest {
                notify_task_id: notify_task,
            };
            let updated = set_task_notify_via_api(&base_url, &task_id, &request)
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
        TaskCommands::WaitEvents {
            task_id,
            parent_task_id,
            repo_id,
            repo_remote_url_hash,
            local_only,
            include_current_activity,
            short_cursor,
            cursor,
            timeout_secs,
            limit,
            server_url,
        } => {
            let base_url = resolve_server_base_url_from_env(server_url.as_deref());
            let params = crate::api::TaskEventsParams {
                task_ids: &task_id,
                parent_task_id: parent_task_id.as_deref(),
                repo_id: repo_id.as_deref(),
                repo_remote_url_hash: repo_remote_url_hash.as_deref(),
                local_only,
                include_current_activity,
                short_cursor,
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
    }
}
