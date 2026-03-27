export interface PipelineEnvironment {
  setup?: string[];
  teardown?: string[];
}

export interface PipelineStage {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string;
  environment?: string;
  transition: "manual" | "auto";
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
