import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bazelOutputBase, cleanWorkspace } from "../src/runtime/clean";
import { buildConfigSchemaPages } from "../src/runtime/pages";
import {
  bazelTargetForLabel,
  bumpVersion,
  releaseAssetName,
  releaseRepoSlug,
  signedAppTargetForLabel,
  updaterAssetName,
  updaterBundleTargetForLabel,
  updaterPlatformKey,
  updaterSignatureName
} from "../src/runtime/release";

describe("clean runtime", () => {
  it("removes workspace-local build artifacts without removing shared caches by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-clean-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const sharedRust = join(home, "Library", "Caches", "kanna", "rust-build");
    for (const dir of [
      join(repo, ".build"),
      join(repo, "apps", "desktop", "src-tauri", "target"),
      bazelOutputBase(repo, home, "tester"),
      sharedRust
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "artifact.txt"), "x");
    }

    const result = cleanWorkspace({ repoRoot: repo, homeDir: home, userName: "tester", all: false, dry: false, sharedRustBuild: false });

    expect(result.removals.map((removal) => removal.path)).toContain(bazelOutputBase(repo, home, "tester"));
    expect(existsSync(join(repo, ".build"))).toBe(false);
    expect(existsSync(sharedRust)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("removes the exact external build target recorded by the workspace link", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-clean-external-"));
    const repo = join(root, "task-abcd1234-2");
    const externalBuild = join(root, "external", "task-abcd1234-2");
    mkdirSync(repo, { recursive: true });
    mkdirSync(externalBuild, { recursive: true });
    writeFileSync(join(externalBuild, "artifact.txt"), "x");
    symlinkSync(externalBuild, join(repo, ".build"));

    const result = cleanWorkspace({
      repoRoot: repo,
      homeDir: join(root, "home"),
      userName: "tester",
      all: false,
      dry: false,
      sharedRustBuild: false
    });

    expect(result.removals.map((removal) => removal.path)).toEqual([
      join(realpathSync(join(root, "external")), "task-abcd1234-2"),
      join(repo, ".build")
    ]);
    expect(existsSync(externalBuild)).toBe(false);
    expect(existsSync(join(repo, ".build"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses an external build target belonging to a sibling workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-clean-mismatch-"));
    const repo = join(root, "task-current");
    const siblingBuild = join(root, "external", "task-sibling");
    mkdirSync(repo, { recursive: true });
    mkdirSync(siblingBuild, { recursive: true });
    writeFileSync(join(siblingBuild, "artifact.txt"), "keep");
    symlinkSync(siblingBuild, join(repo, ".build"));

    expect(() =>
      cleanWorkspace({
        repoRoot: repo,
        homeDir: join(root, "home"),
        userName: "tester",
        all: true,
        dry: false,
        sharedRustBuild: false
      })
    ).toThrow(/Refusing to clean external \.build target.*expected an exact workspace target/);
    expect(readFileSync(join(siblingBuild, "artifact.txt"), "utf8")).toBe("keep");
    expect(lstatSync(join(repo, ".build")).isSymbolicLink()).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("reports an unavailable recorded external build and preserves its authoritative link", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-clean-dangling-"));
    const repo = join(root, "task-dangling");
    mkdirSync(repo, { recursive: true });
    symlinkSync(join(root, "external", "task-dangling"), join(repo, ".build"));

    expect(() =>
      cleanWorkspace({
        repoRoot: repo,
        homeDir: join(root, "home"),
        userName: "tester",
        all: false,
        dry: false,
        sharedRustBuild: false
      })
    ).toThrow(/Cannot clean external \.build target.*recorded target is unavailable.*preserving/);
    expect(lstatSync(join(repo, ".build")).isSymbolicLink()).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("remains idempotent when no workspace build path is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-clean-absent-"));
    const repo = join(root, "task-absent");
    mkdirSync(repo, { recursive: true });

    const result = cleanWorkspace({
      repoRoot: repo,
      homeDir: join(root, "home"),
      userName: "tester",
      all: false,
      dry: false,
      sharedRustBuild: false
    });

    expect(result.removals).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("pages runtime", () => {
  it("builds the config schema Pages artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-pages-"));
    mkdirSync(join(root, ".kanna"), { recursive: true });
    mkdirSync(join(root, "crates", "kanna-tool-catalog", "src"), { recursive: true });
    writeFileSync(
      join(root, ".kanna", "config.schema.json"),
      '{"type":"object","properties":{"workflow":{"type":"string"}}}\n'
    );
    writeFileSync(
      join(root, "crates", "kanna-tool-catalog", "src", "catalog.json"),
      JSON.stringify({
        guides: [{ sections: [{ body: "Catalog-owned meaning", schemaPaths: ["/properties/workflow"] }] }]
      })
    );

    const [schema, cname] = buildConfigSchemaPages({ repoRoot: root, outDir: join(root, "out") });

    expect(JSON.parse(readFileSync(schema, "utf8"))).toEqual({
      type: "object",
      properties: { workflow: { type: "string", description: "Catalog-owned meaning" } }
    });
    expect(readFileSync(cname, "utf8")).toBe("schemas.kanna.build\n");
    await rm(root, { recursive: true, force: true });
  });
});

describe("release runtime", () => {
  it("builds release names and targets without shell scripts", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(releaseAssetName("1.2.4", "arm64")).toBe("Kanna_1.2.4_arm64.dmg");
    expect(updaterAssetName("1.2.4", "x86_64")).toBe("Kanna_1.2.4_x86_64.app.tar.gz");
    expect(updaterSignatureName("1.2.4", "x86_64")).toBe("Kanna_1.2.4_x86_64.app.tar.gz.sig");
    expect(updaterPlatformKey("arm64")).toBe("darwin-aarch64");
    expect(bazelTargetForLabel("arm64", true)).toBe("//:kanna_signed_dmg_release_arm64");
    expect(bazelTargetForLabel("arm64", false)).toBe("//:kanna_notarized_dmg_release_arm64");
    expect(signedAppTargetForLabel("x86_64")).toBe("//:kanna_signed_app_release_x86_64");
    expect(updaterBundleTargetForLabel("x86_64")).toBe("//:kanna_updater_bundle_release_x86_64");
    expect(releaseRepoSlug("git@github.com:jemdiggity/kanna.git")).toBe("jemdiggity/kanna");
  });
});
