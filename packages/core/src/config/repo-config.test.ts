// packages/core/src/config/repo-config.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_STAGE_ORDER, parseRepoConfig } from "./repo-config.js";

describe("parseRepoConfig", () => {
  it("omits commit from the built-in stage display order", () => {
    expect(DEFAULT_STAGE_ORDER).toEqual(["pr", "review", "in progress"]);
    expect(DEFAULT_STAGE_ORDER).not.toContain("commit");
    expect(DEFAULT_STAGE_ORDER).not.toContain("merge");
  });

  it("parses a full config", () => {
    const config = parseRepoConfig(JSON.stringify({
      setup: ["bun install", "./scripts/seed.sh"],
      teardown: ["./scripts/cleanup.sh"],
      ports: { PORT: 3000, API_PORT: 8000 },
    }));
    expect(config.setup).toEqual(["bun install", "./scripts/seed.sh"]);
    expect(config.teardown).toEqual(["./scripts/cleanup.sh"]);
    expect(config.ports).toEqual({ PORT: 3000, API_PORT: 8000 });
  });

  it("returns empty config for empty JSON object", () => {
    expect(parseRepoConfig("{}")).toEqual({});
  });

  it("handles missing fields", () => {
    const config = parseRepoConfig(JSON.stringify({ ports: { PORT: 3000 } }));
    expect(config.setup).toBeUndefined();
    expect(config.teardown).toBeUndefined();
    expect(config.ports).toEqual({ PORT: 3000 });
  });

  it("ignores setup if not an array of strings", () => {
    const config = parseRepoConfig(JSON.stringify({ setup: "not-an-array" }));
    expect(config.setup).toBeUndefined();
  });

  it("ignores teardown if not an array of strings", () => {
    const config = parseRepoConfig(JSON.stringify({ teardown: 123 }));
    expect(config.teardown).toBeUndefined();
  });

  it("ignores setup with mixed types in array", () => {
    const config = parseRepoConfig(JSON.stringify({ setup: ["valid", 123] }));
    expect(config.setup).toBeUndefined();
  });

  it("ignores ports with non-number values", () => {
    const config = parseRepoConfig(JSON.stringify({
      ports: { PORT: 3000, BAD: "not-a-number" },
    }));
    expect(config.ports).toEqual({ PORT: 3000 });
  });

  it("returns empty config for empty ports object", () => {
    const config = parseRepoConfig(JSON.stringify({ ports: {} }));
    expect(config.ports).toBeUndefined();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseRepoConfig("not json")).toThrow();
  });

  it("ignores unknown top-level keys", () => {
    const config = parseRepoConfig(JSON.stringify({ unknown: true, setup: ["ls"] }));
    expect(config.setup).toEqual(["ls"]);
    expect((config as any).unknown).toBeUndefined();
  });

  it("parses test scripts", () => {
    const config = parseRepoConfig(JSON.stringify({
      test: ["bun test", "cargo test"],
    }));
    expect(config.test).toEqual(["bun test", "cargo test"]);
  });

  it("ignores test if not an array of strings", () => {
    const config = parseRepoConfig(JSON.stringify({ test: "not-an-array" }));
    expect(config.test).toBeUndefined();
  });

  it("ignores test with mixed types in array", () => {
    const config = parseRepoConfig(JSON.stringify({ test: ["valid", 123] }));
    expect(config.test).toBeUndefined();
  });

  it("parses stage_order", () => {
    const config = parseRepoConfig(JSON.stringify({
      stage_order: ["merge", "pr", "in progress"],
    }));
    expect(config.stage_order).toEqual(["merge", "pr", "in progress"]);
  });

  it("parses workspace env and path config", () => {
    const config = parseRepoConfig(JSON.stringify({
      workspace: {
        env: {
          FOO: "bar",
          BAZ: "qux",
        },
        path: {
          prepend: ["./bin"],
          append: ["/usr/local/custom"],
        },
      },
    }));

    expect(config.workspace).toEqual({
      env: {
        FOO: "bar",
        BAZ: "qux",
      },
      path: {
        prepend: ["./bin"],
        append: ["/usr/local/custom"],
      },
    });
  });

  it("ignores malformed workspace env and path entries", () => {
    const config = parseRepoConfig(JSON.stringify({
      workspace: {
        env: {
          GOOD: "ok",
          BAD: 42,
        },
        path: {
          prepend: ["./bin", 1],
          append: "nope",
        },
      },
    }));

    expect(config.workspace).toEqual({
      env: {
        GOOD: "ok",
      },
      path: {
        prepend: ["./bin"],
      },
    });
  });

  it("ignores stage_order if not an array of strings", () => {
    const config = parseRepoConfig(JSON.stringify({ stage_order: "not-an-array" }));
    expect(config.stage_order).toBeUndefined();
  });

  it("ignores stage_order with mixed types in array", () => {
    const config = parseRepoConfig(JSON.stringify({ stage_order: ["merge", 42] }));
    expect(config.stage_order).toBeUndefined();
  });
});
