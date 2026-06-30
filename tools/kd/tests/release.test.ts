import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/runtime/process";
import {
  bazelTargetForLabel,
  createUpdaterBundle,
  releaseAssetName,
  shipRelease,
  updaterAssetName,
  updaterBundleTargetForLabel,
  updaterSignatureName,
  type ReleaseArchLabel,
  type ReleaseShipInput
} from "../src/runtime/release";

interface CommandCall {
  command: string;
  args: string[];
  options?: { cwd?: string; env?: NodeJS.ProcessEnv };
}

function createReleaseRepo(root: string): { repoRoot: string; privateKeyPath: string } {
  const repoRoot = join(root, "repo");
  const tauriDir = join(repoRoot, "apps", "desktop", "src-tauri");
  mkdirSync(tauriDir, { recursive: true });
  writeFileSync(join(repoRoot, "VERSION"), "1.2.3\n");
  writeFileSync(join(tauriDir, "tauri.conf.json"), '{\n  "version": "1.2.3"\n}\n');
  writeFileSync(join(tauriDir, "Cargo.toml"), '[package]\nname = "kanna"\nversion = "1.2.3"\n');
  writeFileSync(join(tauriDir, "Cargo.lock"), "# lock\n");
  const privateKeyPath = join(root, "updater-private.key");
  writeFileSync(privateKeyPath, "private key\n");
  return { repoRoot, privateKeyPath };
}

function releaseEnv(privateKeyPath: string): NodeJS.ProcessEnv {
  return {
    KANNA_UPDATER_PUBKEY: "pubkey",
    TAURI_PRIVATE_KEY_PATH: privateKeyPath,
    PATH: process.env.PATH
  };
}

function readVersionFiles(repoRoot: string): string[] {
  return [
    readFileSync(join(repoRoot, "VERSION"), "utf8"),
    readFileSync(join(repoRoot, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    readFileSync(join(repoRoot, "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8")
  ];
}

function writeReleaseBuildOutputs(repoRoot: string, labels: ReleaseArchLabel[]): Map<string, string> {
  const outputs = new Map<string, string>();
  mkdirSync(join(repoRoot, "bazel-out", "release"), { recursive: true });

  for (const label of labels) {
    const dmgRel = `bazel-out/release/Kanna-${label}.dmg`;
    const bundleRel = `bazel-out/release/Kanna-${label}.app.tar.gz`;
    writeFileSync(join(repoRoot, dmgRel), `${label} dmg\n`);
    writeFileSync(join(repoRoot, bundleRel), `${label} updater bundle\n`);
    outputs.set(bazelTargetForLabel(label, false), dmgRel);
    outputs.set(updaterBundleTargetForLabel(label), bundleRel);
  }

  return outputs;
}

function writeStagingReleaseBuildOutputs(repoRoot: string, labels: ReleaseArchLabel[]): Map<string, string> {
  const outputs = new Map<string, string>();
  mkdirSync(join(repoRoot, "bazel-out", "release", "staging"), { recursive: true });

  for (const label of labels) {
    const dmgRel = `bazel-out/release/staging/Kanna-Staging-${label}.dmg`;
    const bundleRel = `bazel-out/release/staging/Kanna-Staging-${label}.app.tar.gz`;
    writeFileSync(join(repoRoot, dmgRel), `${label} staging dmg\n`);
    writeFileSync(join(repoRoot, bundleRel), `${label} staging updater bundle\n`);
    outputs.set(bazelTargetForLabel(label, true, "staging"), dmgRel);
    outputs.set(bazelTargetForLabel(label, false, "staging"), dmgRel);
    outputs.set(updaterBundleTargetForLabel(label, "staging"), bundleRel);
  }

  return outputs;
}

describe("release updater bundling", () => {
  // A regular full kd release ship -> updater install E2E would need signed release
  // artifacts, both macOS architectures, GitHub release metadata/assets, and a
  // WebDriver-driven installed app. The existing opt-in full-bundle updater E2E
  // builds its own temporary debug bundle instead of executing this release helper.
  // A feasible regular E2E would need a hermetic release backend with small signed
  // fixtures and a local updater manifest server. This test keeps the regression
  // guard at the production bundle helper boundary: command-runner env propagation,
  // copying the Bazel-created updater archive, and signer output placement.
  it("copies the Bazel updater bundle and renames the generated signature", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const repoRoot = join(root, "repo");
      const bundleSource = join(repoRoot, "bazel-out", "release", "Kanna-arm64.app.tar.gz");
      const bundlePath = join(repoRoot, ".build", "release", "Kanna_1.2.4_arm64.app.tar.gz");
      const signaturePath = join(repoRoot, ".build", "release", "custom-updater.sig");
      const privateKeyPath = join(root, "updater-private.key");

      mkdirSync(join(repoRoot, "bazel-out", "release"), { recursive: true });
      mkdirSync(join(repoRoot, ".build", "release"), { recursive: true });
      writeFileSync(bundleSource, "bazel updater archive\n");
      writeFileSync(privateKeyPath, "private key\n");

      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });

          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(signedBundlePath).toBe(bundlePath);
            writeFileSync(`${signedBundlePath}.sig`, "signed bundle\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }

          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command}` };
        }
      };
      const input: ReleaseShipInput = {
        repoRoot,
        bump: "patch",
        archLabels: ["arm64"],
        release: false,
        dryRun: true,
        env: {
          KANNA_UPDATER_PUBKEY: "pubkey",
          TAURI_PRIVATE_KEY_PATH: privateKeyPath,
          TAURI_PRIVATE_KEY_PASSWORD: "password",
          PATH: process.env.PATH
        },
        runner
      };

      await createUpdaterBundle(input, bundleSource, bundlePath, signaturePath);

      expect(readFileSync(bundlePath, "utf8")).toBe("bazel updater archive\n");
      expect(readFileSync(signaturePath, "utf8")).toBe("signed bundle\n");
      expect(calls.some((call) => call.command === "tar")).toBe(false);
      expect(calls.find((call) => call.command === "pnpm")?.args).toEqual([
        "--dir",
        join(repoRoot, "apps", "desktop"),
        "exec",
        "tauri",
        "signer",
        "sign",
        "--private-key-path",
        privateKeyPath,
        "--password",
        "password",
        bundlePath
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release shipping", () => {
  it("uses staging artifact names and Bazel targets when shipping staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            expect(args).toContain("//:kanna_signed_dmg_staging_arm64");
            expect(args).toContain("//:kanna_updater_bundle_staging_arm64");
            expect(args).not.toContain("//:kanna_signed_dmg_release_arm64");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "staging signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      const result = await shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64"],
        release: false,
        dryRun: true,
        environment: "staging",
        env: releaseEnv(privateKeyPath),
        runner
      });

      expect(releaseAssetName("1.2.4", "arm64", "staging")).toBe("Kanna_Staging_1.2.4_arm64.dmg");
      expect(updaterAssetName("1.2.4", "arm64", "staging")).toBe("Kanna_Staging_1.2.4_arm64.app.tar.gz");
      expect(updaterSignatureName("1.2.4", "arm64", "staging")).toBe("Kanna_Staging_1.2.4_arm64.app.tar.gz.sig");
      expect(result.dmgPaths).toEqual([join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4_arm64.dmg")]);
      expect(result.updaterPaths).toEqual([
        join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4_arm64.app.tar.gz"),
        join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4_arm64.app.tar.gz.sig")
      ]);
      expect(result.latestJson).toBe(join(repoRoot, ".build", "release", "staging", "latest-staging.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads staging releases to the mutable desktop-staging channel without tagging production", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const originalFiles = readVersionFiles(repoRoot);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            expect(args).toContain("//:kanna_notarized_dmg_staging_arm64");
            expect(args).toContain("//:kanna_notarized_dmg_staging_x86_64");
            expect(args).toContain("//:kanna_updater_bundle_staging_arm64");
            expect(args).toContain("//:kanna_updater_bundle_staging_x86_64");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "staging signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args.join(" ") === "release view desktop-staging --repo jemdiggity/kanna") {
            return { exitCode: 1, stdout: "", stderr: "not found" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "create") {
            expect(args).toEqual([
              "release",
              "create",
              "desktop-staging",
              "--repo",
              "jemdiggity/kanna",
              "--title",
              "Kanna Desktop Staging",
              "--notes",
              "Mutable desktop staging updater channel.",
              "--prerelease"
            ]);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "upload") {
            expect(args[2]).toBe("desktop-staging");
            expect(args).toContain(join(repoRoot, ".build", "release", "staging", "latest-staging.json"));
            expect(args).toContain("--clobber");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      await shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64", "x86_64"],
        release: true,
        dryRun: false,
        environment: "staging",
        env: releaseEnv(privateKeyPath),
        runner
      });

      expect(readVersionFiles(repoRoot)).toEqual(originalFiles);
      const uploadCall = calls.find((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "upload");
      expect(uploadCall?.args[2]).toBe("desktop-staging");
      expect(calls.some((call) => call.command === "git" && ["add", "commit", "tag", "push"].includes(call.args[0] ?? ""))).toBe(false);
      expect(calls.some((call) => call.command === "gh" && call.args[0] === "api")).toBe(false);
      expect(calls.some((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "create" && call.args[2] !== "desktop-staging")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to ship from a dirty git worktree before changing version files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const originalFiles = readVersionFiles(repoRoot);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: " M VERSION\n", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      };

      await expect(
        shipRelease({
          repoRoot,
          bump: "patch",
          archLabels: ["arm64"],
          release: false,
          dryRun: true,
          env: releaseEnv(privateKeyPath),
          runner
        })
      ).rejects.toThrow("Refusing to ship a release from a dirty git worktree");

      expect(readVersionFiles(repoRoot)).toEqual(originalFiles);
      expect(calls).toEqual([
        {
          command: "git",
          args: ["status", "--porcelain"],
          options: { cwd: repoRoot, env: releaseEnv(privateKeyPath) }
        }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores version files when the Bazel build fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const originalFiles = readVersionFiles(repoRoot);
      const runner: CommandRunner = {
        async run(command, args) {
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            expect(readVersionFiles(repoRoot)).toEqual([
              "1.2.4\n",
              '{\n  "version": "1.2.4"\n}\n',
              '[package]\nname = "kanna"\nversion = "1.2.4"\n'
            ]);
            return { exitCode: 1, stdout: "", stderr: "bazel failed" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      await expect(
        shipRelease({
          repoRoot,
          bump: "patch",
          archLabels: ["arm64"],
          release: false,
          dryRun: true,
          env: releaseEnv(privateKeyPath),
          runner
        })
      ).rejects.toThrow("bazel failed");

      expect(readVersionFiles(repoRoot)).toEqual(originalFiles);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before creating the GitHub release when git commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "api") {
            return { exitCode: 0, stdout: "release notes\n", stderr: "" };
          }
          if (command === "git" && args[0] === "add") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "commit") {
            return { exitCode: 1, stdout: "", stderr: "commit failed" };
          }
          if (command === "git" && args[0] === "tag") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      await expect(
        shipRelease({
          repoRoot,
          bump: "patch",
          archLabels: ["arm64", "x86_64"],
          release: true,
          dryRun: false,
          env: releaseEnv(privateKeyPath),
          runner
        })
      ).rejects.toThrow("commit failed");

      expect(calls.some((call) => call.command === "git" && call.args[0] === "tag")).toBe(false);
      expect(calls.some((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "create")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before creating the GitHub release when git tag fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "api") {
            return { exitCode: 0, stdout: "release notes\n", stderr: "" };
          }
          if (command === "git" && args[0] === "add") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "commit") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "tag") {
            return { exitCode: 1, stdout: "", stderr: "tag failed" };
          }
          if (command === "gh" && args[0] === "release") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      await expect(
        shipRelease({
          repoRoot,
          bump: "patch",
          archLabels: ["arm64", "x86_64"],
          release: true,
          dryRun: false,
          env: releaseEnv(privateKeyPath),
          runner
        })
      ).rejects.toThrow("tag failed");

      expect(calls.some((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "create")).toBe(false);
      expect(existsSync(join(repoRoot, ".build", "release", "latest.json"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pushes main and the tag before creating the GitHub release", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: command === "gh" && args[0] === "api" ? "release notes\n" : "", stderr: "" };
        }
      };

      await shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64", "x86_64"],
        release: true,
        dryRun: false,
        env: releaseEnv(privateKeyPath),
        runner
      });

      const pushIndex = calls.findIndex((call) =>
        call.command === "git" &&
        call.args.join(" ") === "push origin HEAD:main v1.2.4"
      );
      const releaseCreateIndex = calls.findIndex((call) =>
        call.command === "gh" &&
        call.args[0] === "release" &&
        call.args[1] === "create"
      );

      expect(pushIndex).toBeGreaterThan(-1);
      expect(releaseCreateIndex).toBeGreaterThan(-1);
      expect(pushIndex).toBeLessThan(releaseCreateIndex);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
