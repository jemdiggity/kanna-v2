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
      reserved_port_offsets: [0, 1],
      reserved_ports: [5432, 6379],
    }));
    expect(config.setup).toEqual(["bun install", "./scripts/seed.sh"]);
    expect(config.teardown).toEqual(["./scripts/cleanup.sh"]);
    expect(config.ports).toEqual({ PORT: 3000, API_PORT: 8000 });
    expect(config.reserved_port_offsets).toEqual([0, 1]);
    expect(config.reserved_ports).toEqual([5432, 6379]);
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

  it("ignores malformed reserved port entries", () => {
    const config = parseRepoConfig(JSON.stringify({
      reserved_port_offsets: [0, "bad", -1, 1.5, 2],
      reserved_ports: [5432, "bad", 0, 65536, 6379],
    }));

    expect(config.reserved_port_offsets).toEqual([0, 2]);
    expect(config.reserved_ports).toEqual([5432, 6379]);
  });

  it("throws for invalid JSON", () => {
    expect(() => parseRepoConfig("not json")).toThrow();
  });

  it("ignores unknown top-level keys", () => {
    const config = parseRepoConfig(JSON.stringify({ unknown: true, setup: ["ls"] }));
    expect(config.setup).toEqual(["ls"]);
    expect("unknown" in config).toBe(false);
  });

  it("parses agent flavors and AGENT.md vars", () => {
    const config = parseRepoConfig(JSON.stringify({
      flavors: {
        pr: "draft-pr",
        merge: "github",
      },
      vars: {
        REVIEW_TEAM: "platform",
        MERGE_STRATEGY: "merge",
      },
    }));

    expect(config.flavors).toEqual({
      pr: "draft-pr",
      merge: "github",
    });
    expect(config.vars).toEqual({
      REVIEW_TEAM: "platform",
      MERGE_STRATEGY: "merge",
    });
  });

  it("parses repo agent provider and model preferences", () => {
    const config = parseRepoConfig(JSON.stringify({
      agentProviders: {
        review: "codex",
        "review-*": {
          provider: ["codex", "claude"],
          model: "gpt-5",
        },
      },
    }));

    expect(config.agentProviders).toEqual({
      review: { provider: ["codex"] },
      "review-*": {
        provider: ["codex", "claude"],
        model: "gpt-5",
      },
    });
  });

  it("ignores malformed repo agent provider preferences", () => {
    const config = parseRepoConfig(JSON.stringify({
      agentProviders: {
        review: "future-agent",
        "review-*": { provider: ["codex", 42] },
        "": "claude",
        implement: { model: "missing-provider" },
        commit: "claude",
      },
    }));

    expect(config.agentProviders).toEqual({
      commit: { provider: ["claude"] },
    });
  });

  it("ignores malformed agent flavor and var entries", () => {
    const config = parseRepoConfig(JSON.stringify({
      flavors: {
        pr: "draft-pr",
        merge: 42,
      },
      vars: {
        REVIEW_TEAM: "platform",
        MERGE_STRATEGY: false,
      },
    }));

    expect(config.flavors).toEqual({ pr: "draft-pr" });
    expect(config.vars).toEqual({ REVIEW_TEAM: "platform" });
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
