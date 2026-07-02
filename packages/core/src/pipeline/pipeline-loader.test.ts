import { describe, it, expect } from "vitest";
import { parsePipelineJson, validatePipeline } from "./pipeline-loader";

describe("parsePipelineJson", () => {
  it("parses valid pipeline JSON", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [
        { name: "Stage 1", transition: "manual" },
        { name: "Stage 2", transition: "auto" },
      ],
    });
    const result = parsePipelineJson(json);
    expect(result.name).toBe("My Pipeline");
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0].name).toBe("Stage 1");
    expect(result.stages[1].transition).toBe("auto");
  });

  it("rejects missing name", () => {
    const json = JSON.stringify({
      stages: [{ name: "Stage 1", transition: "manual" }],
    });
    expect(() => parsePipelineJson(json)).toThrow();
  });

  it("rejects empty stages array", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [],
    });
    expect(() => parsePipelineJson(json)).toThrow();
  });

  it("rejects duplicate stage names", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [
        { name: "Stage 1", transition: "manual" },
        { name: "Stage 1", transition: "auto" },
      ],
    });
    expect(() => parsePipelineJson(json)).toThrow();
  });

  it("rejects invalid transition value", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Stage 1", transition: "invalid" }],
    });
    expect(() => parsePipelineJson(json)).toThrow();
  });

  it("reports missing transition as undefined instead of an empty string", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Stage 1" }],
    });

    expect(() => parsePipelineJson(json)).toThrow(/invalid transition "undefined"/);
  });

  it("validates environment references exist", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Stage 1", transition: "manual", environment: "nonexistent" }],
    });
    expect(() => parsePipelineJson(json)).toThrow();
  });

  it("accepts pipeline with environments", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      environments: {
        production: { setup: ["echo setup"], teardown: ["echo teardown"] },
      },
      stages: [{ name: "Stage 1", transition: "manual", environment: "production" }],
    });
    const result = parsePipelineJson(json);
    expect(result.environments?.["production"]).toBeDefined();
    expect(result.stages[0].environment).toBe("production");
  });

  it("accepts stage with optional fields omitted", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Stage 1", transition: "auto" }],
    });
    const result = parsePipelineJson(json);
    const stage = result.stages[0];
    expect(stage.description).toBeUndefined();
    expect(stage.agent).toBeUndefined();
    expect(stage.prompt).toBeUndefined();
    expect(stage.agent_provider).toBeUndefined();
    expect(stage.environment).toBeUndefined();
  });

  it("parses follow_task when explicitly false", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "PR", transition: "manual", follow_task: false }],
    });

    const result = parsePipelineJson(json);

    expect(result.stages[0].follow_task).toBe(false);
  });

  it("parses follow_task when explicitly true", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Stage 1", transition: "manual", follow_task: true }],
    });

    const result = parsePipelineJson(json);

    expect(result.stages[0].follow_task).toBe(true);
  });

  it("ignores non-boolean follow_task values", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Stage 1", transition: "manual", follow_task: "nope" }],
    });

    const result = parsePipelineJson(json);

    expect(result.stages[0].follow_task).toBeUndefined();
  });

  it("parses continue mode when explicitly set", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Commit", transition: "auto", mode: "continue" }],
    });

    const result = parsePipelineJson(json);

    expect(result.stages[0].mode).toBe("continue");
  });

  it("ignores non-string mode values", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Commit", transition: "auto", mode: true }],
    });

    const result = parsePipelineJson(json);

    expect(result.stages[0].mode).toBeUndefined();
  });

  it("rejects invalid stage mode values", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "Commit", transition: "auto", mode: "sideways" }],
    });

    expect(() => parsePipelineJson(json)).toThrow(/invalid mode "sideways"/);
  });

  it("compiles a stage post_action into an interleaved auto stage", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: {
            name: "commit",
            description: "Commit the relevant work",
            agent: "commit",
            prompt: "Commit $TASK_PROMPT",
            agent_provider: ["codex", "claude"],
            transition: "auto",
          },
        },
        { name: "pr", transition: "manual" },
      ],
    });

    const result = parsePipelineJson(json);

    expect(result.stages.map((stage) => stage.name)).toEqual(["in progress", "commit", "pr"]);
    expect(result.stages[0].post_action).toBeUndefined();
    expect(result.stages[1]).toEqual({
      name: "commit",
      description: "Commit the relevant work",
      agent: "commit",
      prompt: "Commit $TASK_PROMPT",
      agent_provider: ["codex", "claude"],
      transition: "auto",
    });
    expect(result.stages[2].name).toBe("pr");
  });

  it("reports missing post_action transition as undefined instead of an empty string", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [
        {
          name: "in progress",
          transition: "manual",
          post_action: {
            name: "commit",
          },
        },
      ],
    });

    expect(() => parsePipelineJson(json)).toThrow(/invalid transition "undefined"/);
  });

  it("ignores non-object post_action values", () => {
    const json = JSON.stringify({
      name: "My Pipeline",
      stages: [{ name: "in progress", transition: "manual", post_action: "commit" }],
    });

    const result = parsePipelineJson(json);

    expect(result.stages[0].post_action).toBeUndefined();
  });
});

describe("validatePipeline", () => {
  it("returns empty array for valid pipeline", () => {
    const pipeline = {
      name: "Valid Pipeline",
      stages: [{ name: "Stage 1", transition: "manual" as const }],
    };
    expect(validatePipeline(pipeline)).toEqual([]);
  });

  it("returns error for missing name", () => {
    const pipeline = {
      name: "",
      stages: [{ name: "Stage 1", transition: "manual" as const }],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("returns error for empty stages", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("stage"))).toBe(true);
  });

  it("returns error for duplicate stage names", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [
        { name: "Dup", transition: "manual" as const },
        { name: "Dup", transition: "auto" as const },
      ],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("duplicate") || e.includes("Dup"))).toBe(true);
  });

  it("returns error for invalid transition", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [{ name: "Stage 1", transition: "bad" as "manual" | "auto" }],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns error for invalid mode", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [{ name: "Commit", transition: "auto" as const, mode: "sideways" as "continue" }],
    };

    const errors = validatePipeline(pipeline);

    expect(errors.some((error) => error.includes("mode"))).toBe(true);
  });

  it("returns error for post_action without a name", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [
        {
          name: "in progress",
          transition: "manual" as const,
          post_action: { name: "", transition: "auto" as const },
        },
      ],
    };

    const errors = validatePipeline(pipeline);

    expect(errors.some((error) => error.includes("post_action") && error.includes("name"))).toBe(true);
  });

  it("returns error for invalid post_action transition", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [
        {
          name: "in progress",
          transition: "manual" as const,
          post_action: { name: "commit", transition: "sideways" as "auto" },
        },
      ],
    };

    const errors = validatePipeline(pipeline);

    expect(errors.some((error) => error.includes("post_action") && error.includes("transition"))).toBe(true);
  });

  it("returns error for undefined environment reference", () => {
    const pipeline = {
      name: "Pipeline",
      stages: [{ name: "Stage 1", transition: "manual" as const, environment: "missing" }],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("missing") || e.includes("environment"))).toBe(true);
  });

  it("returns multiple errors when multiple issues exist", () => {
    const pipeline = {
      name: "",
      stages: [],
    };
    const errors = validatePipeline(pipeline);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
