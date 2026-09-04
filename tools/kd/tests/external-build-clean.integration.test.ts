import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanWorkspace } from "../src/runtime/clean";
import { migrateLegacyExternalWorkspaceBuild } from "../src/runtime/env-sync";
import type { CommandRunner } from "../src/runtime/process";

function bazelRunner(outputBase: string): CommandRunner {
  return {
    async run() {
      return { exitCode: 0, stdout: `${outputBase}\n`, stderr: "" };
    }
  };
}

describe("external build workspace teardown", () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("migrates an installed legacy hook before fallback, then cleans only the departed workspace", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "kd-external-teardown-"));
    fixtures.push(fixture);
    const volume = join(fixture, "external-volume");
    const unmountedVolume = join(fixture, "external-volume-unmounted");
    const externalRoot = join(volume, "kanna-builds", "kanna");
    const departed = join(fixture, "task-departed-2");
    const liveSibling = join(fixture, "task-live-3");
    const legacyHook = join(fixture, "setup.local.sh");
    mkdirSync(volume);
    mkdirSync(departed);
    mkdirSync(liveSibling);
    for (const workspace of [departed, liveSibling]) {
      execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: workspace,
        stdio: "ignore"
      });
    }

    // This is the behavior of the already-installed pre-upgrade hook: when the
    // external volume is unavailable, it replaces its dangling .build link
    // without first writing the durable target record introduced later.
    writeFileSync(
      legacyHook,
      [
        "#!/bin/sh",
        'if [ -L "$PWD/.build" ] && [ ! -e "$PWD/.build" ]; then',
        '  rm "$PWD/.build" && mkdir "$PWD/.build"',
        "fi",
        ""
      ].join("\n")
    );

    const departedBuild = join(externalRoot, "task-departed-2");
    const siblingBuild = join(externalRoot, "task-live-3");
    const departedRecord = join(departed, ".kanna-external-build-target");
    const siblingRecord = join(liveSibling, ".kanna-external-build-target");
    mkdirSync(departedBuild, { recursive: true });
    mkdirSync(siblingBuild, { recursive: true });
    symlinkSync(departedBuild, join(departed, ".build"));
    symlinkSync(siblingBuild, join(liveSibling, ".build"));
    writeFileSync(join(departedBuild, "artifact.txt"), "remove");
    writeFileSync(join(siblingBuild, "artifact.txt"), "keep");

    expect(existsSync(departedRecord)).toBe(false);
    expect(existsSync(siblingRecord)).toBe(false);

    renameSync(volume, unmountedVolume);
    // This is the tracked setup ordering: kd env sync migrates cleanup
    // knowledge before Kanna invokes the optional ignored local hook.
    expect(migrateLegacyExternalWorkspaceBuild(departed)).toEqual({
      status: "migrated",
      record: departedRecord,
      target: departedBuild
    });
    execFileSync("/bin/sh", [legacyHook], { cwd: departed, stdio: "pipe" });
    expect(lstatSync(join(departed, ".build")).isDirectory()).toBe(true);
    expect(readFileSync(departedRecord, "utf8")).toBe(`${departedBuild}\n`);
    await expect(
      cleanWorkspace({
        repoRoot: departed,
        homeDir: join(fixture, "home"),
        runner: bazelRunner(join(fixture, "bazel-output")),
        all: true,
        dry: false,
        sharedRustBuild: false
      })
    ).rejects.toThrow(/Cannot clean external \.build target.*recorded target is unavailable.*preserving/);
    expect(existsSync(join(departed, ".build"))).toBe(true);
    expect(readFileSync(departedRecord, "utf8")).toBe(`${departedBuild}\n`);

    renameSync(unmountedVolume, volume);

    await cleanWorkspace({
      repoRoot: departed,
      homeDir: join(fixture, "home"),
      runner: bazelRunner(join(fixture, "bazel-output")),
      all: true,
      dry: false,
      sharedRustBuild: false
    });

    expect(existsSync(departedBuild)).toBe(false);
    expect(existsSync(join(departed, ".build"))).toBe(false);
    expect(existsSync(departedRecord)).toBe(false);
    expect(readFileSync(join(siblingBuild, "artifact.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(liveSibling, ".build"))).toBe(true);
    expect(existsSync(siblingRecord)).toBe(false);
  });

  it("visibly refuses to migrate a legacy link belonging to a sibling workspace", () => {
    const fixture = mkdtempSync(join(tmpdir(), "kd-external-migration-refusal-"));
    fixtures.push(fixture);
    const workspace = join(fixture, "task-current");
    const siblingBuild = join(fixture, "external", "task-sibling");
    mkdirSync(workspace);
    mkdirSync(siblingBuild, { recursive: true });
    symlinkSync(siblingBuild, join(workspace, ".build"));

    expect(() => migrateLegacyExternalWorkspaceBuild(workspace)).toThrow(
      /Refusing external \.build target.*expected an exact workspace target ending in task-current/
    );
    expect(lstatSync(join(workspace, ".build")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(workspace, ".kanna-external-build-target"))).toBe(false);
    expect(existsSync(siblingBuild)).toBe(true);
  });
});
