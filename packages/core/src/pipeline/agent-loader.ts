import type { AgentDefinition } from "./pipeline-types";
import { parseFrontmatter } from "../config/custom-tasks";
import { VALID_AGENT_PROVIDERS, isAgentProvider, splitAgentProviderValue } from "../config/agent-providers";

const VALID_PERMISSION_MODES = ["default", "acceptEdits", "dontAsk"] as const;
type PermissionMode = AgentDefinition["permission_mode"];

function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if ((VALID_PERMISSION_MODES as readonly string[]).includes(value)) {
    return value as PermissionMode;
  }

  throw new Error(
    `Invalid AGENT.md: permission_mode must be one of: ${VALID_PERMISSION_MODES.join(", ")} (got "${value}")`
  );
}

// An agent definition (`.kanna/agents/*/AGENT.md`) describes a reusable *role* and
// intentionally supports a focused field set: name, description, prompt (body),
// model, permission_mode, allowed_tools, and agent_provider. Per-task execution
// limits (execution_mode, max_turns, max_budget_usd, disallowed_tools) and
// worktree setup/teardown live on task templates (`.kanna/tasks/*/agent.md`, parsed
// by parseAgentMd), not on agent definitions. Keep this boundary in mind before
// widening the agent schema.
export function parseAgentDefinition(content: string): AgentDefinition {
  const { frontmatter, body } = parseFrontmatter(content);

  const fm: Record<string, unknown> = frontmatter ?? {};
  const prompt = body.trim();

  const def: AgentDefinition = {
    name: typeof fm.name === "string" ? fm.name : "",
    description: typeof fm.description === "string" ? fm.description : "",
    prompt,
  };

  if (typeof fm.model === "string") {
    def.model = fm.model;
  }

  const permissionMode = parsePermissionMode(fm.permission_mode);
  if (permissionMode !== undefined) {
    def.permission_mode = permissionMode;
  }

  if (Array.isArray(fm.allowed_tools) && fm.allowed_tools.every((t: unknown) => typeof t === "string")) {
    def.allowed_tools = fm.allowed_tools as string[];
  }

  // agent_provider: YAML array, single string, or comma-separated string.
  if (fm.agent_provider !== undefined) {
    const providers = splitAgentProviderValue(fm.agent_provider);
    if (providers.length > 0) {
      def.agent_provider = providers;
    }
  }

  const errors = validateAgentDefinition(def);
  if (errors.length > 0) {
    throw new Error(`Invalid AGENT.md: ${errors.join("; ")}`);
  }

  return def;
}

export function validateAgentDefinition(def: AgentDefinition): string[] {
  const errors: string[] = [];

  if (typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("name is required and must be a non-empty string");
  }

  if (typeof def.description !== "string" || def.description.trim() === "") {
    errors.push("description is required and must be a non-empty string");
  }

  if (def.prompt !== undefined && typeof def.prompt !== "string") {
    errors.push("prompt (AGENT.md body) must be a string");
  }

  if (
    def.permission_mode !== undefined &&
    !(VALID_PERMISSION_MODES as readonly string[]).includes(def.permission_mode)
  ) {
    errors.push(
      `permission_mode must be one of: ${VALID_PERMISSION_MODES.join(", ")} (got "${def.permission_mode}")`
    );
  }

  if (def.agent_provider !== undefined) {
    const providers = Array.isArray(def.agent_provider) ? def.agent_provider : [def.agent_provider];
    const invalid = providers.filter((p) => !isAgentProvider(p));
    if (invalid.length > 0) {
      errors.push(
        `agent_provider must be one of: ${VALID_AGENT_PROVIDERS.join(", ")} (got "${invalid.join(", ")}")`
      );
    }
  }

  return errors;
}
