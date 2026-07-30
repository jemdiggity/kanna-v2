import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface TaskModelSpawnCase {
  provider: string;
  model: string;
  ptyFlag: string;
}

const fixturePath = resolve(
  new URL("../../fixtures/task-model-spawn.json", import.meta.url).pathname,
);
const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as TaskModelSpawnCase[];

// The kanna-server task-creation tests consume this same fixture and exercise
// HTTP/task resolution through the daemon Spawn argv boundary. Keeping the
// provider CLI contract fixture here makes changes to either flag surface
// visible in the dedicated compatibility suite as well.
describe("created-task model spawn contract", () => {
  it("covers the required Claude and Codex provider mappings", () => {
    expect(cases.map(({ provider }) => provider)).toEqual(["claude", "codex"]);
    for (const contract of cases) {
      expect(contract.model.trim()).toBe(contract.model);
      expect(contract.model).not.toBe("");
      expect(contract.ptyFlag).toContain(contract.model);
    }
  });
});
