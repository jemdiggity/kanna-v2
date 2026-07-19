import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Kanna repository cache defaults", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const config = JSON.parse(readFileSync(resolve(root, ".kanna/config.json"), "utf8"));

  it("warms after environment sync in every Kanna-managed worktree", () => {
    expect(config.setup).toEqual(["pnpm install", "./kd env sync", "./kd rust-cache warm"]);
  });

  it("keeps teardown on private workspace cleanup", () => {
    expect(config.teardown).toEqual(["./kd dev down --kill-daemon", "./kd clean --all"]);
  });

  it("does not add Kanache to release configuration", () => {
    expect(JSON.stringify(config)).not.toContain("release ship");
    const releaseSource = readFileSync(
      resolve(root, "tools/kd/src/runtime/release.ts"),
      "utf8"
    );
    expect(releaseSource).not.toContain("rust-cache");
    expect(releaseSource).not.toContain("kanache");
  });
});
