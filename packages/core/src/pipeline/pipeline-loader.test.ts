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
