import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const workflowsDir = resolve(repoRoot, ".github/workflows");

describe("GitHub workflow inventory", () => {
  it("keeps publishing automation but no hosted verification", () => {
    expect(
      readdirSync(workflowsDir)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort(),
    ).toEqual(["config-schema-pages.yml"]);

    const pages = readFileSync(
      resolve(workflowsDir, "config-schema-pages.yml"),
      "utf8",
    );
    expect(pages).toContain("name: Config Schema Pages");
    expect(pages).toContain("actions/deploy-pages@v4");
  });
});
