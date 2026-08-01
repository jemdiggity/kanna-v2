import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/runtime/process";
import {
  bazelTargetForLabel,
  createUpdaterBundle,
  cutReleaseBranch,
  nextSeriesPatchVersion,
  parsePromotionVersions,
  parseReleaseBranchSeries,
  releaseAssetName,
  releaseSeriesBranch,
  releaseSeriesFromVersion,
  releaseStatus,
  resolveActiveStagingMarketingVersion,
  shipRelease,
  stagingMarketingVersion,
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
          if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "ls-remote --tags origin v1.2.4-staging.*") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            expect(args).toContain("//:kanna_signed_dmg_staging_arm64");
            expect(args).toContain("//:kanna_updater_bundle_staging_arm64");
            expect(args).not.toContain("//:kanna_signed_dmg_release_arm64");
            expect(readVersionFiles(repoRoot)).toEqual([
              "1.2.4-staging.1\n",
              '{\n  "version": "1.2.4-staging.1"\n}\n',
              '[package]\nname = "kanna"\nversion = "1.2.4-staging.1"\n'
            ]);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "sh" && args[0] === "-c") {
            expect(args[1]).toContain("hdiutil attach");
            expect(args[1]).toContain("sips -g pixelWidth -g pixelHeight");
            expect(args.at(-1)).toBe(join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.1_arm64.dmg"));
            return { exitCode: 0, stdout: "", stderr: "" };
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

      expect(releaseAssetName("1.2.4-staging.1", "arm64", "staging")).toBe("Kanna_Staging_1.2.4-staging.1_arm64.dmg");
      expect(updaterAssetName("1.2.4-staging.1", "arm64", "staging")).toBe("Kanna_Staging_1.2.4-staging.1_arm64.app.tar.gz");
      expect(updaterSignatureName("1.2.4-staging.1", "arm64", "staging")).toBe("Kanna_Staging_1.2.4-staging.1_arm64.app.tar.gz.sig");
      expect(result.dmgPaths).toEqual([join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.1_arm64.dmg")]);
      expect(result.updaterPaths).toEqual([
        join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.1_arm64.app.tar.gz"),
        join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.1_arm64.app.tar.gz.sig")
      ]);
      expect(result.latestJson).toBe(join(repoRoot, ".build", "release", "staging", "latest-staging.json"));
      const validationCall = calls.find((call) => call.command === "sh" && call.args[0] === "-c");
      const signerCall = calls.find((call) => call.command === "pnpm");
      expect(validationCall).toBeDefined();
      expect(signerCall).toBeDefined();
      expect(calls.indexOf(validationCall!)).toBeLessThan(calls.indexOf(signerCall!));
      expect(readVersionFiles(repoRoot)).toEqual([
        "1.2.3\n",
        '{\n  "version": "1.2.3"\n}\n',
        '[package]\nname = "kanna"\nversion = "1.2.3"\n'
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives staging RC versions from the release branch series instead of VERSION", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          const key = `${command} ${args.join(" ")}`;
          if (key === "git status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "release/1.3\n", stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: "branchsha\trefs/heads/release/1.3\n", stderr: "" };
          }
          if (key === "git fetch origin release/1.3") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git merge-base --is-ancestor branchsha HEAD") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git ls-remote --tags origin v1.3.*") {
            return { exitCode: 0, stdout: "sha1\trefs/tags/v1.3.0\nsha2\trefs/tags/v1.3.0-staging.9\n", stderr: "" };
          }
          if (key === "git ls-remote --tags origin v1.3.1-staging.*") {
            return { exitCode: 0, stdout: "sha3\trefs/tags/v1.3.1-staging.2\n", stderr: "" };
          }
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            expect(readVersionFiles(repoRoot)[0]).toBe("1.3.1-staging.3\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3] ?? "") ?? ""}\n`, stderr: "" };
          }
          if (command === "sh" && args[0] === "-c") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "staging signature\n", "utf8");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
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

      expect(result.version).toBe("1.3.1-staging.3");
      expect(readVersionFiles(repoRoot)[0]).toBe("1.2.3\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("versions and records a release-branch RC shipped from a task worktree via --branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const branchSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          const key = `${command} ${args.join(" ")}`;
          if (key === "git status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: `${branchSha}\trefs/heads/release/1.3\n`, stderr: "" };
          }
          if (key === "git fetch origin release/1.3") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === `git merge-base --is-ancestor ${branchSha} HEAD`) {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git ls-remote --tags origin v1.3.*") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git ls-remote --tags origin v1.3.0-staging.*") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "build") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3] ?? "") ?? ""}\n`, stderr: "" };
          }
          if (command === "sh" && args[0] === "-c") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "staging signature\n", "utf8");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      const result = await shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64"],
        release: false,
        dryRun: true,
        environment: "staging",
        sourceBranch: "release/1.3",
        env: releaseEnv(privateKeyPath),
        runner
      });

      // The Kanna task worktree branch (task-*) is never consulted: no
      // rev-parse --abbrev-ref call, series versioning from release/1.3, and
      // the manifest notes record the RC's source branch.
      expect(result.version).toBe("1.3.0-staging.1");
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "rev-parse --abbrev-ref HEAD")).toBe(false);
      const manifest = JSON.parse(readFileSync(result.latestJson, "utf8")) as { notes?: string };
      expect(manifest.notes).toContain("Source-Branch: release/1.3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a --branch RC when the release branch tip is not contained in HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const branchSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          const key = `${command} ${args.join(" ")}`;
          if (key === "git status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: `${branchSha}\trefs/heads/release/1.3\n`, stderr: "" };
          }
          if (key === "git fetch origin release/1.3") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === `git merge-base --is-ancestor ${branchSha} HEAD`) {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      await expect(shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64"],
        release: false,
        dryRun: true,
        environment: "staging",
        sourceBranch: "release/1.3",
        env: releaseEnv(privateKeyPath),
        runner
      })).rejects.toThrow(/release\/1\.3 tip .* is not contained in HEAD/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(readVersionFiles(repoRoot)[0]).toBe("1.2.3\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes staging as an immutable prerelease, then repoints desktop-staging", async () => {
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
          if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "ls-remote --tags origin v1.2.4-staging.*") {
            return {
              exitCode: 0,
              stdout: [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.2.4-staging.1",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1.2.4-staging.4",
                "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1.2.4-staging.4^{}"
              ].join("\n"),
              stderr: ""
            };
          }
          if (command === "git" && args.join(" ") === "rev-parse HEAD") {
            return { exitCode: 0, stdout: "1234567890abcdef\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "sh" && args[0] === "-c") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "pnpm") {
            const signedBundlePath = args.at(-1);
            expect(typeof signedBundlePath).toBe("string");
            writeFileSync(`${signedBundlePath}.sig`, "staging signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args.join(" ") === "release view desktop-staging --repo jemdiggity/kanna") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "create") {
            expect(args).toEqual([
              "release",
              "create",
              "v1.2.4-staging.5",
              "--repo",
              "jemdiggity/kanna",
              "--title",
              "Kanna Staging v1.2.4-staging.5",
              "--notes",
              "Staging updater manifest for v1.2.4-staging.5\n\nSource-Branch: main",
              "--target",
              "1234567890abcdef",
              "--prerelease",
              join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.5_arm64.dmg"),
              join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.5_x86_64.dmg"),
              join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.5_arm64.app.tar.gz"),
              join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.5_arm64.app.tar.gz.sig"),
              join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.5_x86_64.app.tar.gz"),
              join(repoRoot, ".build", "release", "staging", "Kanna_Staging_1.2.4-staging.5_x86_64.app.tar.gz.sig"),
              join(repoRoot, ".build", "release", "staging", "latest-staging.json")
            ]);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "upload" && args[2] === "desktop-staging") {
            expect(args[2]).toBe("desktop-staging");
            expect(args).toEqual([
              "release",
              "upload",
              "desktop-staging",
              join(repoRoot, ".build", "release", "staging", "latest-staging.json"),
              "--repo",
              "jemdiggity/kanna",
              "--clobber"
            ]);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "delete-asset") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "list") {
            return {
              exitCode: 0,
              stdout: [
                "Kanna Staging v1.2.4-staging.5\tLatest\tv1.2.4-staging.5\t2026-07-06T00:00:00Z",
                "Kanna Staging v1.2.4-staging.4\t\tv1.2.4-staging.4\t2026-07-05T00:00:00Z"
              ].join("\n"),
              stderr: ""
            };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "view" && args[2] === "desktop-staging") {
            if (args.includes("--json")) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  assets: [
                    { name: "latest-staging.json" },
                    { name: "Kanna_Staging_1.2.4_arm64.dmg" }
                  ]
                }),
                stderr: ""
              };
            }
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
      const releaseCreateCall = calls.find((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "create");
      const uploadCall = calls.find((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "upload");
      expect(uploadCall?.args[2]).toBe("desktop-staging");
      expect(releaseCreateCall).toBeDefined();
      expect(uploadCall).toBeDefined();
      expect(calls.indexOf(releaseCreateCall!)).toBeLessThan(calls.indexOf(uploadCall!));
      expect(calls.some((call) => call.command === "git" && ["add", "commit", "tag", "push"].includes(call.args[0] ?? ""))).toBe(false);
      expect(calls.some((call) => call.command === "gh" && call.args[0] === "api")).toBe(false);
      expect(readFileSync(join(repoRoot, ".build", "release", "staging", "latest-staging.json"), "utf8")).toContain(
        "releases/download/v1.2.4-staging.5/Kanna_Staging_1.2.4-staging.5_arm64.app.tar.gz"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps five newest staging prereleases without deleting the pointed release", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "git" && args.join(" ") === "remote get-url origin") return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "ls-remote --tags origin v1.2.4-staging.*") {
            return {
              exitCode: 0,
              stdout: [
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.2.4-staging.1",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1.2.4-staging.2",
                "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1.2.4-staging.3",
                "dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v1.2.4-staging.4",
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/v1.2.4-staging.5",
                "ffffffffffffffffffffffffffffffffffffffff\trefs/tags/v1.2.4-staging.6"
              ].join("\n"),
              stderr: ""
            };
          }
          if (command === "git" && args.join(" ") === "rev-parse HEAD") return { exitCode: 0, stdout: "1234567890abcdef\n", stderr: "" };
          if (command === "bazel" && args[0] === "build") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "bazel" && args[0] === "cquery") return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          if (command === "sh" && args[0] === "-c") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "pnpm") {
            writeFileSync(`${args.at(-1)}.sig`, "staging signature\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args.join(" ") === "release view desktop-staging --repo jemdiggity/kanna") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "release" && args[1] === "create") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "release" && args[1] === "upload") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "release" && args[1] === "view" && args[2] === "desktop-staging" && args.includes("--json")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ assets: [{ name: "latest-staging.json" }] }),
              stderr: ""
            };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "list") {
            return {
              exitCode: 0,
              stdout: [
                "Kanna Staging v1.2.4-staging.1\t\tv1.2.4-staging.1\t2026-07-01T00:00:00Z",
                "Kanna Staging v1.2.4-staging.2\t\tv1.2.4-staging.2\t2026-07-02T00:00:00Z",
                "Kanna Staging v1.2.4-staging.3\t\tv1.2.4-staging.3\t2026-07-03T00:00:00Z",
                "Kanna Staging v1.2.4-staging.4\t\tv1.2.4-staging.4\t2026-07-04T00:00:00Z",
                "Kanna Staging v1.2.4-staging.5\t\tv1.2.4-staging.5\t2026-07-05T00:00:00Z",
                "Kanna Staging v1.2.4-staging.6\t\tv1.2.4-staging.6\t2026-07-06T00:00:00Z"
              ].join("\n"),
              stderr: ""
            };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "delete") return { exitCode: 0, stdout: "", stderr: "" };
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

      const deleteTags = calls
        .filter((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "delete")
        .map((call) => call.args[2]);
      expect([...deleteTags].sort()).toEqual(["v1.2.4-staging.1", "v1.2.4-staging.2"]);
      expect(deleteTags).not.toContain("v1.2.4-staging.6");
      expect(deleteTags).not.toContain("v1.2.4-staging.7");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back staging by clobbering the pointer manifest from a versioned prerelease", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "git" && args.join(" ") === "remote get-url origin") return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          if (command === "gh" && args.join(" ") === "release view v1.2.4-staging.3 --repo jemdiggity/kanna") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args.join(" ") === "release view desktop-staging --repo jemdiggity/kanna") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "release" && args[1] === "download") {
            expect(args).toEqual([
              "release",
              "download",
              "v1.2.4-staging.3",
              "--repo",
              "jemdiggity/kanna",
              "--pattern",
              "latest-staging.json",
              "--dir",
              join(repoRoot, ".build", "release", "staging"),
              "--clobber"
            ]);
            mkdirSync(join(repoRoot, ".build", "release", "staging"), { recursive: true });
            writeFileSync(join(repoRoot, ".build", "release", "staging", "latest-staging.json"), "{}\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "upload") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      const result = await shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64", "x86_64"],
        release: false,
        dryRun: false,
        environment: "staging",
        rollbackTo: "1.2.4-staging.3",
        env: releaseEnv(privateKeyPath),
        runner
      });

      expect(result.version).toBe("1.2.4-staging.3");
      expect(result.dmgPaths).toEqual([]);
      expect(result.updaterPaths).toEqual([]);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "ls-remote")).toBe(false);
      expect(calls.find((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "upload")?.args).toEqual([
        "release",
        "upload",
        "desktop-staging",
        join(repoRoot, ".build", "release", "staging", "latest-staging.json"),
        "--repo",
        "jemdiggity/kanna",
        "--clobber"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when rollback prerelease has no staging manifest asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const runner: CommandRunner = {
        async run(command, args) {
          if (command === "git" && args.join(" ") === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "git" && args.join(" ") === "remote get-url origin") return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          if (command === "gh" && args.join(" ") === "release view v1.2.4-staging.3 --repo jemdiggity/kanna") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "release" && args[1] === "download") return { exitCode: 1, stdout: "", stderr: "no assets match pattern" };
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` };
        }
      };

      await expect(
        shipRelease({
          repoRoot,
          bump: "patch",
          archLabels: ["arm64", "x86_64"],
          release: false,
          dryRun: false,
          environment: "staging",
          rollbackTo: "1.2.4-staging.3",
          env: releaseEnv(privateKeyPath),
          runner
        })
      ).rejects.toThrow("Staging manifest asset not found on v1.2.4-staging.3: latest-staging.json");
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
          if (command === "sh" && args[0] === "-c") {
            return { exitCode: 0, stdout: "", stderr: "" };
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
          if (command === "sh" && args[0] === "-c") {
            return { exitCode: 0, stdout: "", stderr: "" };
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
            expect(readVersionFiles(repoRoot)).toEqual([
              "1.2.4\n",
              '{\n  "version": "1.2.4"\n}\n',
              '[package]\nname = "kanna"\nversion = "1.2.4"\n'
            ]);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "bazel" && args[0] === "cquery") {
            return { exitCode: 0, stdout: `${outputs.get(args[3]) ?? ""}\n`, stderr: "" };
          }
          if (command === "sh" && args[0] === "-c") {
            return { exitCode: 0, stdout: "", stderr: "" };
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
      expect(readVersionFiles(repoRoot)).toEqual([
        "1.2.4\n",
        '{\n  "version": "1.2.4"\n}\n',
        '[package]\nname = "kanna"\nversion = "1.2.4"\n'
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release promotion", () => {
  const STAGING_COMMIT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  function promoteRunner(overrides: Partial<Record<string, { exitCode: number; stdout: string; stderr: string }>>, repoRoot: string, outputs: Map<string, string>, calls: CommandCall[]): CommandRunner {
    return {
      async run(command, args, options) {
        calls.push({ command, args, options });
        const key = `${command} ${args.join(" ")}`;
        for (const [prefix, result] of Object.entries(overrides)) {
          if (key.startsWith(prefix) && result) return result;
        }
        if (command === "git" && args.join(" ") === "status --porcelain") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "remote get-url origin") {
          return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
        }
        if (command === "gh" && args.join(" ").startsWith("release view v1.2.4-staging.3")) {
          return { exitCode: 0, stdout: `{"targetCommitish":"${STAGING_COMMIT}"}\n`, stderr: "" };
        }
        if (command === "git" && args.join(" ") === "ls-remote --tags origin v1.2.4") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse HEAD") {
          return { exitCode: 0, stdout: `${STAGING_COMMIT}\n`, stderr: "" };
        }
        if (command === "git" && args.join(" ") === "fetch origin main") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse origin/main") {
          return { exitCode: 0, stdout: `${STAGING_COMMIT}\n`, stderr: "" };
        }
        if (command === "bazel" && args[0] === "build") {
          expect(args).toContain("//:kanna_notarized_dmg_release_arm64");
          expect(args).not.toContain("//:kanna_notarized_dmg_staging_arm64");
          expect(readVersionFiles(repoRoot)).toEqual([
            "1.2.4\n",
            '{\n  "version": "1.2.4"\n}\n',
            '[package]\nname = "kanna"\nversion = "1.2.4"\n'
          ]);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "bazel" && args[0] === "cquery") {
          return { exitCode: 0, stdout: `${outputs.get(args[3] ?? "") ?? ""}\n`, stderr: "" };
        }
        if (command === "sh" && args[0] === "-c") {
          return { exitCode: 0, stdout: "", stderr: "" };
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
  }

  function promoteInput(repoRoot: string, privateKeyPath: string, runner: CommandRunner): ReleaseShipInput {
    return {
      repoRoot,
      bump: "patch",
      archLabels: ["arm64", "x86_64"],
      environment: "production",
      release: true,
      dryRun: false,
      promoteFrom: "1.2.4-staging.3",
      env: releaseEnv(privateKeyPath),
      runner
    };
  }

  it("parses staging versions into promotion versions", () => {
    expect(parsePromotionVersions("1.2.4-staging.3")).toEqual({
      stagingVersion: "1.2.4-staging.3",
      stagingTag: "v1.2.4-staging.3",
      productionVersion: "1.2.4"
    });
    expect(parsePromotionVersions("v1.2.4-staging.10").productionVersion).toBe("1.2.4");
    expect(() => parsePromotionVersions("1.2.4")).toThrow(/Invalid staging version/);
    expect(() => parsePromotionVersions("1.2.4-rc.1")).toThrow(/Invalid staging version/);
  });

  it("promotes a staging prerelease into a production release of the same commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({}, repoRoot, outputs, calls);

      const result = await shipRelease(promoteInput(repoRoot, privateKeyPath, runner));

      expect(result.version).toBe("1.2.4");
      expect(result.dmgPaths).toEqual([
        join(repoRoot, ".build", "release", "Kanna_1.2.4_arm64.dmg"),
        join(repoRoot, ".build", "release", "Kanna_1.2.4_x86_64.dmg")
      ]);
      const promoteViewIndex = calls.findIndex((call) => call.command === "gh" && call.args.join(" ").startsWith("release view v1.2.4-staging.3"));
      const buildIndex = calls.findIndex((call) => call.command === "bazel" && call.args[0] === "build");
      const pushIndex = calls.findIndex((call) => call.command === "git" && call.args.join(" ") === "push origin HEAD:main v1.2.4");
      const releaseCreateIndex = calls.findIndex((call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "create");
      expect(promoteViewIndex).toBeGreaterThan(-1);
      expect(buildIndex).toBeGreaterThan(promoteViewIndex);
      expect(pushIndex).toBeGreaterThan(buildIndex);
      expect(releaseCreateIndex).toBeGreaterThan(pushIndex);
      expect(calls.find((call) => call.command === "gh" && call.args[1] === "create")?.args).toContain("v1.2.4");
      expect(readVersionFiles(repoRoot)).toEqual([
        "1.2.4\n",
        '{\n  "version": "1.2.4"\n}\n',
        '[package]\nname = "kanna"\nversion = "1.2.4"\n'
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote when the staging prerelease does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release view v1.2.4-staging.3": { exitCode: 1, stdout: "", stderr: "release not found" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/Staging prerelease not found: v1\.2\.4-staging\.3/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote a version whose production tag already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "git ls-remote --tags origin v1.2.4": { exitCode: 0, stdout: `${STAGING_COMMIT}\trefs/tags/v1.2.4\n`, stderr: "" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/Production tag v1\.2\.4 already exists/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote when origin/main has advanced past the staging build", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const originalFiles = readVersionFiles(repoRoot);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "git rev-parse origin/main": { exitCode: 0, stdout: "ffffffffffffffffffffffffffffffffffffffff\n", stderr: "" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/origin\/main .* has advanced past v1\.2\.4-staging\.3/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(readVersionFiles(repoRoot)).toEqual(originalFiles);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote when HEAD is not the staging build's commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "git rev-parse HEAD": { exitCode: 0, stdout: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n", stderr: "" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/is not the commit v1\.2\.4-staging\.3 was built from/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes from a release branch and pushes the version bump there", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "git ls-remote origin refs/heads/release/1.2": {
          exitCode: 0,
          stdout: `${STAGING_COMMIT}\trefs/heads/release/1.2\n`,
          stderr: ""
        }
      }, repoRoot, outputs, calls);

      const result = await shipRelease(promoteInput(repoRoot, privateKeyPath, runner));

      expect(result.version).toBe("1.2.4");
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "push origin HEAD:release/1.2 v1.2.4")).toBe(true);
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "fetch origin main")).toBe(false);
      const notesCall = calls.find((call) => call.command === "gh" && call.args[0] === "api");
      expect(notesCall?.args).toContain("target_commitish=release/1.2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote a release-branch RC when the branch has advanced past it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release view v1.2.4-staging.3": {
          exitCode: 0,
          stdout: `{"targetCommitish":"${STAGING_COMMIT}","body":"Staging updater manifest for v1.2.4-staging.3\\n\\nSource-Branch: release/1.2"}\n`,
          stderr: ""
        },
        "git ls-remote origin refs/heads/release/1.2": {
          exitCode: 0,
          stdout: "ffffffffffffffffffffffffffffffffffffffff\trefs/heads/release/1.2\n",
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/release\/1\.2 .* has advanced past v1\.2\.4-staging\.3/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "fetch origin main")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes a main RC to main even when a dormant same-series release branch exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release view v1.2.4-staging.3": {
          exitCode: 0,
          stdout: `{"targetCommitish":"${STAGING_COMMIT}","body":"Staging updater manifest for v1.2.4-staging.3\\n\\nSource-Branch: main"}\n`,
          stderr: ""
        },
        "git ls-remote origin refs/heads/release/1.2": {
          exitCode: 0,
          stdout: "dddddddddddddddddddddddddddddddddddddddd\trefs/heads/release/1.2\n",
          stderr: ""
        }
      }, repoRoot, outputs, calls);

      const result = await shipRelease(promoteInput(repoRoot, privateKeyPath, runner));

      expect(result.version).toBe("1.2.4");
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === "push origin HEAD:main v1.2.4")).toBe(true);
      const notesCall = calls.find((call) => call.command === "gh" && call.args[0] === "api");
      expect(notesCall?.args).toContain("target_commitish=main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote a release-branch RC whose branch was deleted", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release view v1.2.4-staging.3": {
          exitCode: 0,
          stdout: `{"targetCommitish":"${STAGING_COMMIT}","body":"Staging updater manifest for v1.2.4-staging.3\\n\\nSource-Branch: release/1.2"}\n`,
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/was built from release\/1\.2, but the branch no longer exists/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects promotion aimed at the staging environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const runner = promoteRunner({}, repoRoot, new Map(), []);
      await expect(shipRelease({
        ...promoteInput(repoRoot, privateKeyPath, runner),
        environment: "staging"
      })).rejects.toThrow(/cannot target staging/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release series", () => {
  it("derives series and branch names from versions", () => {
    expect(releaseSeriesFromVersion("1.2.4")).toEqual({ major: 1, minor: 2 });
    expect(releaseSeriesFromVersion("v1.2.4-staging.3")).toEqual({ major: 1, minor: 2 });
    expect(releaseSeriesBranch({ major: 1, minor: 2 })).toBe("release/1.2");
    expect(() => releaseSeriesFromVersion("nope")).toThrow(/Invalid version/);
  });

  it("parses release branch names", () => {
    expect(parseReleaseBranchSeries("release/1.2")).toEqual({ major: 1, minor: 2 });
    expect(parseReleaseBranchSeries("main")).toBeNull();
    expect(parseReleaseBranchSeries("release/1.2.3")).toBeNull();
    expect(parseReleaseBranchSeries("feature/release/1.2")).toBeNull();
  });

  it("computes the next patch version for a series from released tags", () => {
    expect(nextSeriesPatchVersion("", { major: 1, minor: 3 })).toBe("1.3.0");
    const tags = [
      "sha1\trefs/tags/v1.3.0",
      "sha2\trefs/tags/v1.3.0^{}",
      "sha3\trefs/tags/v1.3.2",
      "sha4\trefs/tags/v1.3.0-staging.4",
      "sha5\trefs/tags/v1.4.0"
    ].join("\n");
    expect(nextSeriesPatchVersion(tags, { major: 1, minor: 3 })).toBe("1.3.3");
  });
});

describe("release cut", () => {
  const MAIN_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  function cutRunner(existingBranchOutput: string, calls: CommandCall[]): CommandRunner {
    return {
      async run(command, args, options) {
        calls.push({ command, args, options });
        const key = `${command} ${args.join(" ")}`;
        if (key === "git ls-remote origin refs/heads/release/1.3") {
          return { exitCode: 0, stdout: existingBranchOutput, stderr: "" };
        }
        if (key === "git fetch origin main") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (key === "git rev-parse origin/main") {
          return { exitCode: 0, stdout: `${MAIN_SHA}\n`, stderr: "" };
        }
        if (key === "git show origin/main:VERSION") {
          return { exitCode: 0, stdout: "1.2.3\n", stderr: "" };
        }
        if (command === "git" && args[0] === "push") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
      }
    };
  }

  it("cuts the next series branch from origin/main", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const result = await cutReleaseBranch({ repoRoot, bump: "minor", env: {}, runner: cutRunner("", calls) });

      expect(result).toEqual({ branch: "release/1.3", version: "1.3.0", commit: MAIN_SHA });
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === `push origin ${MAIN_SHA}:refs/heads/release/1.3`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives the series from origin/main VERSION, not the stale local worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          const key = `${command} ${args.join(" ")}`;
          if (key === "git fetch origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse origin/main") {
            return { exitCode: 0, stdout: `${MAIN_SHA}\n`, stderr: "" };
          }
          if (key === "git show origin/main:VERSION") {
            return { exitCode: 0, stdout: "1.4.7\n", stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.5") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "push") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      // Local worktree VERSION is 1.2.3, but the branch is pushed at
      // origin/main whose VERSION is 1.4.7 — the series must follow the latter.
      const result = await cutReleaseBranch({ repoRoot, bump: "minor", env: {}, runner });

      expect(result).toEqual({ branch: "release/1.5", version: "1.5.0", commit: MAIN_SHA });
      expect(calls.some((call) => call.command === "git" && call.args.join(" ") === `push origin ${MAIN_SHA}:refs/heads/release/1.5`)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to cut a series branch that already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = cutRunner(`${MAIN_SHA}\trefs/heads/release/1.3\n`, calls);

      await expect(cutReleaseBranch({ repoRoot, bump: "minor", env: {}, runner })).rejects.toThrow(/release\/1\.3 already exists/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("active staging marketing version", () => {
  it("strips the staging prerelease suffix from the active channel version", () => {
    expect(stagingMarketingVersion("0.1.0-staging.2")).toBe("0.1.0");
  });

  it("rejects a channel version that is not a staging prerelease", () => {
    expect(() => stagingMarketingVersion("0.1.0")).toThrow(/expected X.Y.Z-staging.N/);
    expect(() => stagingMarketingVersion("latest")).toThrow(/expected X.Y.Z-staging.N/);
  });

  it("resolves the authoritative active staging channel manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-staging-version-"));
    try {
      const runner: CommandRunner = {
        async run(command, args) {
          if (command === "git") {
            return {
              exitCode: 0,
              stdout: "git@github.com:tampopogk/kanna.git\n",
              stderr: ""
            };
          }
          const dirIndex = args.indexOf("--dir");
          writeFileSync(
            join(args[dirIndex + 1] ?? "", "latest-staging.json"),
            '{"version":"0.1.0-staging.2"}\n'
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      };

      await expect(
        resolveActiveStagingMarketingVersion({ repoRoot: root, env: {}, runner })
      ).resolves.toBe("0.1.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the active staging channel is unavailable", async () => {
    const runner: CommandRunner = {
      async run(command) {
        return command === "git"
          ? {
              exitCode: 0,
              stdout: "git@github.com:tampopogk/kanna.git\n",
              stderr: ""
            }
          : { exitCode: 1, stdout: "", stderr: "network unavailable" };
      }
    };

    await expect(
      resolveActiveStagingMarketingVersion({ repoRoot: "/repo", env: {}, runner })
    ).rejects.toThrow(/active staging version.*network unavailable/);
  });

  it("fails closed when the active staging channel version is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-staging-version-invalid-"));
    try {
      const runner: CommandRunner = {
        async run(command, args) {
          if (command === "git") {
            return {
              exitCode: 0,
              stdout: "git@github.com:tampopogk/kanna.git\n",
              stderr: ""
            };
          }
          const dirIndex = args.indexOf("--dir");
          writeFileSync(
            join(args[dirIndex + 1] ?? "", "latest-staging.json"),
            '{"version":"0.1.0"}\n'
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      };

      await expect(
        resolveActiveStagingMarketingVersion({ repoRoot: root, env: {}, runner })
      ).rejects.toThrow(/expected X.Y.Z-staging.N/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release status", () => {
  const MAIN_COMMIT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("reports production, staging pointer, and promotability", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          const key = `${command} ${args.join(" ")}`;
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (key === "git fetch --tags origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse origin/main") {
            return { exitCode: 0, stdout: `${MAIN_COMMIT}\n`, stderr: "" };
          }
          if (key === "gh release view --repo jemdiggity/kanna --json tagName,publishedAt") {
            return { exitCode: 0, stdout: '{"tagName":"v1.2.3","publishedAt":"2026-07-01T00:00:00Z"}\n', stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "download") {
            const dirIndex = args.indexOf("--dir");
            const dir = args[dirIndex + 1];
            expect(typeof dir).toBe("string");
            writeFileSync(join(dir ?? "", "latest-staging.json"), '{"version":"1.2.4-staging.3"}\n');
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "gh release view v1.2.4-staging.3 --repo jemdiggity/kanna --json targetCommitish,body") {
            return { exitCode: 0, stdout: `{"targetCommitish":"${MAIN_COMMIT}"}\n`, stderr: "" };
          }
          if (key === `git rev-list --count ${MAIN_COMMIT}..origin/main`) {
            return { exitCode: 0, stdout: "0\n", stderr: "" };
          }
          if (key === "git rev-list --count v1.2.3..origin/main") {
            return { exitCode: 0, stdout: "12\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      const result = await releaseStatus({ repoRoot: root, env: {}, runner });

      expect(result).toEqual({
        production: { version: "1.2.3", tag: "v1.2.3", publishedAt: "2026-07-01T00:00:00Z" },
        staging: { version: "1.2.4-staging.3", tag: "v1.2.4-staging.3", commit: MAIN_COMMIT, sourceBranch: null, commitsBehindMain: 0 },
        releaseBranch: null,
        commitsOnMainSinceProduction: 12,
        promotable: true,
        promoteCommand: "kd release promote 1.2.4-staging.3"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a stale staging pointer as not promotable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const staleCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const runner: CommandRunner = {
        async run(command, args) {
          const key = `${command} ${args.join(" ")}`;
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (key === "git fetch --tags origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse origin/main") {
            return { exitCode: 0, stdout: `${MAIN_COMMIT}\n`, stderr: "" };
          }
          if (key === "gh release view --repo jemdiggity/kanna --json tagName,publishedAt") {
            return { exitCode: 0, stdout: '{"tagName":"v1.2.3","publishedAt":"2026-07-01T00:00:00Z"}\n', stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "download") {
            const dirIndex = args.indexOf("--dir");
            writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), '{"version":"1.2.4-staging.3"}\n');
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "gh release view v1.2.4-staging.3 --repo jemdiggity/kanna --json targetCommitish,body") {
            return { exitCode: 0, stdout: `{"targetCommitish":"${staleCommit}"}\n`, stderr: "" };
          }
          if (key === `git rev-list --count ${staleCommit}..origin/main`) {
            return { exitCode: 0, stdout: "7\n", stderr: "" };
          }
          if (key === "git rev-list --count v1.2.3..origin/main") {
            return { exitCode: 0, stdout: "19\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      const result = await releaseStatus({ repoRoot: root, env: {}, runner });

      expect(result.staging).toEqual({ version: "1.2.4-staging.3", tag: "v1.2.4-staging.3", commit: staleCommit, sourceBranch: null, commitsBehindMain: 7 });
      expect(result.promotable).toBe(false);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the release branch tip as the promotion base when one exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const rcCommit = "cccccccccccccccccccccccccccccccccccccccc";
      const runner: CommandRunner = {
        async run(command, args) {
          const key = `${command} ${args.join(" ")}`;
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (key === "git fetch --tags origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse origin/main") {
            return { exitCode: 0, stdout: `${MAIN_COMMIT}\n`, stderr: "" };
          }
          if (key === "gh release view --repo jemdiggity/kanna --json tagName,publishedAt") {
            return { exitCode: 1, stdout: "", stderr: "no production release" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "download") {
            const dirIndex = args.indexOf("--dir");
            writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), '{"version":"1.3.0-staging.2"}\n');
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "gh release view v1.3.0-staging.2 --repo jemdiggity/kanna --json targetCommitish,body") {
            return { exitCode: 0, stdout: `{"targetCommitish":"${rcCommit}"}\n`, stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: `${rcCommit}\trefs/heads/release/1.3\n`, stderr: "" };
          }
          if (key === `git rev-list --count ${rcCommit}..origin/main`) {
            return { exitCode: 0, stdout: "5\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      const result = await releaseStatus({ repoRoot: root, env: {}, runner });

      expect(result.releaseBranch).toEqual({ name: "release/1.3", commit: rcCommit });
      expect(result.staging?.commitsBehindMain).toBe(5);
      expect(result.promotable).toBe(true);
      expect(result.promoteCommand).toBe("kd release promote 1.3.0-staging.2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a main RC promotable when a dormant same-series release branch exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const dormantCommit = "dddddddddddddddddddddddddddddddddddddddd";
      const runner: CommandRunner = {
        async run(command, args) {
          const key = `${command} ${args.join(" ")}`;
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (key === "git fetch --tags origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse origin/main") {
            return { exitCode: 0, stdout: `${MAIN_COMMIT}\n`, stderr: "" };
          }
          if (key === "gh release view --repo jemdiggity/kanna --json tagName,publishedAt") {
            return { exitCode: 0, stdout: '{"tagName":"v1.3.0","publishedAt":"2026-07-10T00:00:00Z"}\n', stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "download") {
            const dirIndex = args.indexOf("--dir");
            writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), '{"version":"1.3.1-staging.1"}\n');
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "gh release view v1.3.1-staging.1 --repo jemdiggity/kanna --json targetCommitish,body") {
            return {
              exitCode: 0,
              stdout: `{"targetCommitish":"${MAIN_COMMIT}","body":"Staging updater manifest for v1.3.1-staging.1\\n\\nSource-Branch: main"}\n`,
              stderr: ""
            };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: `${dormantCommit}\trefs/heads/release/1.3\n`, stderr: "" };
          }
          if (key === `git rev-list --count ${MAIN_COMMIT}..origin/main`) {
            return { exitCode: 0, stdout: "0\n", stderr: "" };
          }
          if (key === "git rev-list --count v1.3.0..origin/main") {
            return { exitCode: 0, stdout: "9\n", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      const result = await releaseStatus({ repoRoot: root, env: {}, runner });

      expect(result.staging?.sourceBranch).toBe("main");
      expect(result.releaseBranch).toEqual({ name: "release/1.3", commit: dormantCommit });
      expect(result.promotable).toBe(true);
      expect(result.promoteCommand).toBe("kd release promote 1.3.1-staging.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty channels when no releases exist yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner: CommandRunner = {
        async run(command, args) {
          const key = `${command} ${args.join(" ")}`;
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (key === "git fetch --tags origin main") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse origin/main") {
            return { exitCode: 0, stdout: `${MAIN_COMMIT}\n`, stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "not found" };
        }
      };

      const result = await releaseStatus({ repoRoot: root, env: {}, runner });

      expect(result).toEqual({
        production: null,
        staging: null,
        releaseBranch: null,
        commitsOnMainSinceProduction: null,
        promotable: false,
        promoteCommand: null
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
