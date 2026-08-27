import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanWorkspace } from "../src/runtime/clean";

const root = resolve(import.meta.dirname, "../../..");

describe("external build workspace teardown", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("removes the departed workspace build and preserves a live sibling", () => {
    const fixture = mkdtempSync(join(tmpdir(), "kd-external-teardown-"));
    fixtures.push(fixture);
    const volume = join(fixture, "external-volume");
    const externalRoot = join(volume, "kanna-builds", "kanna");
    const departed = join(fixture, "task-departed-2");
    const liveSibling = join(fixture, "task-live-3");
    const hook = join(fixture, "setup.local.sh");
    mkdirSync(volume);
    mkdirSync(departed);
    mkdirSync(liveSibling);
    for (const workspace of [departed, liveSibling]) {
      execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: workspace,
        stdio: "ignore"
      });
    }

    const template = readFileSync(join(root, ".kanna", "setup.local.sh.example"), "utf8");
    writeFileSync(
      hook,
      template
        .replace('external_volume="/path/to/external-volume"', `external_volume="${volume}"`)
        .replace(
          'external_build_root="$external_volume/kanna-builds/kanna"',
          `external_build_root="${externalRoot}"`
        )
    );
    execFileSync("/bin/sh", [hook], { cwd: departed, stdio: "pipe" });
    execFileSync("/bin/sh", [hook], { cwd: liveSibling, stdio: "pipe" });

    const departedBuild = join(externalRoot, "task-departed-2");
    const siblingBuild = join(externalRoot, "task-live-3");
    writeFileSync(join(departedBuild, "artifact.txt"), "remove");
    writeFileSync(join(siblingBuild, "artifact.txt"), "keep");

    cleanWorkspace({
      repoRoot: departed,
      homeDir: join(fixture, "home"),
      userName: "tester",
      all: true,
      dry: false,
      sharedRustBuild: false
    });

    expect(existsSync(departedBuild)).toBe(false);
    expect(existsSync(join(departed, ".build"))).toBe(false);
    expect(readFileSync(join(siblingBuild, "artifact.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(liveSibling, ".build"))).toBe(true);
  });
});
