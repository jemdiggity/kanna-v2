import { isAgentProvider, type AgentProvider } from "../config/agent-providers";

export interface PromptContext {
  taskPrompt?: string;
  prevResult?: string;
  branch?: string;
  baseRef?: string;
  sourceWorktree?: string;
}

export interface KannaRuntimeContext {
  taskId?: string;
  stage?: string;
  workflow?: string;
  /** Stage transition policy ("manual" | "auto"); defaults to manual like the Rust side. */
  transition?: string;
  /** How this stage was entered; legacy and initial contexts default to unspecified. */
  stageTrigger?: "auto" | "operator" | "manager" | "unspecified";
  /** Agent provider, used with mcpConfigured to describe MCP registration. */
  provider?: string;
  /** True when this session was launched with the Kanna MCP server registered. */
  mcpConfigured?: boolean;
}

// Canonical Kanna runtime guidance injected into every agent session.
// The source of truth is kanna-task-environment.md next to this file; the
// Rust task creator embeds that file via include_str!, and this constant
// must stay byte-identical to it (enforced by prompt-builder.test.ts).
export const KANNA_TASK_ENVIRONMENT_TEMPLATE = `## Kanna Task Environment

{{TASK_CONTEXT}}

This stage was entered by: {{STAGE_TRIGGER}}

Kanna is a desktop app that orchestrates coding agent tasks. Each task moves through the stages of a workflow (for example: in progress -> review -> pr). The task itself is durable — its id, run history, and blockers survive every stage, and \`KANNA_TASK_ID\` always holds that id — but each stage transition forks a fresh workspace: a new branch and worktree named \`task-<taskid>-<n>\` cut from the previous stage's committed tip. A workspace is an ephemeral manifestation of the task: the name carries the durable task id plus a per-workspace counter (the creation workspace is plain \`task-<taskid>\`). Only committed work crosses a stage boundary; uncommitted changes stay behind in the old worktree. You are the agent for the current stage. Do not move the task between stages yourself unless a prompt explicitly asks you to.

Rules:

- Work only in this worktree, on its current branch. Do not switch branches or touch the main checkout or other worktrees unless this stage's prompt says to.
- Do not push a branch or create a pull request unless this stage's prompt explicitly tells you to. Local commits are fine; publishing is usually a later workflow stage.
- If the repo's \`.kanna/config.json\` declares \`ports\`, this session's environment has each of those variables set to a port reserved for this task. Start dev servers and other services on the assigned ports so parallel tasks do not collide.
- You are not running inside a Kanna sandbox; use the normal shell and tools available in this worktree.
- Put temporary files and directories you create under \`.tmp/\` at the current worktree root, creating it as needed, so task cleanup can remove them together. Do not use the operating system's global \`/tmp\` for agent-created artifacts. This does not change paths managed by applications, test frameworks, or the operating system itself.
- Stop every background process you start before recording stage completion.

Kanna task operations (inspect tasks, create subtasks, send input to other tasks, record stage results):

- Prefer the \`kanna_*\` MCP tools when your agent client exposes them (for example \`kanna_get_task\`, \`kanna_complete_stage\`).
- {{MCP_STATUS}}
- If MCP tools are unavailable, fall back to the \`kanna-cli\` binary; it is on \`PATH\` and its full path is exported as \`KANNA_CLI_PATH\`.
- Run \`kanna-cli guide\` for live task state, workflow semantics, and the full tool catalog.
- This task's id is in the \`KANNA_TASK_ID\` environment variable. Use it for all task operations; it is stable across stages, unlike branch and worktree names.

{{COMPLETION}}`;

// Completion guidance depends on the stage's transition policy: only \`auto\`
// stages advance when the agent records a successful result; \`manual\` stages
// wait for the user to review and advance. Mirrors the completion constants in
// build_kanna_preamble (crates/kanna-server/src/task_creator/commands.rs) —
// keep the texts in sync.
const COMPLETION_GUIDANCE: Record<string, string> = {
  auto: 'This stage\'s transition is `auto`: when this stage\'s goal is achieved, record completion so Kanna can advance the workflow: call MCP `kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "..."}` (`task_id` is the value of the `KANNA_TASK_ID` env var); only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "..."`. If you are blocked or the goal cannot be met, record status `failure` with the reason instead of stopping silently.',
  manual:
    'This stage\'s transition is `manual`: recording a successful result does not advance the workflow — the user reviews your work and advances the stage themselves. When this stage\'s goal is achieved, finish with a clear summary of what you did; record completion only if this stage\'s prompt asks for it. If you are blocked or the goal cannot be met, record status `failure` with the reason instead of stopping silently: call MCP `kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "failure", "summary": "..."}` (`task_id` is the value of the `KANNA_TASK_ID` env var); only if MCP tools are unavailable, fall back to `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status failure --summary "..."`.',
};

export function buildKannaCompletionLine(context?: KannaRuntimeContext): string {
  return context?.transition === "auto" ? COMPLETION_GUIDANCE.auto : COMPLETION_GUIDANCE.manual;
}

// Mirrors build_kanna_preamble's context line in
// crates/kanna-server/src/task_creator/commands.rs — keep the formats in sync.
export function buildKannaTaskContextLine(context?: KannaRuntimeContext): string {
  let line = "This session was launched by Kanna";
  if (context?.taskId) {
    line += ` as task \`${context.taskId}\``;
  }
  if (context?.stage && context?.workflow) {
    line += `, stage \`${context.stage}\` of workflow \`${context.workflow}\``;
  }
  if (context?.transition) {
    line += ` (transition: \`${context.transition}\`)`;
  }
  return `${line}.`;
}

// Mirrors kanna_mcp_launch_line in
// crates/kanna-server/src/task_creator/commands.rs — keep the texts in sync.
const MCP_LAUNCH_LINES: Record<AgentProvider, string> = {
  claude:
    "Claude is launched with this config via `--mcp-config`, so Kanna MCP tools should be available automatically.",
  codex:
    "Codex is launched with Kanna MCP registration via `-c mcp_servers.kanna-mcp.*` overrides, so Kanna MCP tools should be available automatically.",
  copilot:
    "Copilot is launched with this config via `--additional-mcp-config`, so Kanna MCP tools should be available automatically.",
  opencode:
    "OpenCode is launched with Kanna MCP registration via `OPENCODE_CONFIG_CONTENT`, so Kanna MCP tools should be available automatically.",
  antigravity:
    "Antigravity CLI MCP registration is not wired because `agy 1.0.14` exposes no stable MCP flag or config surface; use the `kanna-cli` fallback for Kanna task operations.",
};

export function buildKannaMcpStatusLine(context?: KannaRuntimeContext): string | null {
  if (!context?.mcpConfigured || !isAgentProvider(context.provider)) return null;
  return MCP_LAUNCH_LINES[context.provider];
}

export function buildKannaRuntimeSystemPrompt(context?: KannaRuntimeContext): string {
  const mcpStatus = buildKannaMcpStatusLine(context);
  return KANNA_TASK_ENVIRONMENT_TEMPLATE.replace(
    "{{TASK_CONTEXT}}",
    buildKannaTaskContextLine(context)
  )
    .replace("{{STAGE_TRIGGER}}", context?.stageTrigger ?? "unspecified")
    .replace(mcpStatus ? "{{MCP_STATUS}}" : "- {{MCP_STATUS}}\n", mcpStatus ?? "")
    .replace("{{COMPLETION}}", buildKannaCompletionLine(context));
}

function hasOuterPromptSection(prompt: string): boolean {
  const firstContentLine = prompt.split(/\r?\n/).find((line) => line.trim() !== "")?.trim();
  return firstContentLine === "## Agent Instructions" || firstContentLine === "## Your Task";
}

// Joins the Kanna preamble and the task prompt into one message for providers
// without a native system-prompt channel. Stage composition owns its section
// labels; raw prompts receive compatibility framing when no outer section is
// present. Mirrors prompt_with_system_prompt in
// crates/kanna-agent-protocol/src/adapter.rs — keep the formats in sync.
export function buildKannaRuntimeUserPrompt(
  prompt: string,
  context?: KannaRuntimeContext
): string {
  const systemPrompt = buildKannaRuntimeSystemPrompt(context);
  if (prompt.trim() === "") return systemPrompt;

  const userPrompt = hasOuterPromptSection(prompt) ? prompt : `## Your Task\n\n${prompt}`;
  return `${systemPrompt}\n\n${userPrompt}`;
}

function substitutePromptVars(template: string, context: PromptContext): string {
  const values: Record<string, string> = {
    TASK_PROMPT: context.taskPrompt ?? "",
    PREV_RESULT: context.prevResult ?? "",
    BRANCH: context.branch ?? "",
    BASE_REF: context.baseRef ?? "",
    SOURCE_WORKTREE: context.sourceWorktree ?? "",
  };

  return template.replace(
    /\$(?:\{(TASK_PROMPT|PREV_RESULT|BRANCH|BASE_REF|SOURCE_WORKTREE)\}|(TASK_PROMPT|PREV_RESULT|BRANCH|BASE_REF|SOURCE_WORKTREE)(?![A-Za-z0-9_]))/g,
    (variable, bracedName: string | undefined, bareName: string | undefined) => {
      const name = bracedName ?? bareName;
      return name === undefined ? variable : values[name] ?? variable;
    }
  );
}

function buildPromptSection(
  heading: "## Agent Instructions" | "## Your Task",
  template: string,
  context: PromptContext
): string | undefined {
  const trimmedTemplate = template.trim();
  if (trimmedTemplate === "") return undefined;

  const body = substitutePromptVars(trimmedTemplate, context);
  return body.trim() === "" ? undefined : `${heading}\n\n${body}`;
}

export function buildStagePrompt(
  agentPrompt: string,
  stagePrompt: string | undefined,
  context: PromptContext
): string {
  const parts: string[] = [];
  const agentSection = buildPromptSection("## Agent Instructions", agentPrompt, context);
  if (agentSection !== undefined) parts.push(agentSection);

  if (stagePrompt !== undefined) {
    const taskSection = buildPromptSection("## Your Task", stagePrompt, context);
    if (taskSection !== undefined) parts.push(taskSection);
  }

  return parts.join("\n\n");
}
