import type { AgentProvider } from "@kanna/agent-protocol";

export interface WorkflowEnvironment {
  setup?: string[];
  teardown?: string[];
}

export interface WorkflowStagePolicy {
  transition: "manual" | "auto";
  revision_transition?: "manual" | "auto";
}

/**
 * Tail work of a stage, injected into the stage's running agent session when
 * the stage transitions forward. `agent` is the fallback used to spawn a
 * fresh session when the task's session is dead.
 */
export interface WorkflowPost {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  /**
   * Compact provider selectors (`provider[-model[-effort]]`, e.g. `claude`,
   * `codex-sol`, `claude-fable-hi`) — validated by the loader via
   * `parseAgentProviderSelector`; entries keep their written form.
   */
  agent_provider?: string | string[];
}

export interface WorkflowStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  /**
   * Compact provider selectors (`provider[-model[-effort]]`, e.g. `claude`,
   * `codex-sol`, `claude-fable-hi`) — validated by the loader via
   * `parseAgentProviderSelector`; entries keep their written form.
   */
  agent_provider?: string | string[];
  environment?: string;
  policy: WorkflowStagePolicy;
  post?: WorkflowPost;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  environments?: Record<string, WorkflowEnvironment>;
  stages: WorkflowStage[];
  /**
   * Agent-requested revision rounds a task may spend before Kanna stops
   * forking revisions and parks the task for its human. Omitted means the
   * engine default (3); 0 disables the cap. Enforced server-side by
   * `request_revision`.
   */
  revision_limit?: number;
}

export interface AgentDefinition {
  name: string;
  description: string;
  agent_provider?: AgentProvider | AgentProvider[];
  model?: string;
  effort?: string;
  permission_mode?: "default" | "acceptEdits" | "dontAsk";
  allowed_tools?: string[];
  prompt: string; // markdown body
}

/**
 * A repo-local extension (`.kanna/agents/{name}/EXTEND.md`) layered onto the
 * resolved agent definition — the repo's own AGENT.md override or the bundled
 * built-in. The body is appended to the base prompt; frontmatter fields
 * replace the base's when present. The agent's identity (name) comes from the
 * directory, so an extension cannot rename the agent.
 */
export interface AgentExtension {
  description?: string;
  agent_provider?: AgentProvider | AgentProvider[];
  model?: string;
  effort?: string;
  permission_mode?: "default" | "acceptEdits" | "dontAsk";
  allowed_tools?: string[];
  prompt: string; // markdown body appended to the base prompt
}

export interface StageCompleteResult {
  status: "success" | "failure";
  summary: string;
  metadata?: Record<string, unknown>;
}
