import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface TaskEffortSpawnCase {
  provider: string;
  effort: string;
  ptyFlag: string;
}

const fixturePath = resolve(
  new URL("../../fixtures/task-effort-spawn.json", import.meta.url).pathname,
);
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as TaskEffortSpawnCase[];

// The kanna-server task-creation tests consume this fixture through the full
// provider-resolution -> PTY argv boundary.
describe("created-task reasoning effort spawn contract", () => {
  it("pins every provider's native effort control", () => {
    expect(cases.map(({ provider }) => provider)).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
      "antigravity",
    ]);
    expect(cases.find(({ provider }) => provider === "codex")).toEqual({
      provider: "codex",
      effort: "max",
      ptyFlag: "-c 'model_reasoning_effort=\"max\"'",
    });
    for (const contract of cases) {
      expect(contract.effort.trim()).toBe(contract.effort);
      expect(contract.effort).not.toBe("");
      expect(contract.ptyFlag).toContain(contract.effort);
    }
  });
});
