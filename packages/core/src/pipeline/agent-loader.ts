import type { AgentDefinition, AgentExtension } from "./pipeline-types";
import { parseFrontmatter } from "../config/custom-tasks";
import {
  VALID_AGENT_PROVIDERS,
  isAgentProvider,
  splitAgentProviderValue,
  type AgentProvider,
} from "../config/agent-providers";

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
    `permission_mode must be one of: ${VALID_PERMISSION_MODES.join(", ")} (got "${value}")`
  );
}

function parseAgentProviders(value: unknown): AgentProvider[] | undefined {
  const providers = splitAgentProviderValue(value);
  if (providers.length === 0) return undefined;

  const invalid = providers.filter((provider) => !isAgentProvider(provider));
  if (invalid.length > 0) {
    throw new Error(
      `agent_provider must be one of: ${VALID_AGENT_PROVIDERS.join(", ")} (got "${invalid.join(", ")}")`,
    );
  }

  return providers.filter(isAgentProvider);
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
    const agentProviders = parseAgentProviders(fm.agent_provider);
    if (agentProviders !== undefined) {
      def.agent_provider = agentProviders;
    }
  }

  const errors = validateAgentDefinition(def);
  if (errors.length > 0) {
    throw new Error(`Invalid AGENT.md: ${errors.join("; ")}`);
  }

  return def;
}

// An extension (`.kanna/agents/{name}/EXTEND.md`) customizes the resolved
// agent — repo override or built-in — without a total rewrite: its body is
// appended to the base prompt and its frontmatter fields replace the base's.
// Frontmatter is optional; a plain markdown file is a pure prompt extension.
export function parseAgentExtension(content: string): AgentExtension {
  const { frontmatter, body } = parseFrontmatter(content);

  const fm: Record<string, unknown> = frontmatter ?? {};
  const ext: AgentExtension = { prompt: body.trim() };

  if (typeof fm.description === "string") {
    ext.description = fm.description;
  }

  if (typeof fm.model === "string") {
    ext.model = fm.model;
  }

  const permissionMode = parsePermissionMode(fm.permission_mode);
  if (permissionMode !== undefined) {
    ext.permission_mode = permissionMode;
  }

  if (Array.isArray(fm.allowed_tools) && fm.allowed_tools.every((t: unknown) => typeof t === "string")) {
    ext.allowed_tools = fm.allowed_tools as string[];
  }

  if (fm.agent_provider !== undefined) {
    const agentProviders = parseAgentProviders(fm.agent_provider);
    if (agentProviders !== undefined) {
      ext.agent_provider = agentProviders;
    }
  }

  return ext;
}

export function applyAgentExtension(base: AgentDefinition, extension: AgentExtension): AgentDefinition {
  const merged: AgentDefinition = {
    ...base,
    ...(extension.description !== undefined && { description: extension.description }),
    ...(extension.model !== undefined && { model: extension.model }),
    ...(extension.permission_mode !== undefined && { permission_mode: extension.permission_mode }),
    ...(extension.allowed_tools !== undefined && { allowed_tools: extension.allowed_tools }),
    ...(extension.agent_provider !== undefined && { agent_provider: extension.agent_provider }),
  };

  if (extension.prompt !== "") {
    merged.prompt = base.prompt === "" ? extension.prompt : `${base.prompt}\n\n${extension.prompt}`;
  }

  const errors = validateAgentDefinition(merged);
  if (errors.length > 0) {
    throw new Error(`Invalid extended agent: ${errors.join("; ")}`);
  }

  return merged;
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
