import type { PipelineDefinition, PipelineStage, PipelineStagePolicy } from "./pipeline-types";

function formatRawValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function validationError(message: string): Error {
  return new Error(`Pipeline validation failed:\n  - ${message}`);
}

function parseTransition(
  value: unknown,
  describeInvalid: (value: string) => string
): PipelineStagePolicy["transition"] {
  if (value === "manual" || value === "auto") {
    return value;
  }

  throw validationError(describeInvalid(formatRawValue(value)));
}

function parseStageExecution(
  value: unknown,
  stageName: string,
): PipelineStagePolicy["execution"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "continue") {
    return "continue";
  }
  if (value === "new_task") return undefined;
  if (typeof value !== "string") return undefined;

  throw validationError(
    `Stage "${stageName}" has invalid execution "${value}"; must be "continue"`
  );
}

function parseStagePolicy(raw: Record<string, unknown>, stageName: string): PipelineStagePolicy {
  const policy = raw["policy"];
  if (policy !== undefined) {
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
      throw validationError(`Stage "${stageName}" has invalid policy "${formatRawValue(policy)}"; must be an object`);
    }
    const p = policy as Record<string, unknown>;
    const parsed: PipelineStagePolicy = {
      transition: parseTransition(
        p["transition"],
        (transition) =>
          `Stage "${stageName}" has invalid policy.transition "${transition}"; must be "manual" or "auto"`
      ),
    };
    const execution = parseStageExecution(p["execution"], stageName);
    if (execution !== undefined) parsed.execution = execution;
    return parsed;
  }

  const parsed: PipelineStagePolicy = {
    transition: parseTransition(
      raw["transition"],
      (transition) =>
        `Stage "${stageName}" has invalid transition "${transition}"; must be "manual" or "auto"`
    ),
  };
  const execution = parseStageExecution(raw["mode"], stageName);
  if (execution !== undefined) parsed.execution = execution;
  return parsed;
}

/**
 * Validate a PipelineDefinition and return a list of validation error messages.
 * An empty array means the definition is valid.
 */
export function validatePipeline(def: PipelineDefinition): string[] {
  const errors: string[] = [];

  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("Pipeline name is required and must be a non-empty string");
  }

  if (!Array.isArray(def.stages) || def.stages.length === 0) {
    errors.push("Pipeline stages is required and must be a non-empty array");
    // Return early — further stage checks are meaningless without stages
    return errors;
  }

  const seenNames = new Set<string>();
  for (const stage of def.stages) {
    if (!stage.name || typeof stage.name !== "string" || stage.name.trim() === "") {
      errors.push("Each stage must have a non-empty string name");
    } else if (seenNames.has(stage.name)) {
      errors.push(`Duplicate stage name: "${stage.name}"`);
    } else {
      seenNames.add(stage.name);
    }

    if (stage.policy?.transition !== "manual" && stage.policy?.transition !== "auto") {
      errors.push(
        `Stage "${stage.name ?? "(unnamed)"}" has invalid policy.transition "${stage.policy?.transition as string}"; must be "manual" or "auto"`
      );
    }

    if (
      stage.policy?.execution !== undefined &&
      stage.policy.execution !== "continue"
    ) {
      errors.push(
        `Stage "${stage.name ?? "(unnamed)"}" has invalid policy.execution "${stage.policy.execution as string}"; must be "continue"`
      );
    }

    if (stage.environment !== undefined) {
      const envMap = def.environments ?? {};
      if (!Object.prototype.hasOwnProperty.call(envMap, stage.environment)) {
        errors.push(
          `Stage "${stage.name}" references environment "${stage.environment}" which does not exist in the environments map`
        );
      }
    }
  }

  return errors;
}

/**
 * Parse a raw JSON string into a validated PipelineDefinition.
 * Throws an Error if the JSON is malformed or validation fails.
 */
export function parsePipelineJson(raw: string): PipelineDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Pipeline definition must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Build a PipelineDefinition from the raw object, preserving optional fields
  const stages = extractStages(obj);
  const def: PipelineDefinition = {
    name: typeof obj["name"] === "string" ? obj["name"] : "",
    stages,
  };

  if (typeof obj["description"] === "string") {
    def.description = obj["description"];
  }

  if (obj["environments"] !== undefined && obj["environments"] !== null) {
    if (typeof obj["environments"] === "object" && !Array.isArray(obj["environments"])) {
      def.environments = obj["environments"] as Record<string, { setup?: string[]; teardown?: string[] }>;
    }
  }

  const errors = validatePipeline(def);
  if (errors.length > 0) {
    throw new Error(`Pipeline validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return def;
}

type LegacyPostAction = {
  name: string;
  description?: string;
  agent?: string;
  prompt?: string;
  agent_provider?: string | string[];
  transition: PipelineStagePolicy["transition"];
};

function extractLegacyPostAction(value: unknown, stageName: string): LegacyPostAction | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  const postAction: LegacyPostAction = {
    name,
    transition: parseTransition(
      raw["transition"],
      (transition) =>
        `Stage "${stageName}" has post_action "${name || "(unnamed)"}" with invalid transition "${transition}"; must be "manual" or "auto"`
    ),
  };

  if (typeof raw["description"] === "string") {
    postAction.description = raw["description"];
  }
  if (typeof raw["agent"] === "string") {
    postAction.agent = raw["agent"];
  }
  if (typeof raw["prompt"] === "string") {
    postAction.prompt = raw["prompt"];
  }
  if (
    typeof raw["agent_provider"] === "string" ||
    (Array.isArray(raw["agent_provider"]) && raw["agent_provider"].every((entry) => typeof entry === "string"))
  ) {
    postAction.agent_provider = raw["agent_provider"] as string | string[];
  }

  return postAction;
}

function extractStages(obj: Record<string, unknown>): PipelineStage[] {
  if (!Array.isArray(obj["stages"])) {
    return [];
  }

  return (obj["stages"] as unknown[]).flatMap((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Stage at index ${index} must be an object`);
    }
    const s = item as Record<string, unknown>;
    const name = typeof s["name"] === "string" ? s["name"] : "";

    const stage: PipelineStage = {
      name,
      policy: parseStagePolicy(s, name || "(unnamed)"),
    };

    if (typeof s["description"] === "string") {
      stage.description = s["description"];
    }
    if (typeof s["agent"] === "string") {
      stage.agent = s["agent"];
    }
    if (typeof s["prompt"] === "string") {
      stage.prompt = s["prompt"];
    }
    if (
      typeof s["agent_provider"] === "string" ||
      (Array.isArray(s["agent_provider"]) && s["agent_provider"].every((entry) => typeof entry === "string"))
    ) {
      stage.agent_provider = s["agent_provider"] as string | string[];
    }
    if (typeof s["environment"] === "string") {
      stage.environment = s["environment"];
    }
    const stages = [stage];
    const postAction = extractLegacyPostAction(s["post_action"], stage.name || "(unnamed)");
    if (postAction) {
      stages.push({
        name: postAction.name,
        ...(postAction.description !== undefined ? { description: postAction.description } : {}),
        ...(postAction.agent !== undefined ? { agent: postAction.agent } : {}),
        ...(postAction.prompt !== undefined ? { prompt: postAction.prompt } : {}),
        ...(postAction.agent_provider !== undefined ? { agent_provider: postAction.agent_provider } : {}),
        ...(stage.environment !== undefined ? { environment: stage.environment } : {}),
        policy: { transition: postAction.transition, execution: "continue" },
      });
    }

    return stages;
  });
}
