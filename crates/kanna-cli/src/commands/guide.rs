use std::env;
use std::process;

use kanna_tool_catalog::Catalog;
use serde::Serialize;
use serde_json::Value;

use crate::api::get_task_via_api;
use crate::config::{resolve_guide_task_id, resolve_server_base_url};
use crate::models::TaskDetail;

#[derive(Debug, Clone)]
pub(crate) struct GuideContext {
    pub(crate) task_id: String,
    pub(crate) task: Option<TaskDetail>,
    pub(crate) live_state_error: Option<String>,
    pub(crate) catalog: Catalog,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuideTool<'a> {
    name: &'a str,
    description: &'a str,
}

const EVENT_SUPERVISION_GUIDANCE: [&str; 4] = [
    "`task.awaiting_input` is a confirmed interactive prompt detected by the daemon; it is the strong signal that the agent needs an answer. `kanna_send_task_input` delivers only to a live session: `no_live_agent_session` requires resume or rerun recovery, while `delivery_uncertain` must not be retried blindly.",
    "`task.activity_changed` is the provider-neutral fallback, fired on the blended `activity` display value moving from working to idle or unread — not on the runtime dimension. Confirm the current task with `kanna_get_task` and read `runtimeState`, then inspect `waitingPromptSnippet` when present; this transition is not proof that the snippet is a question. Without MCP, long-poll with `kanna-cli tool call kanna_wait_events --json '<arguments>'`.",
    "a task's state has two dimensions: `runtimeState` (`busy` | `waiting` | `idle` | `exited`) is what its agent session is doing, and `readState` (`read` | `unread`) is whether a human has read its latest output. `activity` blends both for display and cannot answer either alone — an agent busy inside a long call whose output nobody read reads `unread`, exactly like a finished one. Decide whether a task is alive from `runtimeState`.",
    "prompt-only changes while a task remains stopped are visible only by polling task detail with `kanna_get_task` (or its CLI equivalent); they do not append another event.",
];

fn guide_tools(catalog: &Catalog) -> Vec<GuideTool<'_>> {
    catalog
        .tools
        .iter()
        .map(|tool| GuideTool {
            name: &tool.name,
            description: &tool.description,
        })
        .collect()
}

pub(crate) fn render_guide_markdown(context: &GuideContext) -> String {
    let task = context.task.as_ref();
    let stage = task
        .and_then(|task| task.stage.as_deref())
        .unwrap_or("unknown");
    let workflow = task
        .and_then(|task| task.workflow_name.as_deref())
        .unwrap_or("unknown");
    let transition = task
        .and_then(|task| task.stage_transition.as_deref())
        .unwrap_or("manual");
    let branch = task
        .and_then(|task| task.branch.as_deref())
        .unwrap_or("unknown");

    let completion_line = if transition == "auto" {
        "Done here means this stage has achieved its goal. Prefer `kanna_complete_stage` to record completion. Fallback: `kanna-cli stage-complete --task-id \"$KANNA_TASK_ID\" --status success --summary \"...\"`."
    } else {
        "Done here means this stage has achieved its goal. This stage's transition is `manual`: the user advances the workflow after reviewing your work — record completion only if this stage's prompt asks for it, and record `failure` if you are blocked."
    };
    let mut lines = vec![
        "# Kanna Task Guide".to_string(),
        String::new(),
        format!(
            "You are task `{}`, stage `{}` of workflow `{}` (`{}`). Branch: `{}`.",
            context.task_id, stage, workflow, transition, branch
        ),
        completion_line.to_string(),
    ];

    if let Some(error) = context.live_state_error.as_deref() {
        lines.push(String::new());
        lines.push(format!(
            "Live task state was unavailable: {error}. The catalog and workflow manual below are still generated from the bundled Kanna tool catalog."
        ));
    }

    lines.extend([
        String::new(),
        "## Workflow Semantics".to_string(),
        String::new(),
        "- Prefer `kanna-mcp` tools for Kanna task operations; fall back to the instance-local `kanna-cli` from the shell only when MCP tools are unavailable. Kanna-spawned tasks export `KANNA_CLI_PATH` and prepend its directory to `PATH`.".to_string(),
        "- Prefer `kanna_complete_stage` to record stage completion. Fallback: `kanna-cli stage-complete`. `success` can trigger an auto-transition when the current stage is configured for auto; `failure` stops advancement.".to_string(),
        "- Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to do so. Auto stages finish by recording stage completion so Kanna can advance the configured workflow.".to_string(),
        "- Manual transitions wait for a user or agent to request advancement.".to_string(),
        "- Advancing follows the next stage policy: continue stages reuse the current task, worktree, branch, and agent session; other stages create a next-stage task in a new worktree and close the source task after successful spawn.".to_string(),
        "- Use create/spawn-subtask tools for follow-up work, `kanna_send_input` for feedback to a running task, `kanna_request_revision` for a new revision task from an existing branch, and blocker tools when this task depends on another task.".to_string(),
        format!("- {}", EVENT_SUPERVISION_GUIDANCE[0]),
        format!("- {}", EVENT_SUPERVISION_GUIDANCE[1]),
        format!("- {}", EVENT_SUPERVISION_GUIDANCE[2]),
        format!("- {}", EVENT_SUPERVISION_GUIDANCE[3]),
        String::new(),
        "## Catalog Tools".to_string(),
        String::new(),
    ]);

    for tool in &context.catalog.tools {
        lines.push(format!("- `{}`: {}", tool.name, tool.description));
    }

    lines.join("\n")
}

pub(crate) fn render_guide_json(context: &GuideContext) -> Result<Value, String> {
    serde_json::to_value(serde_json::json!({
        "taskId": context.task_id,
        "liveStateError": context.live_state_error,
        "task": context.task,
        "workflow": {
            "completeStage": "Prefer kanna_complete_stage. Fallback to kanna-cli stage-complete only when MCP tools are unavailable. success can trigger auto-advance; failure stops advancement",
            "prBoundary": "Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to do so",
            "manualTransition": "manual stages wait for explicit advancement",
            "advanceStage": "advancing follows the next stage policy: continue stages reuse the current task and session; other stages create a next-stage task and close the source task after successful spawn",
            "eventSupervision": EVENT_SUPERVISION_GUIDANCE,
            "operations": [
                "prefer kanna-mcp tools for Kanna task operations",
                "fall back to the instance-local kanna-cli only when MCP tools are unavailable",
                "send input to running tasks",
                "request revisions from existing task branches",
                "block and unblock tasks"
            ]
        },
        "tools": guide_tools(&context.catalog),
    }))
    .map_err(|e| format!("failed to render guide json: {e}"))
}

pub(crate) async fn build_guide_context(
    env_pairs: &[(&str, &str)],
    explicit_server_url: Option<&str>,
) -> GuideContext {
    let catalog = kanna_tool_catalog::bundled_catalog();
    let task_id = resolve_guide_task_id(env_pairs).unwrap_or_else(|| "unknown".to_string());
    if task_id == "unknown" {
        return GuideContext {
            task_id,
            task: None,
            live_state_error: Some("KANNA_TASK_ID is not set".to_string()),
            catalog,
        };
    }

    let base_url = resolve_server_base_url(env_pairs, explicit_server_url);
    match get_task_via_api(&base_url, &task_id).await {
        Ok(task) => GuideContext {
            task_id,
            task: Some(task),
            live_state_error: None,
            catalog,
        },
        Err(error) => GuideContext {
            task_id,
            task: None,
            live_state_error: Some(error),
            catalog,
        },
    }
}

pub(crate) async fn run_guide_command<W: std::io::Write>(
    json: bool,
    server_url: Option<&str>,
    env_pairs: &[(&str, &str)],
    output: &mut W,
) -> Result<(), String> {
    let context = build_guide_context(env_pairs, server_url).await;
    if json {
        let rendered = render_guide_json(&context)?;
        serde_json::to_writer_pretty(&mut *output, &rendered)
            .map_err(|e| format!("failed to render json: {e}"))?;
        writeln!(output).map_err(|e| format!("failed to write guide: {e}"))?;
    } else {
        writeln!(output, "{}", render_guide_markdown(&context))
            .map_err(|e| format!("failed to write guide: {e}"))?;
    }
    Ok(())
}

pub(crate) async fn run(json: bool, server_url: Option<&str>) {
    let env_pairs = env::vars().collect::<Vec<_>>();
    let borrowed_pairs = env_pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    let mut stdout = std::io::stdout();
    if let Err(e) = run_guide_command(json, server_url, &borrowed_pairs, &mut stdout).await {
        eprintln!("Error: {e}");
        process::exit(1);
    }
}
