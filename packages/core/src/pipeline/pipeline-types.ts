import type { AgentProvider } from "@kanna/agent-protocol";

export interface PipelineEnvironment {
  setup?: string[];
  teardown?: string[];
}

export interface PipelineStagePolicy {
  transition: "manual" | "auto";
}

/**
 * Tail work of a stage, injected into the stage's running agent session when
 * the stage transitions forward. `agent` is the fallback used to spawn a
 * fresh session when the task's session is dead.
 */
export interface PipelinePost {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: AgentProvider | AgentProvider[];
}

export interface PipelineStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: AgentProvider | AgentProvider[];
  environment?: string;
  policy: PipelineStagePolicy;
  post?: PipelinePost;
}

export interface PipelineDefinition {
  name: string;
  description?: string;
  environments?: Record<string, PipelineEnvironment>;
  stages: PipelineStage[];
}

export interface AgentDefinition {
  name: string;
  description: string;
  agent_provider?: AgentProvider | AgentProvider[];
  model?: string;
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
  permission_mode?: "default" | "acceptEdits" | "dontAsk";
  allowed_tools?: string[];
  prompt: string; // markdown body appended to the base prompt
}

export interface StageCompleteResult {
  status: "success" | "failure";
  summary: string;
  metadata?: Record<string, unknown>;
}
