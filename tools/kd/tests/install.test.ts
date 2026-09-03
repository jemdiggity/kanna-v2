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

function updaterEndpoints(): string[] {
  const tauriConfig = readFileSync(
    resolve(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"),
    "utf8",
  );
  const desktopBuild = readFileSync(
    resolve(repoRoot, "apps", "desktop", "src-tauri", "BUILD.bazel"),
    "utf8",
  );
  const productionMatch = tauriConfig.match(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/latest\.json/,
  );
  const stagingMatch = desktopBuild.match(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/desktop-staging\/latest-staging\.json/,
  );

  expect(
    productionMatch,
    "tauri.conf.json must declare the production updater endpoint",
  ).not.toBeNull();
  expect(
    stagingMatch,
    "BUILD.bazel must stamp the staging updater endpoint",
  ).not.toBeNull();
  return [productionMatch?.[0] ?? "", stagingMatch?.[0] ?? ""];
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

  it("keeps both desktop updater channels on the canonical release repository", () => {
    const originUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const releaseRepo = releaseRepoSlug(originUrl);

    expect(updaterEndpoints()).toEqual([
      `https://github.com/${releaseRepo}/releases/latest/download/latest.json`,
      `https://github.com/${releaseRepo}/releases/download/desktop-staging/latest-staging.json`,
    ]);
  });
});
