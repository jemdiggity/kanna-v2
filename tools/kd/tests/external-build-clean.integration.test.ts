import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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

  it("retains an unavailable target record, then removes only the departed workspace after remount", () => {
    const fixture = mkdtempSync(join(tmpdir(), "kd-external-teardown-"));
    fixtures.push(fixture);
    const volume = join(fixture, "external-volume");
    const unmountedVolume = join(fixture, "external-volume-unmounted");
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
    const departedRecord = join(departed, ".kanna-external-build-target");
    const siblingRecord = join(liveSibling, ".kanna-external-build-target");
    writeFileSync(join(departedBuild, "artifact.txt"), "remove");
    writeFileSync(join(siblingBuild, "artifact.txt"), "keep");

    expect(readFileSync(departedRecord, "utf8")).toBe(`${departedBuild}\n`);
    expect(readFileSync(siblingRecord, "utf8")).toBe(`${siblingBuild}\n`);

    renameSync(volume, unmountedVolume);
    execFileSync("/bin/sh", [hook], { cwd: departed, stdio: "pipe" });
    expect(lstatSync(join(departed, ".build")).isDirectory()).toBe(true);
    expect(readFileSync(departedRecord, "utf8")).toBe(`${departedBuild}\n`);
    expect(() =>
      cleanWorkspace({
        repoRoot: departed,
        homeDir: join(fixture, "home"),
        userName: "tester",
        all: true,
        dry: false,
        sharedRustBuild: false
      })
    ).toThrow(/Cannot clean external \.build target.*recorded target is unavailable.*preserving/);
    expect(existsSync(join(departed, ".build"))).toBe(true);
    expect(readFileSync(departedRecord, "utf8")).toBe(`${departedBuild}\n`);

    renameSync(unmountedVolume, volume);

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
    expect(existsSync(departedRecord)).toBe(false);
    expect(readFileSync(join(siblingBuild, "artifact.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(liveSibling, ".build"))).toBe(true);
    expect(readFileSync(siblingRecord, "utf8")).toBe(`${siblingBuild}\n`);
  });
});
