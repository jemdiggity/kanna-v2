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
  agent_provider?: string | string[];
}

export interface PipelineStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string | string[];
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
  agent_provider?: string | string[];
  model?: string;
  permission_mode?: "default" | "acceptEdits" | "dontAsk";
  allowed_tools?: string[];
  prompt: string; // markdown body
}

export interface StageCompleteResult {
  status: "success" | "failure";
  summary: string;
  metadata?: Record<string, unknown>;
}
