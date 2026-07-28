import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

// Hosted CI was removed: `ci.yml` and `remote-e2e.yml` are gone, and verification
// is local (`pnpm test`, `./kd test rust`) plus the Kanna review stage. The
// config-schema Pages workflow stays because it is continuous deployment of the
// public https://schemas.kanna.build/config.schema.json contract, not a check.
const CONFIG_SCHEMA_DEPLOYMENT = "config-schema-pages.yml";
const REMOVED_CI_WORKFLOWS = ["ci.yml", "remote-e2e.yml"];

function workflowFiles(): string[] {
  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

describe("GitHub Actions workflow set", () => {
  it("contains exactly the intended post-removal set", () => {
    expect(workflowFiles()).toEqual([CONFIG_SCHEMA_DEPLOYMENT]);
  });

  it("keeps the config-schema Pages deployment", () => {
    expect(workflowFiles()).toContain(CONFIG_SCHEMA_DEPLOYMENT);
  });

  it("does not reintroduce the removed CI workflows", () => {
    const workflows = workflowFiles();
    for (const removed of REMOVED_CI_WORKFLOWS) {
      expect(workflows, `${removed} must stay removed`).not.toContain(removed);
    }
  });
});
