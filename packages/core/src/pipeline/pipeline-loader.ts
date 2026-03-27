import type { PipelineDefinition, PipelineStage } from "./pipeline-types";

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

function extractStages(obj: Record<string, unknown>): PipelineStage[] {
  if (!Array.isArray(obj["stages"])) {
    return [];
  }

  return (obj["stages"] as unknown[]).map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Stage at index ${index} must be an object`);
    }
    const s = item as Record<string, unknown>;

    const stage: PipelineStage = {
      name: typeof s["name"] === "string" ? s["name"] : "",
      transition: (s["transition"] as "manual" | "auto") ?? "",
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

    return stage;
  });
}
