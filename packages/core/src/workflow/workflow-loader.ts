import type {
  WorkflowDefinition,
  WorkflowPost,
  WorkflowStage,
  WorkflowStagePolicy,
} from "./workflow-types";
import { parseAgentProviderSelector } from "../config/agent-providers";

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
  return new Error(`Workflow validation failed:\n  - ${message}`);
}

function parseAgentProviderSelection(
  value: unknown,
  location: string,
): string | string[] | undefined {
  if (value === undefined) return undefined;

  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : null;

  if (!values || values.length === 0) {
    throw validationError(`${location} has an invalid agent_provider value`);
  }

  // Entries are compact provider selectors (`provider[-model[-effort]]`,
  // e.g. `claude`, `codex-sol`, `claude-fable-hi`); they keep their written
  // form — the server derives each candidate's model/effort at spawn time.
  const invalid = values.filter(
    (provider) => parseAgentProviderSelector(provider) === null,
  );
  if (invalid.length > 0) {
    throw validationError(
      `${location} has unsupported agent_provider values: ${invalid.join(", ")}`,
    );
  }

  return typeof value === "string" ? values[0] : values;
}

function parseTransition(
  value: unknown,
  describeInvalid: (value: string) => string
): WorkflowStagePolicy["transition"] {
  if (value === "manual" || value === "auto") {
    return value;
  }

  throw validationError(describeInvalid(formatRawValue(value)));
}

/**
 * Legacy `execution` / `mode` markers. `"continue"` folds the stage into the
 * preceding stage's `post` (stages swap sessions; posts continue them);
 * anything else is ignored.
 */
function parseLegacyContinueMarker(value: unknown, stageName: string): boolean {
  if (value === undefined || value === "new_task") {
    return false;
  }
  if (value === "continue") {
    return true;
  }
  if (typeof value !== "string") return false;

  throw validationError(
    `Stage "${stageName}" has invalid execution "${value}"; must be "continue"`
  );
}

interface ParsedStagePolicy {
  policy: WorkflowStagePolicy;
  legacyContinue: boolean;
}

function parseStagePolicy(raw: Record<string, unknown>, stageName: string): ParsedStagePolicy {
  const policy = raw["policy"];
  if (policy !== undefined) {
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
      throw validationError(`Stage "${stageName}" has invalid policy "${formatRawValue(policy)}"; must be an object`);
    }
    const p = policy as Record<string, unknown>;
    const revisionTransition = p["revision_transition"] === undefined
      ? undefined
      : parseTransition(
          p["revision_transition"],
          (transition) =>
            `Stage "${stageName}" has invalid policy.revision_transition "${transition}"; must be "manual" or "auto"`
        );
    return {
      policy: {
        transition: parseTransition(
          p["transition"],
          (transition) =>
            `Stage "${stageName}" has invalid policy.transition "${transition}"; must be "manual" or "auto"`
        ),
        ...(revisionTransition === undefined
          ? {}
          : { revision_transition: revisionTransition }),
      },
      legacyContinue: parseLegacyContinueMarker(p["execution"], stageName),
    };
  }

  return {
    policy: {
      transition: parseTransition(
        raw["transition"],
        (transition) =>
          `Stage "${stageName}" has invalid transition "${transition}"; must be "manual" or "auto"`
      ),
    },
    legacyContinue: parseLegacyContinueMarker(raw["mode"], stageName),
  };
}

/**
 * Validate a WorkflowDefinition and return a list of validation error messages.
 * An empty array means the definition is valid.
 */
export function validateWorkflow(def: WorkflowDefinition): string[] {
  const errors: string[] = [];

  if (!def.name || typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("Workflow name is required and must be a non-empty string");
  }

  if (!Array.isArray(def.stages) || def.stages.length === 0) {
    errors.push("Workflow stages is required and must be a non-empty array");
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
      stage.policy?.revision_transition !== undefined &&
      stage.policy.revision_transition !== "manual" &&
      stage.policy.revision_transition !== "auto"
    ) {
      errors.push(
        `Stage "${stage.name ?? "(unnamed)"}" has invalid policy.revision_transition "${stage.policy.revision_transition as string}"; must be "manual" or "auto"`
      );
    }

    if (stage.post !== undefined) {
      if (!stage.post.name || typeof stage.post.name !== "string" || stage.post.name.trim() === "") {
        errors.push(`Stage "${stage.name ?? "(unnamed)"}" has a post without a non-empty string name`);
      } else if (seenNames.has(stage.post.name)) {
        errors.push(`Duplicate stage name: "${stage.post.name}"`);
      } else {
        seenNames.add(stage.post.name);
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
 * Parse a raw JSON string into a validated WorkflowDefinition.
 * Throws an Error if the JSON is malformed or validation fails.
 */
export function parseWorkflowJson(raw: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow definition must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Build a WorkflowDefinition from the raw object, preserving optional fields
  const stages = extractStages(obj);
  const def: WorkflowDefinition = {
    name: typeof obj["name"] === "string" ? obj["name"] : "",
    stages,
  };

  if (typeof obj["description"] === "string") {
    def.description = obj["description"];
  }

  if (obj["revision_limit"] !== undefined && obj["revision_limit"] !== null) {
    const limit = obj["revision_limit"];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
      throw validationError(
        `Workflow "${def.name}" has an invalid revision_limit ${formatRawValue(limit)}; must be a non-negative integer`
      );
    }
    def.revision_limit = limit;
  }

  if (obj["environments"] !== undefined && obj["environments"] !== null) {
    if (typeof obj["environments"] === "object" && !Array.isArray(obj["environments"])) {
      def.environments = obj["environments"] as Record<string, { setup?: string[]; teardown?: string[] }>;
    }
  }

  const errors = validateWorkflow(def);
  if (errors.length > 0) {
    throw new Error(`Workflow validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return def;
}

function extractPost(value: unknown, stageName: string): WorkflowPost | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const name = typeof raw["name"] === "string" ? raw["name"] : "";
  if (!name) {
    throw validationError(`Stage "${stageName}" has a post without a non-empty string name`);
  }
  const post: WorkflowPost = { name };

  if (typeof raw["description"] === "string") {
    post.description = raw["description"];
  }
  if (typeof raw["agent"] === "string") {
    post.agent = raw["agent"];
  }
  if (typeof raw["prompt"] === "string") {
    post.prompt = raw["prompt"];
  }
  const agentProvider = parseAgentProviderSelection(
    raw["agent_provider"],
    `Post "${name}" on stage "${stageName}"`,
  );
  if (agentProvider !== undefined) {
    post.agent_provider = agentProvider;
  }

  return post;
}

function extractStages(obj: Record<string, unknown>): WorkflowStage[] {
  if (!Array.isArray(obj["stages"])) {
    return [];
  }

  const stages: WorkflowStage[] = [];
  for (const [index, item] of (obj["stages"] as unknown[]).entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Stage at index ${index} must be an object`);
    }
    const s = item as Record<string, unknown>;
    const name = typeof s["name"] === "string" ? s["name"] : "";
    const { policy, legacyContinue } = parseStagePolicy(s, name || "(unnamed)");

    // Legacy interleaved continue stage (old post_action compilation or an
    // `execution: "continue"` policy, including pinned pipeline_def
    // snapshots): fold into the preceding stage's post.
    if (legacyContinue) {
      const previous = stages[stages.length - 1];
      if (previous && previous.post === undefined) {
        const folded: WorkflowPost = { name };
        if (typeof s["description"] === "string") folded.description = s["description"];
        if (typeof s["agent"] === "string") folded.agent = s["agent"];
        if (typeof s["prompt"] === "string") folded.prompt = s["prompt"];
        const agentProvider = parseAgentProviderSelection(
          s["agent_provider"],
          `Stage "${name || "(unnamed)"}"`,
        );
        if (agentProvider !== undefined) {
          folded.agent_provider = agentProvider;
        }
        previous.post = folded;
        continue;
      }
    }

    const stage: WorkflowStage = {
      name,
      policy,
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
    const agentProvider = parseAgentProviderSelection(
      s["agent_provider"],
      `Stage "${name || "(unnamed)"}"`,
    );
    if (agentProvider !== undefined) {
      stage.agent_provider = agentProvider;
    }
    if (typeof s["environment"] === "string") {
      stage.environment = s["environment"];
    }

    const post = extractPost(s["post"], stage.name || "(unnamed)");
    if (post) {
      stage.post = post;
    } else {
      // Legacy `post_action` declarations become the stage's post directly.
      const legacyPost = extractPost(s["post_action"], stage.name || "(unnamed)");
      if (legacyPost) {
        stage.post = legacyPost;
      }
    }

    stages.push(stage);
  }

  return stages;
}
