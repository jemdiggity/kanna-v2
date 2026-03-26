import { parse as parseYaml } from "yaml";
export type Stage = "in_progress" | "pr" | "merge" | "done";

export interface CustomTaskConfig {
  name: string;
  description?: string;
  agentProvider?: "claude" | "copilot";
  model?: string;
  permissionMode?: "dontAsk" | "acceptEdits" | "default";
  executionMode?: "pty" | "sdk";
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  setup?: string[];
  teardown?: string[];
  stage?: Stage;
  prompt: string;
}

export interface CustomTaskScanResult {
  tasks: CustomTaskConfig[];
  errors: Array<{ path: string; error: string }>;
}

export const NEW_CUSTOM_TASK_PROMPT = `You are helping the user define a custom agent task for Kanna.

Custom tasks are reusable agent configurations stored at .kanna/tasks/<taskname>/agent.md.
The file uses YAML frontmatter for configuration and markdown body for the agent prompt.

Guide the user through defining their custom task by asking about:
1. What the task should do (name, description, purpose)
2. What instructions the agent should follow (the prompt)
3. Configuration options they want to set

Available frontmatter fields (all optional, defaults shown):
- name: Display name (default: derived from directory name)
- description: Short description for the command palette
- agent_provider: "claude" | "copilot" (default: claude)
- model: null (uses Kanna default)
- permission_mode: "dontAsk" | "acceptEdits" | "default" (default: dontAsk)
- execution_mode: "pty" | "sdk" (default: pty)
- allowed_tools: [] (empty = all allowed)
- disallowed_tools: []
- max_turns: null (unlimited)
- max_budget_usd: null (unlimited)
- setup: [] (commands run before the agent)
- teardown: [] (commands run after task closes)
- stage: "in_progress" (default)

Once you understand what they want, create the directory and write the agent.md file
at .kanna/tasks/<taskname>/agent.md. Use a lowercase hyphenated directory name.`;

const VALID_AGENT_PROVIDERS = ["claude", "copilot"] as const;
const VALID_PERMISSION_MODES = ["dontAsk", "acceptEdits", "default"] as const;
const VALID_EXECUTION_MODES = ["pty", "sdk"] as const;
const VALID_STAGES = ["in_progress", "pr", "merge", "done"] as const;

function slugToDisplayName(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null | undefined; body: string } {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: null, body: content };
  }

  const yamlStr = match[1] ?? "";
  const body = match[2];

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlStr);
  } catch {
    return { frontmatter: undefined, body: "" };
  }

  if (parsed === null || parsed === undefined) {
    return { frontmatter: {}, body };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { frontmatter: undefined, body: "" };
  }

  return { frontmatter: parsed as Record<string, unknown>, body };
}

export function parseAgentMd(content: string, dirName: string): CustomTaskConfig | null {
  if (!content || !content.trim()) {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(content);

  // null frontmatter means malformed YAML
  if (frontmatter === undefined) {
    return null;
  }

  const prompt = body.trim();

  // If there's no frontmatter and no meaningful prompt, return null
  if (!prompt && !frontmatter) {
    return null;
  }

  // If we have frontmatter but no prompt after it, return null
  if (!prompt) {
    return null;
  }

  const fm = frontmatter ?? {};

  const config: CustomTaskConfig = {
    name: typeof fm.name === "string" ? fm.name : slugToDisplayName(dirName),
    prompt,
  };

  if (typeof fm.description === "string") {
    config.description = fm.description;
  }

  if (typeof fm.model === "string") {
    config.model = fm.model;
  }

  if (typeof fm.agent_provider === "string" && (VALID_AGENT_PROVIDERS as readonly string[]).includes(fm.agent_provider)) {
    config.agentProvider = fm.agent_provider as CustomTaskConfig["agentProvider"];
  }

  if (typeof fm.permission_mode === "string" && (VALID_PERMISSION_MODES as readonly string[]).includes(fm.permission_mode)) {
    config.permissionMode = fm.permission_mode as CustomTaskConfig["permissionMode"];
  }

  if (typeof fm.execution_mode === "string" && (VALID_EXECUTION_MODES as readonly string[]).includes(fm.execution_mode)) {
    config.executionMode = fm.execution_mode as CustomTaskConfig["executionMode"];
  }

  if (Array.isArray(fm.allowed_tools) && fm.allowed_tools.every((t: unknown) => typeof t === "string")) {
    config.allowedTools = fm.allowed_tools as string[];
  }

  if (Array.isArray(fm.disallowed_tools) && fm.disallowed_tools.every((t: unknown) => typeof t === "string")) {
    config.disallowedTools = fm.disallowed_tools as string[];
  }

  if (typeof fm.max_turns === "number" && Number.isFinite(fm.max_turns)) {
    config.maxTurns = fm.max_turns;
  }

  if (typeof fm.max_budget_usd === "number" && Number.isFinite(fm.max_budget_usd)) {
    config.maxBudgetUsd = fm.max_budget_usd;
  }

  if (Array.isArray(fm.setup) && fm.setup.every((s: unknown) => typeof s === "string")) {
    config.setup = fm.setup as string[];
  }

  if (Array.isArray(fm.teardown) && fm.teardown.every((s: unknown) => typeof s === "string")) {
    config.teardown = fm.teardown as string[];
  }

  if (typeof fm.stage === "string" && (VALID_STAGES as readonly string[]).includes(fm.stage)) {
    config.stage = fm.stage as CustomTaskConfig["stage"];
  }

  return config;
}
