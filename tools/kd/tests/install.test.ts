import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseRepoSlug } from "../src/runtime/release";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function installerRepo(): string {
  const script = readFileSync(resolve(repoRoot, "scripts", "install.sh"), "utf8");
  const match = script.match(/^REPO="([^"]+)"$/m);

  expect(match, "scripts/install.sh must declare a quoted REPO constant").not.toBeNull();
  return match?.[1] ?? "";
}

describe("install script", () => {
  it("downloads from the repository published by the origin remote", () => {
    const originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(installerRepo()).toBe(releaseRepoSlug(originUrl));
  });

  it("keeps the documented one-line installer on the same repository", () => {
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");

    expect(readme).toContain(
      `https://raw.githubusercontent.com/${installerRepo()}/main/scripts/install.sh`,
    );
  });
});
