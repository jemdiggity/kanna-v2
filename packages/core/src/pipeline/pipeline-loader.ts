import type { PipelineDefinition, PipelineStage } from "./pipeline-types";

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
): PipelineStage["transition"] {
  if (value === "manual" || value === "auto") {
    return value;
  }

  throw validationError(describeInvalid(formatRawValue(value)));
}

function parseStageMode(
  value: unknown,
  stageName: string
): PipelineStage["mode"] | undefined {
  if (value === undefined || typeof value !== "string") {
    return undefined;
  }
  if (value === "new_task" || value === "continue") {
    return value;
  }

  throw validationError(
    `Stage "${stageName}" has invalid mode "${value}"; must be "new_task" or "continue"`
  );
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

    if (stage.transition !== "manual" && stage.transition !== "auto") {
      errors.push(
        `Stage "${stage.name ?? "(unnamed)"}" has invalid transition "${stage.transition as string}"; must be "manual" or "auto"`
      );
    }

    if (
      stage.mode !== undefined &&
      stage.mode !== "new_task" &&
      stage.mode !== "continue"
    ) {
      errors.push(
        `Stage "${stage.name ?? "(unnamed)"}" has invalid mode "${stage.mode as string}"; must be "new_task" or "continue"`
      );
    }

    if (stage.post_action !== undefined) {
      if (!stage.post_action.name || typeof stage.post_action.name !== "string" || stage.post_action.name.trim() === "") {
        errors.push(`Stage "${stage.name ?? "(unnamed)"}" has post_action with missing name`);
      }
      if (stage.post_action.transition !== "manual" && stage.post_action.transition !== "auto") {
        errors.push(
          `Stage "${stage.name ?? "(unnamed)"}" has post_action "${stage.post_action.name ?? "(unnamed)"}" with invalid transition "${stage.post_action.transition as string}"; must be "manual" or "auto"`
        );
      }
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

function extractPostAction(value: unknown, stageName: string): PipelineStage["post_action"] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  const postAction: PipelineStage["post_action"] = {
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

  return (obj["stages"] as unknown[]).map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Stage at index ${index} must be an object`);
    }
    const s = item as Record<string, unknown>;
    const name = typeof s["name"] === "string" ? s["name"] : "";

    const stage: PipelineStage = {
      name,
      transition: parseTransition(
        s["transition"],
        (transition) =>
          `Stage "${name || "(unnamed)"}" has invalid transition "${transition}"; must be "manual" or "auto"`
      ),
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
    if (typeof s["agent_provider"] === "string") {
      stage.agent_provider = s["agent_provider"];
    }
    if (typeof s["environment"] === "string") {
      stage.environment = s["environment"];
    }
    if (typeof s["follow_task"] === "boolean") {
      stage.follow_task = s["follow_task"];
    }
    const mode = parseStageMode(s["mode"], stage.name || "(unnamed)");
    if (mode !== undefined) {
      stage.mode = mode;
    }
    const postAction = extractPostAction(s["post_action"], stage.name || "(unnamed)");
    if (postAction) {
      stage.post_action = postAction;
    }

    return stage;
  });
}
