import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../src/runtime/process";

vi.mock("../src/runtime/updater-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/updater-key")>();
  return {
    ...actual,
    preflightUpdaterSigningKey: vi.fn(async (input: { env: NodeJS.ProcessEnv }) => {
      const keyPath = input.env.TAURI_PRIVATE_KEY_PATH;
      if (!keyPath) throw new Error("Missing TAURI_PRIVATE_KEY_PATH.");
      const permissions = statSync(keyPath).mode & 0o777;
      if (permissions !== 0o400 && permissions !== 0o600) {
        throw new Error("Tauri updater private key must have owner-only read permissions.");
      }
      return readFileSync(keyPath, "utf8").trim();
    })
  };
});
import {
  bazelTargetForLabel,
  compareVersions,
  createUpdaterBundle,
  cutReleaseBranch,
  deriveMainStagingBaseVersion,
  nextSeriesPatchVersion,
  parsePromotionVersions,
  parseReleaseBranchSeries,
  releaseAssetName,
  releaseSeriesBranch,
  releaseSeriesFromVersion,
  releaseStatus,
  resetStagingLineage,
  shipRelease,
  updaterAssetName,
  updaterBundleTargetForLabel,
  updaterSignatureName,
  type ReleaseArchLabel,
  type ReleaseResetStagingInput,
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
  writeFileSync(privateKeyPath, "private key\n", { mode: 0o600 });
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

/**
 * `readStagingChannel` asks for the pointer release's asset list before it will
 * trust (or distrust) the channel, so fixtures have to answer that query
 * explicitly. `null` models a channel that does not exist at all — a genuine
 * 404, which is the only shape that reads as "uninitialized".
 */
function stagingChannelAssetsResponse(assets: string[] | null): { exitCode: number; stdout: string; stderr: string } {
  if (assets === null) return { exitCode: 1, stdout: "", stderr: "release not found\n" };
  return { exitCode: 0, stdout: JSON.stringify({ assets: assets.map((name) => ({ name })) }), stderr: "" };
}

function isStagingChannelAssetsQuery(command: string, args: string[]): boolean {
  return (
    command === "gh" &&
    args[0] === "release" &&
    args[1] === "view" &&
    args[2] === "desktop-staging" &&
    args.includes("--json") &&
    args.includes("assets")
  );
}

function isLatestProductionReleaseQuery(command: string, args: string[]): boolean {
  return (
    command === "gh" &&
    args[0] === "release" &&
    args[1] === "list" &&
    args.includes("--exclude-pre-releases")
  );
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
      writeFileSync(privateKeyPath, "private key\n", { mode: 0o600 });

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
        env: releaseEnv(privateKeyPath),
        runner
      };

      await createUpdaterBundle(input, bundleSource, bundlePath, signaturePath);

      expect(readFileSync(bundlePath, "utf8")).toBe("bazel updater archive\n");
      expect(readFileSync(signaturePath, "utf8")).toBe("signed bundle\n");
      expect(calls.some((call) => call.command === "tar")).toBe(false);
      const signerCall = calls.find((call) => call.command === "pnpm");
      expect(signerCall?.args).toEqual([
        "--dir",
        join(repoRoot, "apps", "desktop"),
        "exec",
        "tauri",
        "signer",
        "sign",
        bundlePath
      ]);
      // The key and its password travel through the signer's environment, never
      // argv, so neither is visible to other processes via ps.
      expect(signerCall?.args).not.toContain("private key");
      expect(signerCall?.args).not.toContain("password");
      expect(signerCall?.options?.env?.TAURI_SIGNING_PRIVATE_KEY).toBe("private key");
      expect(signerCall?.options?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores an ambient key password and always passes an explicit empty one", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const repoRoot = join(root, "repo");
      const bundleSource = join(repoRoot, "bazel-out", "release", "Kanna.app.tar.gz");
      const bundlePath = join(repoRoot, ".build", "release", "Kanna.app.tar.gz");
      const signaturePath = `${bundlePath}.sig`;
      const privateKeyPath = join(root, "updater-private.key");

      mkdirSync(join(repoRoot, "bazel-out", "release"), { recursive: true });
      mkdirSync(join(repoRoot, ".build", "release"), { recursive: true });
      writeFileSync(bundleSource, "bazel updater archive\n");
      writeFileSync(privateKeyPath, "private key\n", { mode: 0o600 });

      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "pnpm") {
            writeFileSync(`${args.at(-1)}.sig`, "signed bundle\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${command}` };
        }
      };

      await createUpdaterBundle(
        {
          repoRoot,
          bump: "patch",
          archLabels: ["arm64"],
          release: false,
          dryRun: true,
          // Updater keys used by kd are unencrypted. An ambient
          // TAURI_PRIVATE_KEY_PASSWORD must not reach the signer, and an
          // absent one must not leave it prompting on a TTY -- that prompt used
          // to kill non-interactive ships after the whole build had completed.
          env: { ...releaseEnv(privateKeyPath), TAURI_PRIVATE_KEY_PASSWORD: "stale ambient value" },
          runner
        },
        bundleSource,
        bundlePath,
        signaturePath
      );

      const signerEnv = calls.find((call) => call.command === "pnpm")?.options?.env;
      expect(signerEnv?.TAURI_SIGNING_PRIVATE_KEY).toBe("private key");
      expect(signerEnv?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose signer output when signing fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const repoRoot = join(root, "repo");
      const bundleSource = join(repoRoot, "bundle.app.tar.gz");
      const bundlePath = join(repoRoot, "signed.app.tar.gz");
      const privateKeyPath = join(root, "updater-private.key");
      mkdirSync(repoRoot, { recursive: true });
      writeFileSync(bundleSource, "bundle\n");
      writeFileSync(privateKeyPath, "secret updater key\n", { mode: 0o600 });
      const runner: CommandRunner = {
        async run() {
          return {
            exitCode: 1,
            stdout: "secret updater key",
            stderr: "TAURI_SIGNING_PRIVATE_KEY=secret updater key"
          };
        }
      };

      let message = "";
      try {
        await createUpdaterBundle(
          {
            repoRoot,
            bump: "patch",
            archLabels: ["arm64"],
            release: false,
            dryRun: true,
            env: releaseEnv(privateKeyPath),
            runner
          },
          bundleSource,
          bundlePath,
          `${bundlePath}.sig`
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/Tauri updater signing failed/);
      expect(message).not.toContain("secret updater key");
      expect(message).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release shipping", () => {
  it.each([
    ["dry-run", { dryRun: true, release: false, environment: "production" as const }],
    ["staging", { dryRun: false, release: false, environment: "staging" as const }],
    ["production", { dryRun: false, release: true, environment: "production" as const }],
    ["promotion", {
      dryRun: false,
      release: true,
      environment: "production" as const,
      promoteFrom: "1.2.4-staging.3"
    }]
  ])("preflights the selected key file before mutations for %s", async (_label, mode) => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      chmodSync(privateKeyPath, 0o644);
      const originalFiles = readVersionFiles(repoRoot);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "must not run after failed preflight" };
        }
      };

      await expect(shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: mode.release ? ["arm64", "x86_64"] : ["arm64"],
        ...mode,
        env: releaseEnv(privateKeyPath),
        runner
      })).rejects.toThrow(/owner-only read permissions/);
      expect(calls).toEqual([]);
      expect(readVersionFiles(repoRoot)).toEqual(originalFiles);
      expect(existsSync(join(repoRoot, ".build", "release"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses staging artifact names and Bazel targets when shipping staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (isStagingChannelAssetsQuery(command, args)) return stagingChannelAssetsResponse(null);
          if (command === "git" && args.join(" ") === "status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "main\n", stderr: "" };
          }
          if (command === "git" && args.join(" ") === "rev-parse HEAD") {
            return { exitCode: 0, stdout: "1234567890abcdef\n", stderr: "" };
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
          if (isLatestProductionReleaseQuery(command, args)) {
            return { exitCode: 0, stdout: "[]", stderr: "" };
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
          if (isStagingChannelAssetsQuery(command, args)) return stagingChannelAssetsResponse(null);
          const key = `${command} ${args.join(" ")}`;
          if (key === "git status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "release/1.3\n", stderr: "" };
          }
          if (key === "git rev-parse HEAD") {
            return { exitCode: 0, stdout: "branchsha\n", stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: "branchsha\trefs/heads/release/1.3\n", stderr: "" };
          }
          if (key === "git fetch origin release/1.3") {
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
          if (isStagingChannelAssetsQuery(command, args)) return stagingChannelAssetsResponse(null);
          const key = `${command} ${args.join(" ")}`;
          if (key === "git status --porcelain") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (key === "git rev-parse HEAD") {
            return { exitCode: 0, stdout: `${branchSha}\n`, stderr: "" };
          }
          if (key === "git ls-remote origin refs/heads/release/1.3") {
            return { exitCode: 0, stdout: `${branchSha}\trefs/heads/release/1.3\n`, stderr: "" };
          }
          if (key === "git fetch origin release/1.3") {
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

  it("refuses a --branch RC when HEAD is not exactly the release branch tip", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const branchSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          if (isStagingChannelAssetsQuery(command, args)) return stagingChannelAssetsResponse(null);
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
          // A task worktree that merged the branch in still descends from the
          // tip; only an exact match may claim the branch as its RC provenance.
          if (key === "git rev-parse HEAD") {
            return { exitCode: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
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
      })).rejects.toThrow(/release\/1\.3 tip .* is not HEAD/);
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
      const ACTIVE_VERSION = "1.2.4-staging.4";
      const ACTIVE_COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          // The channel already serves a candidate; this publish is the normal
          // forward move from it, so the lineage gate has something to compare.
          if (command === "gh" && args[0] === "release" && args[1] === "download" && args[2] === "desktop-staging") {
            const dirIndex = args.indexOf("--dir");
            writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), `{"version":"${ACTIVE_VERSION}"}\n`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "view" && args[2] === `v${ACTIVE_VERSION}`) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                targetCommitish: ACTIVE_COMMIT,
                publishedAt: "2026-07-06T00:00:00Z",
                body: "Staging updater manifest\n\nSource-Branch: main"
              }),
              stderr: ""
            };
          }
          if (command === "git" && args.join(" ") === "fetch --tags origin") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "merge-base") {
            return {
              exitCode: args[2] === ACTIVE_COMMIT && args[3] === "1234567890abcdef" ? 0 : 1,
              stdout: "",
              stderr: ""
            };
          }
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
          if (isLatestProductionReleaseQuery(command, args)) {
            return { exitCode: 0, stdout: "[]", stderr: "" };
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
      const ACTIVE_VERSION = "1.2.4-staging.6";
      const ACTIVE_COMMIT = "ffffffffffffffffffffffffffffffffffffffff";
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          // The channel already serves a candidate; this publish is the normal
          // forward move from it, so the lineage gate has something to compare.
          if (command === "gh" && args[0] === "release" && args[1] === "download" && args[2] === "desktop-staging") {
            const dirIndex = args.indexOf("--dir");
            writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), `{"version":"${ACTIVE_VERSION}"}\n`);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "release" && args[1] === "view" && args[2] === `v${ACTIVE_VERSION}`) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                targetCommitish: ACTIVE_COMMIT,
                publishedAt: "2026-07-06T00:00:00Z",
                body: "Staging updater manifest\n\nSource-Branch: main"
              }),
              stderr: ""
            };
          }
          if (command === "git" && args.join(" ") === "fetch --tags origin") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "merge-base") {
            return {
              exitCode: args[2] === ACTIVE_COMMIT && args[3] === "1234567890abcdef" ? 0 : 1,
              stdout: "",
              stderr: ""
            };
          }
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
          if (isLatestProductionReleaseQuery(command, args)) {
            return { exitCode: 0, stdout: "[]", stderr: "" };
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
  const PREVIOUS_RC_COMMIT = "9999999999999999999999999999999999999999";
  const RC_PUBLISHED_AT = "2026-07-01T00:00:00Z";
  // Four days after the RC was published: past the 24h default soak window.
  const PROMOTION_NOW = Date.parse("2026-07-05T00:00:00Z");

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
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tagName: "v1.2.4-staging.3",
              targetCommitish: STAGING_COMMIT,
              body: "Staging updater manifest for v1.2.4-staging.3\n\nSource-Branch: main",
              publishedAt: RC_PUBLISHED_AT,
              isPrerelease: true
            }),
            stderr: ""
          };
        }
        if (command === "gh" && args.join(" ").startsWith("release download v1.2.4-staging.3")) {
          const dirIndex = args.indexOf("--dir");
          writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), '{"version":"1.2.4-staging.3"}\n');
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // Lineage: the RC being promoted descends from the candidate it replaced.
        if (command === "gh" && args[0] === "release" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              { tagName: "v1.2.4-staging.3", createdAt: RC_PUBLISHED_AT },
              { tagName: "v1.2.4-staging.2", createdAt: "2026-06-28T00:00:00Z" }
            ]),
            stderr: ""
          };
        }
        if (command === "gh" && args.join(" ").startsWith("release view v1.2.4-staging.2")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tagName: "v1.2.4-staging.2",
              targetCommitish: PREVIOUS_RC_COMMIT,
              body: "Staging updater manifest for v1.2.4-staging.2\n\nSource-Branch: main",
              publishedAt: "2026-06-28T00:00:00Z",
              isPrerelease: true
            }),
            stderr: ""
          };
        }
        if (command === "gh" && args.join(" ").startsWith("release view desktop-staging")) {
          return { exitCode: 0, stdout: '{"body":"Pointer-only desktop staging updater channel."}', stderr: "" };
        }
        if (key === "git fetch --tags origin") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (key === `git merge-base --is-ancestor ${PREVIOUS_RC_COMMIT} ${STAGING_COMMIT}`) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "ls-remote --tags origin v1.2.4") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ").startsWith("ls-remote --tags origin refs/tags/v1.2.4-staging.3")) {
          return { exitCode: 0, stdout: `${STAGING_COMMIT}\trefs/tags/v1.2.4-staging.3\n`, stderr: "" };
        }
        if (command === "git" && args.join(" ") === "fetch --no-tags origin refs/tags/v1.2.4-staging.3") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args.join(" ") === "rev-parse FETCH_HEAD^{commit}") {
          return { exitCode: 0, stdout: `${STAGING_COMMIT}\n`, stderr: "" };
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
      now: PROMOTION_NOW,
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

  it("rejects staging release metadata that does not name the selected prerelease", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release view v1.2.4-staging.3": {
          exitCode: 0,
          stdout: JSON.stringify({
            tagName: "v1.2.4-staging.30",
            targetCommitish: STAGING_COMMIT,
            body: "Staging updater manifest for v1.2.4-staging.3\n\nSource-Branch: main",
            publishedAt: RC_PUBLISHED_AT,
            isPrerelease: true
          }),
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /metadata tag v1\.2\.4-staging\.30 does not match selected tag v1\.2\.4-staging\.3/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a GitHub release that is not a prerelease", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release view v1.2.4-staging.3": {
          exitCode: 0,
          stdout: JSON.stringify({
            tagName: "v1.2.4-staging.3",
            targetCommitish: STAGING_COMMIT,
            body: "Staging updater manifest for v1.2.4-staging.3\n\nSource-Branch: main",
            publishedAt: RC_PUBLISHED_AT,
            isPrerelease: false
          }),
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/is not marked as a GitHub prerelease/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a candidate whose versioned staging manifest cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "gh release download v1.2.4-staging.3": { exitCode: 1, stdout: "", stderr: "manifest unavailable" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /Staging manifest asset not found.*manifest unavailable/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a staging tag whose remote commit disagrees with release metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const mismatchedCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const runner = promoteRunner({
        "git ls-remote --tags origin refs/tags/v1.2.4-staging.3": {
          exitCode: 0,
          stdout: `${mismatchedCommit}\trefs/tags/v1.2.4-staging.3\n`,
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        new RegExp(`tag resolves to ${mismatchedCommit}.*records ${STAGING_COMMIT}`)
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks the fetched staging tag before building", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const fetchedCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const runner = promoteRunner({
        "git rev-parse FETCH_HEAD^{commit}": { exitCode: 0, stdout: `${fetchedCommit}\n`, stderr: "" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        new RegExp(`Fetched v1\\.2\\.4-staging\\.3 resolves to ${fetchedCommit}.*verified immutable commit is ${STAGING_COMMIT}`)
      );
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
          stdout: `{"tagName":"v1.2.4-staging.3","targetCommitish":"${STAGING_COMMIT}","publishedAt":"${RC_PUBLISHED_AT}","body":"Staging updater manifest for v1.2.4-staging.3\\n\\nSource-Branch: release/1.2","isPrerelease":true}\n`,
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
          stdout: `{"tagName":"v1.2.4-staging.3","targetCommitish":"${STAGING_COMMIT}","publishedAt":"${RC_PUBLISHED_AT}","body":"Staging updater manifest for v1.2.4-staging.3\\n\\nSource-Branch: main","isPrerelease":true}\n`,
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
          stdout: `{"tagName":"v1.2.4-staging.3","targetCommitish":"${STAGING_COMMIT}","publishedAt":"${RC_PUBLISHED_AT}","body":"Staging updater manifest for v1.2.4-staging.3\\n\\nSource-Branch: release/1.2","isPrerelease":true}\n`,
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(/was built from release\/1\.2, but the branch no longer exists/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote a candidate whose lineage diverged from the one it replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        [`git merge-base --is-ancestor ${PREVIOUS_RC_COMMIT} ${STAGING_COMMIT}`]: { exitCode: 1, stdout: "", stderr: "" },
        [`git merge-base --is-ancestor ${STAGING_COMMIT} ${PREVIOUS_RC_COMMIT}`]: { exitCode: 1, stdout: "", stderr: "" }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /share only an older merge base/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote before the policy soak window has elapsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({}, repoRoot, new Map(), calls);

      await expect(
        shipRelease({ ...promoteInput(repoRoot, privateKeyPath, runner), now: Date.parse("2026-07-01T05:00:00Z") })
      ).rejects.toThrow(/soaked 5\.0h of the required 24h/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("promotes inside the soak window only through the explicit human override", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({}, repoRoot, outputs, calls);

      const result = await shipRelease({
        ...promoteInput(repoRoot, privateKeyPath, runner),
        now: Date.parse("2026-07-01T05:00:00Z"),
        soakOverrideReason: "Grace requested the ship; the fix is a one-line crash guard"
      });

      expect(result.version).toBe("1.2.4");
      expect(calls.some((call) => call.command === "bazel" && call.args[0] === "build")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the same gates for a --dry-run rehearsal", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({}, repoRoot, new Map(), calls);

      await expect(
        shipRelease({
          ...promoteInput(repoRoot, privateKeyPath, runner),
          release: false,
          dryRun: true,
          now: Date.parse("2026-07-01T05:00:00Z")
        })
      ).rejects.toThrow(/soaked 5\.0h of the required 24h/);
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to promote a candidate from an abandoned series", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = promoteRunner({
        "git ls-remote --tags origin refs/tags/abandoned/release/1.2": {
          exitCode: 0,
          stdout: "sha\trefs/tags/abandoned/release/1.2\n",
          stderr: ""
        },
        "git for-each-ref": {
          exitCode: 0,
          stdout: "Abandoned release/1.2 at 2026-08-13T09:00:00.000Z\n\nReason: superseded by 1.3\n",
          stderr: ""
        }
      }, repoRoot, new Map(), calls);

      await expect(shipRelease(promoteInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /release\/1\.2 was abandoned on 2026-08-13T09:00:00\.000Z: superseded by 1\.3/
      );
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

  it("floors a main staging version above production when VERSION is stale", () => {
    const derivation = deriveMainStagingBaseVersion("0.0.68", "0.2.0", "patch");
    expect(derivation.baseVersion).toBe("0.2.1");
    expect(compareVersions(derivation.baseVersion, "0.2.0")).toBeGreaterThan(0);
    expect(derivation.versionFloor?.detail).toMatch(/VERSION 0\.0\.68 lags latest production v0\.2\.0/);

    expect(deriveMainStagingBaseVersion("0.3.0", "0.2.0", "patch")).toEqual({
      baseVersion: "0.3.1",
      versionFloor: null
    });
  });
});

describe("release cut", () => {
  const MAIN_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
  const RELEASE_01_SHA = "0101010101010101010101010101010101010101";
  const CUT_NOW = Date.parse("2026-08-13T09:00:00Z");

  interface CutFixture {
    trunkVersion?: string;
    /** Release branches present on origin, as branch -> tip sha. */
    releaseBranches?: Record<string, string>;
    /** Production tags present on origin, without the leading v. */
    productionTags?: string[];
    /**
     * Staging prereleases present on origin, without the leading v. Real
     * `ls-remote --tags origin 'vX.Y.*'` returns these alongside production
     * tags: it expands the pattern with a leading wildcard-and-slash, and that
     * wildcard crosses path separators.
     */
    stagingTags?: string[];
    /** Series already carrying an abandonment tag, as `X.Y` -> tag message. */
    abandonedSeries?: Record<string, string>;
    activeStagingVersion?: string | null;
    activeStagingSourceBranch?: string;
    channelBody?: string;
  }

  function cutRunner(fixture: CutFixture, calls: CommandCall[]): CommandRunner {
    const branches = fixture.releaseBranches ?? {};
    return {
      async run(command, args, options) {
        calls.push({ command, args, options });
        const key = `${command} ${args.join(" ")}`;
        if (key === "git fetch origin main") return { exitCode: 0, stdout: "", stderr: "" };
        if (key === "git rev-parse origin/main") return { exitCode: 0, stdout: `${MAIN_SHA}\n`, stderr: "" };
        if (key === "git show origin/main:VERSION") {
          return { exitCode: 0, stdout: `${fixture.trunkVersion ?? "1.2.3"}\n`, stderr: "" };
        }
        if (key === "git remote get-url origin") {
          return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
        }
        if (key === "git ls-remote --heads origin refs/heads/release/*") {
          return {
            exitCode: 0,
            stdout: Object.entries(branches).map(([branch, sha]) => `${sha}\trefs/heads/${branch}`).join("\n"),
            stderr: ""
          };
        }
        if (command === "git" && args[0] === "ls-remote" && args[1] === "--tags") {
          const pattern = args[3] ?? "";
          const abandonedMatch = /^refs\/tags\/abandoned\/release\/(\d+\.\d+)$/.exec(pattern);
          if (abandonedMatch) {
            const has = Boolean(fixture.abandonedSeries?.[abandonedMatch[1] ?? ""]);
            return { exitCode: 0, stdout: has ? `sha\t${pattern}\n` : "", stderr: "" };
          }
          const seriesMatch = /^v(\d+\.\d+)\.\*$/.exec(pattern);
          if (seriesMatch) {
            const series = seriesMatch[1] ?? "";
            const matched = [...(fixture.productionTags ?? []), ...(fixture.stagingTags ?? [])].filter((tag) =>
              tag.startsWith(`${series}.`)
            );
            return {
              exitCode: 0,
              stdout: matched.map((tag) => `sha\trefs/tags/v${tag}`).join("\n"),
              stderr: ""
            };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "for-each-ref") {
          const ref = args[2] ?? "";
          const series = /abandoned\/release\/(\d+\.\d+)$/.exec(ref)?.[1] ?? "";
          return { exitCode: 0, stdout: fixture.abandonedSeries?.[series] ?? "", stderr: "" };
        }
        if (isStagingChannelAssetsQuery(command, args)) {
          return stagingChannelAssetsResponse(fixture.activeStagingVersion ? ["latest-staging.json"] : null);
        }
        if (command === "gh" && args[0] === "release" && args[1] === "download") {
          if (!fixture.activeStagingVersion) return { exitCode: 1, stdout: "", stderr: "release not found" };
          const dirIndex = args.indexOf("--dir");
          writeFileSync(
            join(args[dirIndex + 1] ?? "", "latest-staging.json"),
            `{"version":"${fixture.activeStagingVersion}"}\n`
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "gh" && args[1] === "view" && args[2] === "desktop-staging") {
          return { exitCode: 0, stdout: JSON.stringify({ body: fixture.channelBody ?? "" }), stderr: "" };
        }
        if (command === "gh" && args[0] === "release" && args[1] === "view") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              targetCommitish: RELEASE_01_SHA,
              publishedAt: "2026-08-01T00:00:00Z",
              body: `Staging updater manifest\n\nSource-Branch: ${fixture.activeStagingSourceBranch ?? "main"}`
            }),
            stderr: ""
          };
        }
        if (command === "git" && (args[0] === "fetch" || args[0] === "push" || args[0] === "tag")) {
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
      const result = await cutReleaseBranch({ repoRoot, bump: "minor", env: {}, runner: cutRunner({}, calls) });

      expect(result).toEqual({
        branch: "release/1.3",
        version: "1.3.0",
        commit: MAIN_SHA,
        trunkVersion: "1.2.3",
        abandoned: []
      });
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
      // Local worktree VERSION is 1.2.3, but the branch is pushed at
      // origin/main whose VERSION is 1.4.7 — the series must follow the latter.
      const result = await cutReleaseBranch({
        repoRoot,
        bump: "minor",
        env: {},
        runner: cutRunner({ trunkVersion: "1.4.7" }, calls)
      });

      expect(result.branch).toBe("release/1.5");
      expect(result.version).toBe("1.5.0");
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
      const runner = cutRunner({ releaseBranches: { "release/1.3": MAIN_SHA } }, calls);

      await expect(cutReleaseBranch({ repoRoot, bump: "minor", env: {}, runner })).rejects.toThrow(/release\/1\.3 already exists/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The recovery case: trunk still records 0.0.68, release/0.1 exists and its
  // RC is being abandoned rather than promoted, and the intended next series is
  // 0.2. Bump inference cannot express that — --minor would aim back at 0.1 —
  // and nothing here may promote 0.1.0, delete release/0.1, or hand-push a ref.
  const recoveryFixture: CutFixture = {
    trunkVersion: "0.0.68",
    releaseBranches: { "release/0.1": RELEASE_01_SHA },
    // The series being abandoned has shipped RCs — every real one has — and
    // those prereleases come back from the same ls-remote glob that looks for
    // production tags. Only a vX.Y.Z tag means the series actually released.
    stagingTags: ["0.1.0-staging.7", "0.1.0-staging.8"],
    activeStagingVersion: "0.1.0-staging.8",
    activeStagingSourceBranch: "release/0.1",
    channelBody: [
      "Pointer-only desktop staging updater channel.",
      "",
      "Lineage-Reset: 2026-08-13T08:00:00Z",
      `Reset-From: 0.1.0-staging.8 (${RELEASE_01_SHA}) source release/0.1`,
      "Reset-To: release/0.2",
      "Reset-Reason: abandoning the 0.1 series"
    ].join("\n")
  };

  it("cuts an explicitly named next series while abandoning the series it steps over", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const result = await cutReleaseBranch({
        repoRoot,
        bump: "minor",
        version: "0.2.0",
        abandonSeries: ["0.1"],
        reason: "0.1 diverged from main and will never ship",
        now: CUT_NOW,
        env: {},
        runner: cutRunner(recoveryFixture, calls)
      });

      expect(result).toEqual({
        branch: "release/0.2",
        version: "0.2.0",
        commit: MAIN_SHA,
        trunkVersion: "0.0.68",
        abandoned: [
          {
            series: "0.1",
            branch: "release/0.1",
            commit: RELEASE_01_SHA,
            tag: "abandoned/release/0.1",
            reason: "0.1 diverged from main and will never ship",
            abandonedAt: "2026-08-13T09:00:00.000Z",
            alreadyAbandoned: false
          }
        ]
      });

      const tagCall = calls.find((call) => call.command === "git" && call.args[0] === "tag");
      expect(tagCall?.args.slice(0, 5)).toEqual(["tag", "-f", "-a", "abandoned/release/0.1", RELEASE_01_SHA]);
      expect(tagCall?.args.at(-1)).toContain("Reason: 0.1 diverged from main and will never ship");
      const pushes = calls.filter((call) => call.command === "git" && call.args[0] === "push").map((call) => call.args.join(" "));
      // The abandonment record lands before the skip becomes real, the branch is
      // never deleted, and no v0.1.0 production tag is created to advance VERSION.
      expect(pushes).toEqual([
        "push origin refs/tags/abandoned/release/0.1",
        `push origin ${MAIN_SHA}:refs/heads/release/0.2`
      ]);
      expect(calls.some((call) => call.command === "git" && call.args.includes("--delete"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to silently step over an unreleased series", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];

      await expect(
        cutReleaseBranch({ repoRoot, bump: "minor", version: "0.2.0", env: {}, runner: cutRunner(recoveryFixture, calls) })
      ).rejects.toThrow(/--abandon-series 0\.1 --reason/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "tag")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a reason before recording an abandonment", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];

      await expect(
        cutReleaseBranch({
          repoRoot,
          bump: "minor",
          version: "0.2.0",
          abandonSeries: ["0.1"],
          env: {},
          runner: cutRunner(recoveryFixture, calls)
        })
      ).rejects.toThrow(/requires --reason/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the staging channel to be released from the abandoned series first", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];

      await expect(
        cutReleaseBranch({
          repoRoot,
          bump: "minor",
          version: "0.2.0",
          abandonSeries: ["0.1"],
          reason: "0.1 diverged",
          env: {},
          runner: cutRunner({ ...recoveryFixture, channelBody: "" }, calls)
        })
      ).rejects.toThrow(/kd release reset-staging --to release\/0\.2 .* --confirm-abandon 0\.1\.0-staging\.8/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to abandon a series while the channel cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          if (isStagingChannelAssetsQuery(command, args)) {
            calls.push({ command, args, options });
            return { exitCode: 1, stdout: "", stderr: "HTTP 503: Service unavailable" };
          }
          return cutRunner(recoveryFixture, calls).run(command, args, options);
        }
      };

      await expect(
        cutReleaseBranch({
          repoRoot,
          bump: "minor",
          version: "0.2.0",
          abandonSeries: ["0.1"],
          reason: "0.1 diverged",
          env: {},
          runner
        })
      ).rejects.toThrow(/Cannot tell whether desktop-staging still serves the series being abandoned/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "tag")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require re-abandoning a series that already carries the record", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const result = await cutReleaseBranch({
        repoRoot,
        bump: "minor",
        version: "0.3.0",
        now: CUT_NOW,
        env: {},
        runner: cutRunner(
          {
            ...recoveryFixture,
            releaseBranches: { "release/0.1": RELEASE_01_SHA, "release/0.2": MAIN_SHA },
            abandonedSeries: {
              "0.1": "Abandoned release/0.1 at 2026-08-13T09:00:00.000Z\n\nReason: 0.1 diverged\n"
            },
            productionTags: ["0.2.0"],
            activeStagingVersion: null
          },
          calls
        )
      });

      expect(result.abandoned).toEqual([
        {
          series: "0.1",
          branch: "release/0.1",
          commit: RELEASE_01_SHA,
          tag: "abandoned/release/0.1",
          reason: "0.1 diverged",
          abandonedAt: "2026-08-13T09:00:00.000Z",
          alreadyAbandoned: true
        }
      ]);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "tag")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicit target that is not a series start or is not ahead of trunk", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = cutRunner({ trunkVersion: "0.0.68" }, calls);

      await expect(cutReleaseBranch({ repoRoot, bump: "minor", version: "0.2.3", env: {}, runner })).rejects.toThrow(
        /A series cut starts at patch 0/
      );
      await expect(cutReleaseBranch({ repoRoot, bump: "minor", version: "0.0.0", env: {}, runner })).rejects.toThrow(
        /not ahead of origin\/main's VERSION/
      );
      await expect(
        cutReleaseBranch({ repoRoot, bump: "minor", version: "0.2.0", abandonSeries: ["9.9"], reason: "x", env: {}, runner })
      ).rejects.toThrow(/does not name a release branch this cut steps over/);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not ask to abandon a series that already shipped a production release", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const result = await cutReleaseBranch({
        repoRoot,
        bump: "minor",
        version: "0.3.0",
        env: {},
        runner: cutRunner(
          {
            trunkVersion: "0.0.68",
            releaseBranches: { "release/0.1": RELEASE_01_SHA },
            productionTags: ["0.1.0"],
            activeStagingVersion: null
          },
          calls
        )
      });

      expect(result.abandoned).toEqual([]);
      expect(result.branch).toBe("release/0.3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release status", () => {
  const MAIN_COMMIT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
  const PREVIOUS_RC_COMMIT = "9999999999999999999999999999999999999999";
  const NOW = Date.parse("2026-07-08T00:00:00Z");

  interface StatusFixture {
    activeVersion: string | null;
    activeCommit?: string | null;
    activeSourceBranch?: string | null;
    activePublishedAt?: string | null;
    activeTagName?: string;
    activeIsPrerelease?: boolean;
    activeTagCommit?: string;
    productionTag?: string | null;
    productionPublishedAt?: string;
    /** Ordered newest-first list of staging prereleases on the repo. */
    candidateTags?: string[];
    previousCommit?: string | null;
    /** Result of `git merge-base --is-ancestor <previous> <active>`. */
    previousIsAncestor?: number;
    /** Result of `git merge-base --is-ancestor <active> <previous>`. */
    activeIsAncestor?: number;
    releaseBranchSha?: string | null;
    /** Production tags that exist on origin, without the leading v. */
    existingProductionTags?: string[];
    channelBody?: string;
    /** Simulates a transient GitHub failure reading the channel. */
    channelUnreadable?: boolean;
    /** Raw latest-staging.json contents, for malformed-manifest cases. */
    manifestBody?: string;
    /** Raw manifest on the immutable versioned prerelease. */
    versionedManifestBody?: string;
    abandonedSeries?: Record<string, string>;
    cherry?: string;
    behindMain?: number;
    commitsSinceProduction?: number;
  }

  function statusRunner(fixture: StatusFixture, calls: CommandCall[] = []): CommandRunner {
    const activeCommit = fixture.activeCommit === undefined ? MAIN_COMMIT : fixture.activeCommit;
    const previousCommit = fixture.previousCommit === undefined ? PREVIOUS_RC_COMMIT : fixture.previousCommit;
    const candidateTags = fixture.candidateTags ?? (fixture.activeVersion
      ? [`v${fixture.activeVersion}`, "v0.0.0-staging.1"]
      : []);
    return {
      async run(command, args, options) {
        calls.push({ command, args, options });
        const key = `${command} ${args.join(" ")}`;
        if (key === "git remote get-url origin") {
          return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
        }
        if (key === "git fetch --tags origin main" || key === "git fetch --tags origin") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (key === "git rev-parse origin/main") {
          return { exitCode: 0, stdout: `${MAIN_COMMIT}\n`, stderr: "" };
        }
        if (key === "gh release view --repo jemdiggity/kanna --json tagName,publishedAt") {
          if (!fixture.productionTag) return { exitCode: 1, stdout: "", stderr: "no releases" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tagName: fixture.productionTag,
              publishedAt: fixture.productionPublishedAt ?? "2026-07-01T00:00:00Z"
            }),
            stderr: ""
          };
        }
        if (isStagingChannelAssetsQuery(command, args)) {
          if (fixture.channelUnreadable) return { exitCode: 1, stdout: "", stderr: "HTTP 503: Service unavailable" };
          return stagingChannelAssetsResponse(fixture.activeVersion ? ["latest-staging.json"] : null);
        }
        if (command === "gh" && args[0] === "release" && args[1] === "download") {
          if (!fixture.activeVersion) return { exitCode: 1, stdout: "", stderr: "release not found" };
          const dirIndex = args.indexOf("--dir");
          const manifestBody = args[2] === "desktop-staging"
            ? fixture.manifestBody
            : fixture.versionedManifestBody;
          writeFileSync(
            join(args[dirIndex + 1] ?? "", "latest-staging.json"),
            manifestBody ?? `{"version":"${fixture.activeVersion}"}\n`
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (fixture.activeVersion && key.startsWith(`gh release view v${fixture.activeVersion} `)) {
          if (activeCommit === null) return { exitCode: 1, stdout: "", stderr: "release not found" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tagName: fixture.activeTagName ?? `v${fixture.activeVersion}`,
              targetCommitish: activeCommit,
              publishedAt: fixture.activePublishedAt === undefined ? "2026-07-06T00:00:00Z" : fixture.activePublishedAt,
              body: fixture.activeSourceBranch
                ? `Staging updater manifest for v${fixture.activeVersion}\n\nSource-Branch: ${fixture.activeSourceBranch}`
                : `Staging updater manifest for v${fixture.activeVersion}`,
              isPrerelease: fixture.activeIsPrerelease ?? true
            }),
            stderr: ""
          };
        }
        if (command === "gh" && args[0] === "release" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              candidateTags.map((tag, index) => ({
                tagName: tag,
                createdAt: new Date(NOW - (index + 1) * 86_400_000).toISOString()
              }))
            ),
            stderr: ""
          };
        }
        if (command === "gh" && args[0] === "release" && args[1] === "view" && args[2] === "desktop-staging") {
          return { exitCode: 0, stdout: JSON.stringify({ body: fixture.channelBody ?? "" }), stderr: "" };
        }
        if (command === "gh" && args[0] === "release" && args[1] === "view") {
          if (previousCommit === null) return { exitCode: 1, stdout: "", stderr: "release not found" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tagName: args[2],
              targetCommitish: previousCommit,
              body: `Staging updater manifest for ${args[2]}\n\nSource-Branch: main`,
              publishedAt: "2026-07-02T00:00:00Z",
              isPrerelease: true
            }),
            stderr: ""
          };
        }
        if (command === "git" && args[0] === "merge-base") {
          const [, , base, candidate] = args;
          if (base === previousCommit && candidate === activeCommit) {
            return { exitCode: fixture.previousIsAncestor ?? 0, stdout: "", stderr: "" };
          }
          if (base === activeCommit && candidate === previousCommit) {
            return { exitCode: fixture.activeIsAncestor ?? 1, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "ls-remote" && args[1] === "origin") {
          const sha = fixture.releaseBranchSha ?? "";
          return { exitCode: 0, stdout: sha ? `${sha}\t${args[2]}\n` : "", stderr: "" };
        }
        if (command === "git" && args[0] === "ls-remote" && args[1] === "--tags") {
          const pattern = args[3] ?? "";
          if (fixture.activeVersion && pattern === `refs/tags/v${fixture.activeVersion}`) {
            const tagCommit = fixture.activeTagCommit ?? activeCommit ?? "";
            return {
              exitCode: 0,
              stdout: tagCommit ? `${tagCommit}\t${pattern}\n` : "",
              stderr: ""
            };
          }
          const abandoned = /^refs\/tags\/abandoned\/release\/(\d+\.\d+)$/.exec(pattern);
          if (abandoned) {
            const has = Boolean(fixture.abandonedSeries?.[abandoned[1] ?? ""]);
            return { exitCode: 0, stdout: has ? `sha\t${pattern}\n` : "", stderr: "" };
          }
          const wanted = pattern.replace(/^v/, "");
          const exists = (fixture.existingProductionTags ?? []).includes(wanted);
          return { exitCode: 0, stdout: exists ? `sha\trefs/tags/v${wanted}\n` : "", stderr: "" };
        }
        if (command === "git" && args[0] === "for-each-ref") {
          const series = /abandoned\/release\/(\d+\.\d+)$/.exec(args[2] ?? "")?.[1] ?? "";
          return { exitCode: 0, stdout: fixture.abandonedSeries?.[series] ?? "", stderr: "" };
        }
        if (command === "git" && args[0] === "fetch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (key === "git rev-parse FETCH_HEAD^{commit}") {
          return { exitCode: 0, stdout: `${fixture.activeTagCommit ?? activeCommit ?? ""}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "log") {
          expect(args).toContain("--no-merges");
          expect(args).toContain("--cherry-pick");
          expect(args).toContain("--right-only");
          return { exitCode: 0, stdout: fixture.cherry ?? "", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-list") {
          const range = args[2] ?? "";
          if (range.startsWith("v")) return { exitCode: 0, stdout: `${fixture.commitsSinceProduction ?? 12}\n`, stderr: "" };
          return { exitCode: 0, stdout: `${fixture.behindMain ?? 0}\n`, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
      }
    };
  }

  it("reports lineage, soak, and promotion state for a healthy main candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeSourceBranch: "main",
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.production).toEqual({ version: "1.2.3", tag: "v1.2.3", publishedAt: "2026-07-01T00:00:00Z" });
      expect(result.staging).toEqual({
        version: "1.2.4-staging.3",
        tag: "v1.2.4-staging.3",
        commit: MAIN_COMMIT,
        sourceBranch: "main",
        commitsBehindMain: 0,
        publishedAt: "2026-07-06T00:00:00Z",
        ageHours: 48
      });
      expect(result.policy).toEqual({ productionSoakHours: 24 });
      expect(result.lineage?.relationship).toBe("descendant");
      expect(result.lineage?.previous).toEqual({
        version: "0.0.0-staging.1",
        tag: "v0.0.0-staging.1",
        commit: PREVIOUS_RC_COMMIT
      });
      expect(result.lineage?.valid).toBe(true);
      expect(result.freeze).toEqual({ active: false, branch: null, reason: null });
      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.promotion.base).toBe("main");
      expect(result.promotion.soak).toMatchObject({ requiredHours: 24, elapsedHours: 48, satisfied: true, overridden: false });
      expect(result.promotion.allowed).toBe(true);
      expect(result.promotion.blockers).toEqual([]);
      expect(result.promoteCommand).toBe("kd release promote 1.2.4-staging.3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports immutable tag identity failures as promotion blockers", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeSourceBranch: "main",
        activeTagCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers.join(" ")).toMatch(/failed immutable identity verification.*tag resolves to/);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a versioned manifest mismatch as a promotion blocker", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeSourceBranch: "main",
        versionedManifestBody: '{"version":"1.2.4-staging.30"}\n',
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers.join(" ")).toMatch(
        /latest-staging\.json version 1\.2\.4-staging\.30 does not match selected version 1\.2\.4-staging\.3/
      );
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The v0.1.0-staging.7 -> .8 incident: .8 was mechanically aligned to
  // release/0.1's tip while its history had diverged from .7. Status must not
  // collapse that into one "promotable" flag.
  it("separates mechanical promotability from a diverged lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const divergedCommit = "beef000000000000000000000000000000000000";
      const runner = statusRunner({
        activeVersion: "0.1.0-staging.8",
        activeCommit: divergedCommit,
        activeSourceBranch: "release/0.1",
        candidateTags: ["v0.1.0-staging.8", "v0.1.0-staging.7"],
        previousIsAncestor: 1,
        activeIsAncestor: 1,
        releaseBranchSha: divergedCommit,
        productionTag: "v0.0.9"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.promotion.base).toBe("release/0.1");
      expect(result.lineage?.relationship).toBe("diverged");
      expect(result.lineage?.previous?.tag).toBe("v0.1.0-staging.7");
      expect(result.lineage?.valid).toBe(false);
      expect(result.lineage?.authorizedByReset).toBe(false);
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers.join(" ")).toMatch(/share only an older merge base/);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a divergence as valid when a recorded reset authorized it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const divergedCommit = "beef000000000000000000000000000000000000";
      const runner = statusRunner({
        activeVersion: "0.1.0-staging.8",
        activeCommit: divergedCommit,
        activeSourceBranch: "release/0.1",
        candidateTags: ["v0.1.0-staging.8", "v0.1.0-staging.7"],
        previousIsAncestor: 1,
        activeIsAncestor: 1,
        releaseBranchSha: divergedCommit,
        productionTag: "v0.0.9",
        channelBody: [
          "Pointer-only desktop staging updater channel.",
          "",
          "Lineage-Reset: 2026-07-04T00:00:00Z",
          `Reset-From: 0.1.0-staging.7 (${PREVIOUS_RC_COMMIT}) source main`,
          "Reset-To: release/0.1",
          "Reset-Reason: hotfix the 0.1 series from its stale branch"
        ].join("\n")
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.lineage?.relationship).toBe("diverged");
      expect(result.lineage?.valid).toBe(true);
      expect(result.lineage?.authorizedByReset).toBe(true);
      expect(result.lineage?.reset?.reason).toBe("hotfix the 0.1 series from its stale branch");
      expect(result.promotion.allowed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a recorded post-promotion trunk resumption as valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.4.0-staging.1",
        activeCommit: MAIN_COMMIT,
        activeSourceBranch: "main",
        candidateTags: ["v1.4.0-staging.1", "v1.3.0-staging.2"],
        previousCommit: PREVIOUS_RC_COMMIT,
        previousIsAncestor: 1,
        activeIsAncestor: 1,
        productionTag: "v1.3.0",
        channelBody: [
          "Pointer-only desktop staging updater channel.",
          "",
          "Post-Promotion-Trunk-Resumption: 2026-08-17T03:00:00.000Z",
          "Promoted-Version: 1.3.0",
          "Promoted-Tag: v1.3.0",
          `Promoted-Commit: ${PREVIOUS_RC_COMMIT}`,
          `Production-Tag-Commit: ${PREVIOUS_RC_COMMIT}`,
          `Resumed-To: ${MAIN_COMMIT} source main`
        ].join("\n")
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.lineage).toMatchObject({
        relationship: "diverged",
        valid: true,
        authorizedByReset: false,
        authorizedByPromotion: true,
        postPromotion: {
          promotedVersion: "1.3.0",
          promotedTag: "v1.3.0",
          promotedCommit: PREVIOUS_RC_COMMIT,
          productionTagCommit: PREVIOUS_RC_COMMIT,
          newCommit: MAIN_COMMIT,
          newBranch: "main"
        }
      });
      expect(result.lineage?.detail).toContain("resumed trunk");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unpromoted release-branch candidate as freezing main staging publishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const rcCommit = "cccccccccccccccccccccccccccccccccccccccc";
      const runner = statusRunner({
        activeVersion: "1.3.0-staging.2",
        activeCommit: rcCommit,
        activeSourceBranch: "release/1.3",
        releaseBranchSha: rcCommit,
        productionTag: "v1.2.3",
        behindMain: 5,
        cherry: "1111111111111111111111111111111111111111 fix: only on the branch"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.freeze).toEqual({
        active: true,
        branch: "release/1.3",
        reason: expect.stringContaining("main staging publishes are frozen")
      });
      expect(result.staging?.commitsBehindMain).toBe(5);
      expect(result.releaseBranch).toEqual({
        name: "release/1.3",
        commit: rcCommit,
        abandoned: null,
        unmergedCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "fix: only on the branch" }],
        unmergedCommitCount: 1
      });
      expect(result.promotion.base).toBe("release/1.3");
      expect(result.promotion.allowed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears the freeze once the release-branch candidate's production tag exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const rcCommit = "cccccccccccccccccccccccccccccccccccccccc";
      const runner = statusRunner({
        activeVersion: "1.3.0-staging.2",
        activeCommit: rcCommit,
        activeSourceBranch: "release/1.3",
        releaseBranchSha: rcCommit,
        existingProductionTags: ["1.3.0"],
        productionTag: "v1.3.0"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.freeze).toEqual({ active: false, branch: null, reason: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks promotion while the policy soak window has not elapsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeSourceBranch: "main",
        activePublishedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.lineage?.valid).toBe(true);
      expect(result.promotion.soak).toMatchObject({ requiredHours: 24, elapsedHours: 3, satisfied: false });
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers.join(" ")).toMatch(/soaked 3\.0h of the required 24h/);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the soak window from the repository release policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      writeFileSync(join(root, "release-policy.json"), '{"productionSoakHours": 1}\n');
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeSourceBranch: "main",
        activePublishedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.policy).toEqual({ productionSoakHours: 1 });
      expect(result.promotion.soak.satisfied).toBe(true);
      expect(result.promotion.allowed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a stale staging pointer as not promotable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const staleCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeCommit: staleCommit,
        activeSourceBranch: "main",
        productionTag: "v1.2.3",
        behindMain: 7
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.staging?.commitsBehindMain).toBe(7);
      expect(result.promotion.mechanicallyPromotable).toBe(false);
      expect(result.promotion.mechanicalReason).toMatch(/has advanced past/);
      expect(result.promotion.allowed).toBe(false);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a main RC promotable when a dormant same-series release branch exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.3.1-staging.1",
        activeSourceBranch: "main",
        releaseBranchSha: "dddddddddddddddddddddddddddddddddddddddd",
        productionTag: "v1.3.0"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.staging?.sourceBranch).toBe("main");
      expect(result.releaseBranch?.name).toBe("release/1.3");
      expect(result.freeze.active).toBe(false);
      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.promotion.allowed).toBe(true);
      expect(result.promoteCommand).toBe("kd release promote 1.3.1-staging.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the active candidate's GitHub metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeCommit: null,
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.staging?.commit).toBeNull();
      expect(result.promotion.mechanicallyPromotable).toBe(false);
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers.join(" ")).toMatch(/records no target commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the active candidate is absent from the prerelease listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        activeSourceBranch: "main",
        candidateTags: [],
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.lineage?.relationship).toBe("unknown");
      expect(result.lineage?.valid).toBe(false);
      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.promotion.allowed).toBe(false);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an abandoned series and refuses to promote its candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const rcCommit = "cccccccccccccccccccccccccccccccccccccccc";
      const runner = statusRunner({
        activeVersion: "0.1.0-staging.8",
        activeCommit: rcCommit,
        activeSourceBranch: "release/0.1",
        releaseBranchSha: rcCommit,
        productionTag: "v0.0.68",
        abandonedSeries: {
          "0.1": "Abandoned release/0.1 at 2026-08-13T09:00:00.000Z\n\nReason: 0.1 diverged from main\n"
        }
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.releaseBranch?.abandoned).toEqual({
        abandonedAt: "2026-08-13T09:00:00.000Z",
        reason: "0.1 diverged from main"
      });
      // Mechanically it still matches its branch tip; the series decision is what stops it.
      expect(result.promotion.mechanicallyPromotable).toBe(true);
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers[0]).toMatch(/release\/0\.1 was abandoned on 2026-08-13T09:00:00\.000Z/);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unreadable channel as an error, not as an empty one", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({
        activeVersion: "1.2.4-staging.3",
        channelUnreadable: true,
        productionTag: "v1.2.3"
      });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.staging).toBeNull();
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers).toEqual([
        expect.stringContaining("desktop-staging channel could not be read")
      ]);
      expect(result.promotion.blockers[0]).not.toMatch(/No staging release candidate is active/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty channels when no releases exist yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const runner = statusRunner({ activeVersion: null, productionTag: null });

      const result = await releaseStatus({ repoRoot: root, env: {}, runner, now: NOW });

      expect(result.production).toBeNull();
      expect(result.staging).toBeNull();
      expect(result.releaseBranch).toBeNull();
      expect(result.lineage).toBeNull();
      expect(result.freeze).toEqual({ active: false, branch: null, reason: null });
      expect(result.promotion.allowed).toBe(false);
      expect(result.promotion.blockers).toEqual(["No staging release candidate is active on the channel."]);
      expect(result.promoteCommand).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The staging channel is a single pointer, so these gates run at the command
// boundary before anything is built. A real end-to-end proof would need signed
// artifacts, live GitHub prereleases, and an installed updater; see the note at
// the top of this file and docs/2026-08-13-release-lifecycle-e2e-gap.md.
describe("staging publish lineage gates", () => {
  const ACTIVE_COMMIT = "7777777777777777777777777777777777777777";
  const DESCENDANT_COMMIT = "8888888888888888888888888888888888888888";
  const DIVERGED_COMMIT = "beef000000000000000000000000000000000000";
  const BRANCH_POINT = "1111111111111111111111111111111111111111";
  const PRODUCTION_TAG_COMMIT = "4444444444444444444444444444444444444444";

  interface ShipGateFixture {
    head: string;
    branch?: string;
    sourceBranch?: string;
    activeVersion?: string | null;
    activeCommit?: string | null;
    activeSourceBranch?: string | null;
    /** `git merge-base --is-ancestor <active> <head>` exit code. */
    activeIsAncestorOfHead?: number;
    /** `git merge-base --is-ancestor <head> <active>` exit code. */
    headIsAncestorOfActive?: number;
    existingProductionTags?: string[];
    productionReleaseTargetCommit?: string;
    productionTagCommit?: string;
    productionTagParent?: string;
    originMain?: string;
    originRelease?: string;
    mergeBase?: string;
    /** Result of proving the merge-base is contained by origin/main. */
    mainContainsMergeBase?: number;
    /** Result of proving the candidate remains in its recorded source branch. */
    releaseContainsCandidate?: number;
    /** Result of proving HEAD descends from the main/release branch point. */
    headDescendsFromMergeBase?: number;
    channelBody?: string;
    releaseBranchSha?: string;
    /** Series carrying an abandonment tag, as `X.Y` -> annotated tag message. */
    abandonedSeries?: Record<string, string>;
    /** Simulates a transient GitHub failure reading the channel itself. */
    channelUnreadable?: boolean;
    /** Simulates the manifest asset existing but failing to download. */
    manifestDownloadFails?: boolean;
    /** Raw latest-staging.json contents, for malformed-manifest cases. */
    manifestBody?: string;
  }

  function shipGateRunner(fixture: ShipGateFixture, repoRoot: string, outputs: Map<string, string>, calls: CommandCall[]): CommandRunner {
    const activeVersion = fixture.activeVersion === undefined ? "1.2.4-staging.2" : fixture.activeVersion;
    const activeCommit = fixture.activeCommit === undefined ? ACTIVE_COMMIT : fixture.activeCommit;
    return {
      async run(command, args, options) {
        calls.push({ command, args, options });
        const key = `${command} ${args.join(" ")}`;
        if (key === "git status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };
        if (key === "git remote get-url origin") {
          return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
        }
        if (key === "git rev-parse --abbrev-ref HEAD") {
          return { exitCode: 0, stdout: `${fixture.branch ?? "main"}\n`, stderr: "" };
        }
        if (key === "git rev-parse HEAD") return { exitCode: 0, stdout: `${fixture.head}\n`, stderr: "" };
        if (key === "git rev-parse FETCH_HEAD^{commit}") {
          return { exitCode: 0, stdout: `${fixture.productionTagCommit ?? activeCommit ?? ""}\n`, stderr: "" };
        }
        if (key === "git show -s --format=%P FETCH_HEAD") {
          return { exitCode: 0, stdout: `${fixture.productionTagParent ?? activeCommit ?? ""}\n`, stderr: "" };
        }
        if (key === "git show -s --format=%s FETCH_HEAD") {
          const productionVersion = activeVersion?.replace(/-staging\.\d+$/, "") ?? "";
          return { exitCode: 0, stdout: `release: v${productionVersion}\n`, stderr: "" };
        }
        if (key === "git rev-parse origin/main") {
          return { exitCode: 0, stdout: `${fixture.originMain ?? fixture.head}\n`, stderr: "" };
        }
        if (fixture.activeSourceBranch && key === `git rev-parse origin/${fixture.activeSourceBranch}`) {
          return { exitCode: 0, stdout: `${fixture.originRelease ?? activeCommit ?? ""}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "ls-remote" && args[1] === "origin") {
          const sha = fixture.releaseBranchSha ?? "";
          return { exitCode: 0, stdout: sha ? `${sha}\t${args[2]}\n` : "", stderr: "" };
        }
        if (command === "git" && args[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
        if (isStagingChannelAssetsQuery(command, args)) {
          if (fixture.channelUnreadable) return { exitCode: 1, stdout: "", stderr: "HTTP 503: Service unavailable" };
          return stagingChannelAssetsResponse(activeVersion ? ["latest-staging.json"] : null);
        }
        if (command === "gh" && args[0] === "release" && args[1] === "download") {
          if (!activeVersion) return { exitCode: 1, stdout: "", stderr: "release not found" };
          if (fixture.manifestDownloadFails) return { exitCode: 1, stdout: "", stderr: "HTTP 502: Bad gateway" };
          const dirIndex = args.indexOf("--dir");
          writeFileSync(
            join(args[dirIndex + 1] ?? "", "latest-staging.json"),
            fixture.manifestBody ?? `{"version":"${activeVersion}"}\n`
          );
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (activeVersion && key.startsWith(`gh release view v${activeVersion} `)) {
          if (activeCommit === null) return { exitCode: 1, stdout: "", stderr: "release not found" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              targetCommitish: activeCommit,
              publishedAt: "2026-07-06T00:00:00Z",
              body: `Staging updater manifest\n\nSource-Branch: ${fixture.activeSourceBranch ?? "main"}`
            }),
            stderr: ""
          };
        }
        const productionVersion = activeVersion?.replace(/-staging\.\d+$/, "");
        if (productionVersion && key.startsWith(`gh release view v${productionVersion} `)) {
          const exists = (fixture.existingProductionTags ?? []).includes(productionVersion);
          if (!exists) return { exitCode: 1, stdout: "", stderr: "release not found" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tagName: `v${productionVersion}`,
              targetCommitish: fixture.productionReleaseTargetCommit ?? activeCommit,
              isPrerelease: false
            }),
            stderr: ""
          };
        }
        if (command === "gh" && args[0] === "release" && args[1] === "view" && args[2] === "desktop-staging") {
          return { exitCode: 0, stdout: JSON.stringify({ body: fixture.channelBody ?? "" }), stderr: "" };
        }
        if (command === "git" && args[0] === "merge-base") {
          if (args[1] !== "--is-ancestor") {
            return { exitCode: 0, stdout: `${fixture.mergeBase ?? BRANCH_POINT}\n`, stderr: "" };
          }
          const [, , base, candidate] = args;
          if (base === activeCommit && candidate === fixture.head) {
            return { exitCode: fixture.activeIsAncestorOfHead ?? 0, stdout: "", stderr: "" };
          }
          if (base === fixture.head && candidate === activeCommit) {
            return { exitCode: fixture.headIsAncestorOfActive ?? 1, stdout: "", stderr: "" };
          }
          if (base === activeCommit && candidate === (fixture.originRelease ?? activeCommit)) {
            return { exitCode: fixture.releaseContainsCandidate ?? 0, stdout: "", stderr: "" };
          }
          if (base === (fixture.mergeBase ?? BRANCH_POINT) && candidate === (fixture.originMain ?? fixture.head)) {
            return { exitCode: fixture.mainContainsMergeBase ?? 0, stdout: "", stderr: "" };
          }
          if (base === (fixture.mergeBase ?? BRANCH_POINT) && candidate === fixture.head) {
            return { exitCode: fixture.headDescendsFromMergeBase ?? 0, stdout: "", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "ls-remote" && args[1] === "--tags") {
          const pattern = args[3] ?? "";
          if (pattern.startsWith("refs/tags/v") && !pattern.includes("staging") && !pattern.includes("abandoned")) {
            const wanted = pattern.replace(/^refs\/tags\/v/, "");
            const exists = (fixture.existingProductionTags ?? []).includes(wanted);
            const tagCommit = fixture.productionTagCommit ?? activeCommit ?? "";
            return {
              exitCode: 0,
              stdout: exists && tagCommit ? `${tagCommit}\trefs/tags/v${wanted}\n` : "",
              stderr: ""
            };
          }
          const abandoned = /^refs\/tags\/abandoned\/release\/(\d+\.\d+)$/.exec(pattern);
          if (abandoned) {
            const has = Boolean(fixture.abandonedSeries?.[abandoned[1] ?? ""]);
            return { exitCode: 0, stdout: has ? `sha\t${pattern}\n` : "", stderr: "" };
          }
          const wanted = pattern.replace(/^v/, "");
          if (wanted.includes("staging")) return { exitCode: 0, stdout: "", stderr: "" };
          const exists = (fixture.existingProductionTags ?? []).includes(wanted);
          return { exitCode: 0, stdout: exists ? `sha\trefs/tags/v${wanted}\n` : "", stderr: "" };
        }
        if (command === "git" && args[0] === "for-each-ref") {
          const series = /abandoned\/release\/(\d+\.\d+)$/.exec(args[2] ?? "")?.[1] ?? "";
          return { exitCode: 0, stdout: fixture.abandonedSeries?.[series] ?? "", stderr: "" };
        }
        if (command === "bazel" && args[0] === "build") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "bazel" && args[0] === "cquery") {
          return { exitCode: 0, stdout: `${outputs.get(args[3] ?? "") ?? ""}\n`, stderr: "" };
        }
        if (command === "sh" && args[0] === "-c") return { exitCode: 0, stdout: "", stderr: "" };
        if (command === "pnpm") {
          writeFileSync(`${args.at(-1)}.sig`, "staging signature\n");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "gh" && args[0] === "release" && ["create", "edit", "upload"].includes(args[1] ?? "")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (isLatestProductionReleaseQuery(command, args)) {
          const versions = fixture.existingProductionTags ?? [];
          const latest = [...versions].sort((left, right) => -compareVersions(left, right))[0];
          return {
            exitCode: 0,
            stdout: latest ? JSON.stringify([{ tagName: `v${latest}`, isPrerelease: false }]) : "[]",
            stderr: ""
          };
        }
        if (command === "gh" && args[0] === "release" && args[1] === "list") {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
      }
    };
  }

  function shipGateInput(
    repoRoot: string,
    privateKeyPath: string,
    runner: CommandRunner,
    sourceBranch?: string,
    release = false
  ): ReleaseShipInput {
    return {
      repoRoot,
      bump: "patch",
      archLabels: release ? ["arm64", "x86_64"] : ["arm64"],
      release,
      dryRun: !release,
      environment: "staging",
      sourceBranch,
      now: Date.parse("2026-08-17T03:00:00Z"),
      env: releaseEnv(privateKeyPath),
      runner
    };
  }

  it("publishes a candidate that descends from the active staging commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner({ head: DESCENDANT_COMMIT }, repoRoot, outputs, calls);

      const result = await shipRelease(shipGateInput(repoRoot, privateKeyPath, runner));

      expect(result.version).toBe("1.2.4-staging.1");
      expect(calls.some((call) => call.command === "bazel" && call.args[0] === "build")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a same-branch fast-forward RC from the release branch tip", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DESCENDANT_COMMIT,
          activeVersion: "1.3.0-staging.1",
          activeSourceBranch: "release/1.3",
          releaseBranchSha: DESCENDANT_COMMIT
        },
        repoRoot,
        outputs,
        calls
      );

      const result = await shipRelease(shipGateInput(repoRoot, privateKeyPath, runner, "release/1.3"));

      expect(result.version).toBe("1.3.0-staging.1");
      const manifest = JSON.parse(readFileSync(result.latestJson, "utf8")) as { notes?: string };
      expect(manifest.notes).toContain("Source-Branch: release/1.3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows the main-to-release-branch freeze transition when the cut descends from the active RC", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DESCENDANT_COMMIT,
          activeVersion: "1.2.4-staging.2",
          activeSourceBranch: "main",
          releaseBranchSha: DESCENDANT_COMMIT
        },
        repoRoot,
        outputs,
        calls
      );

      const result = await shipRelease(shipGateInput(repoRoot, privateKeyPath, runner, "release/1.3"));

      expect(result.version).toBe("1.3.0-staging.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // v0.1.0-staging.7 -> v0.1.0-staging.8: a stale release branch whose history
  // both added and dropped commits relative to the channel.
  it("refuses a divergent-history candidate before building", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DIVERGED_COMMIT,
          activeVersion: "0.1.0-staging.7",
          activeSourceBranch: "main",
          activeIsAncestorOfHead: 1,
          headIsAncestorOfActive: 1,
          releaseBranchSha: DIVERGED_COMMIT
        },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner, "release/0.1"))).rejects.toThrow(
        /diverged from the active channel/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(readVersionFiles(repoRoot)[0]).toBe("1.2.3\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a candidate that would roll the channel backwards", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        { head: DESCENDANT_COMMIT, activeIsAncestorOfHead: 1, headIsAncestorOfActive: 0 },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /Refusing to roll the staging channel back/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a main staging publish while an unpromoted release-branch RC is soaking", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        { head: DESCENDANT_COMMIT, activeVersion: "1.3.0-staging.2", activeSourceBranch: "release/1.3" },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /staging is frozen to that branch/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows promoted divergent RC lineage to resume on forward main and records provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64", "x86_64"]);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DIVERGED_COMMIT,
          activeVersion: "1.3.0-staging.2",
          activeSourceBranch: "release/1.3",
          activeIsAncestorOfHead: 1,
          headIsAncestorOfActive: 1,
          existingProductionTags: ["1.3.0"],
          productionReleaseTargetCommit: "main",
          productionTagCommit: PRODUCTION_TAG_COMMIT,
          productionTagParent: ACTIVE_COMMIT,
          originMain: DIVERGED_COMMIT,
          originRelease: ACTIVE_COMMIT
        },
        repoRoot,
        outputs,
        calls
      );

      const result = await shipRelease(shipGateInput(repoRoot, privateKeyPath, runner, undefined, true));

      expect(result.version).toBe("1.3.1-staging.1");
      expect(result.versionFloor).toEqual({
        versionFile: "1.2.3",
        latestProduction: "1.3.0",
        baseVersion: "1.3.1",
        detail: "VERSION 1.2.3 lags latest production v1.3.0; derived main staging version 1.3.1 from the production floor."
      });
      const edit = calls.find(
        (call) => call.command === "gh" && call.args[0] === "release" && call.args[1] === "edit"
      );
      const body = edit?.args[edit.args.indexOf("--notes") + 1] ?? "";
      expect(body).toContain("Post-Promotion-Trunk-Resumption: 2026-08-17T03:00:00.000Z");
      expect(body).toContain("Promoted-Version: 1.3.0");
      expect(body).toContain("Promoted-Tag: v1.3.0");
      expect(body).toContain(`Promoted-Commit: ${ACTIVE_COMMIT}`);
      expect(body).toContain(`Production-Tag-Commit: ${PRODUCTION_TAG_COMMIT}`);
      expect(body).toContain(`Resumed-To: ${DIVERGED_COMMIT} source main`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses promoted but stale main that does not descend from the release branch point", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DIVERGED_COMMIT,
          activeVersion: "1.3.0-staging.2",
          activeSourceBranch: "release/1.3",
          activeIsAncestorOfHead: 1,
          headIsAncestorOfActive: 1,
          existingProductionTags: ["1.3.0"],
          originMain: "2222222222222222222222222222222222222222",
          headDescendsFromMergeBase: 1
        },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /diverged from the active channel/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses promoted divergence when the production tag targets another commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DIVERGED_COMMIT,
          activeVersion: "1.3.0-staging.2",
          activeSourceBranch: "release/1.3",
          activeIsAncestorOfHead: 1,
          headIsAncestorOfActive: 1,
          existingProductionTags: ["1.3.0"],
          productionReleaseTargetCommit: "main",
          productionTagCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          productionTagParent: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /diverged from the active channel/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to move the channel when the active candidate's metadata is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner({ head: DESCENDANT_COMMIT, activeCommit: null }, repoRoot, new Map(), calls);

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /Cannot verify staging lineage/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // An uninitialized channel is the ONLY shape that may skip the lineage
  // comparison, and it has to be positive evidence: the pointer release does
  // not exist. A failed read looks identical from a single exit code, so these
  // cases are kept apart deliberately — conflating them is what would let a
  // rate limit or a 5xx wave a publish through with nothing verified.
  it("publishes onto an uninitialized channel without a lineage to compare", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner({ head: DESCENDANT_COMMIT, activeVersion: null }, repoRoot, outputs, calls);

      const result = await shipRelease(shipGateInput(repoRoot, privateKeyPath, runner));

      expect(result.version).toBe("1.2.4-staging.1");
      // Positive evidence of emptiness: the channel release itself 404s.
      const channelRead = calls.find(
        (call) => call.command === "gh" && call.args[1] === "view" && call.args[2] === "desktop-staging"
      );
      expect(channelRead).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the channel exists but its manifest cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        { head: DESCENDANT_COMMIT, manifestDownloadFails: true },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /Cannot verify staging lineage.*Bad gateway/s
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the channel itself cannot be reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner({ head: DESCENDANT_COMMIT, channelUnreadable: true }, repoRoot, new Map(), calls);

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /Cannot verify staging lineage.*Service unavailable/s
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the channel manifest is present but unparseable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        { head: DESCENDANT_COMMIT, manifestBody: "{ not json\n" },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner))).rejects.toThrow(
        /Cannot verify staging lineage.*has no valid version/s
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a recorded lineage reset authorize exactly the divergent publish it named", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const outputs = writeStagingReleaseBuildOutputs(repoRoot, ["arm64"]);
      const calls: CommandCall[] = [];
      const channelBody = [
        "Pointer-only desktop staging updater channel.",
        "",
        "Lineage-Reset: 2026-07-07T00:00:00Z",
        `Reset-From: 0.1.0-staging.7 (${ACTIVE_COMMIT}) source main`,
        "Reset-To: release/0.1",
        "Reset-Reason: hotfix the 0.1 series"
      ].join("\n");
      const fixture: ShipGateFixture = {
        head: DIVERGED_COMMIT,
        activeVersion: "0.1.0-staging.7",
        activeSourceBranch: "main",
        activeIsAncestorOfHead: 1,
        headIsAncestorOfActive: 1,
        releaseBranchSha: DIVERGED_COMMIT,
        channelBody
      };

      const result = await shipRelease(
        shipGateInput(repoRoot, privateKeyPath, shipGateRunner(fixture, repoRoot, outputs, calls), "release/0.1")
      );
      expect(result.version).toBe("0.1.0-staging.1");

      // The same record does not license a different destination.
      const otherCalls: CommandCall[] = [];
      await expect(
        shipRelease(
          shipGateInput(repoRoot, privateKeyPath, shipGateRunner(fixture, repoRoot, outputs, otherCalls), "release/0.2")
        )
      ).rejects.toThrow(/diverged from the active channel/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to ship an RC from an abandoned series", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner = shipGateRunner(
        {
          head: DESCENDANT_COMMIT,
          releaseBranchSha: DESCENDANT_COMMIT,
          abandonedSeries: {
            "0.1": "Abandoned release/0.1 at 2026-08-13T09:00:00.000Z\n\nReason: 0.1 diverged from main\n"
          }
        },
        repoRoot,
        new Map(),
        calls
      );

      await expect(shipRelease(shipGateInput(repoRoot, privateKeyPath, runner, "release/0.1"))).rejects.toThrow(
        /release\/0\.1 was abandoned on 2026-08-13T09:00:00\.000Z: 0\.1 diverged from main/
      );
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still repoints the channel non-linearly through an explicit rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const { repoRoot, privateKeyPath } = createReleaseRepo(root);
      const calls: CommandCall[] = [];
      const runner: CommandRunner = {
        async run(command, args, options) {
          calls.push({ command, args, options });
          const key = `${command} ${args.join(" ")}`;
          if (key === "git status --porcelain") return { exitCode: 0, stdout: "", stderr: "" };
          if (key === "git remote get-url origin") {
            return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
          }
          if (command === "gh" && args[1] === "view") return { exitCode: 0, stdout: "", stderr: "" };
          if (command === "gh" && args[1] === "download") {
            const dirIndex = args.indexOf("--dir");
            writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), '{"version":"1.2.4-staging.1"}\n');
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[1] === "upload") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
        }
      };

      const result = await shipRelease({
        repoRoot,
        bump: "patch",
        archLabels: ["arm64"],
        release: true,
        dryRun: false,
        environment: "staging",
        rollbackTo: "1.2.4-staging.1",
        env: releaseEnv(privateKeyPath),
        runner
      });

      expect(result.version).toBe("1.2.4-staging.1");
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(calls.some((call) => call.command === "git" && call.args[0] === "merge-base")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("staging lineage reset", () => {
  const ACTIVE_COMMIT = "7777777777777777777777777777777777777777";
  const RESET_NOW = Date.parse("2026-07-08T12:00:00Z");

  function resetRunner(
    calls: CommandCall[],
    options: { activeVersion?: string | null; channelBody?: string } = {}
  ): CommandRunner {
    const activeVersion = options.activeVersion === undefined ? "1.3.0-staging.2" : options.activeVersion;
    return {
      async run(command, args, runOptions) {
        calls.push({ command, args, options: runOptions });
        const key = `${command} ${args.join(" ")}`;
        if (key === "git remote get-url origin") {
          return { exitCode: 0, stdout: "git@github.com:jemdiggity/kanna.git\n", stderr: "" };
        }
        if (isStagingChannelAssetsQuery(command, args)) {
          return stagingChannelAssetsResponse(activeVersion ? ["latest-staging.json"] : null);
        }
        if (command === "gh" && args[0] === "release" && args[1] === "download") {
          if (!activeVersion) return { exitCode: 1, stdout: "", stderr: "not found" };
          const dirIndex = args.indexOf("--dir");
          writeFileSync(join(args[dirIndex + 1] ?? "", "latest-staging.json"), `{"version":"${activeVersion}"}\n`);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (activeVersion && key.startsWith(`gh release view v${activeVersion} `)) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              targetCommitish: ACTIVE_COMMIT,
              publishedAt: "2026-07-06T00:00:00Z",
              body: "Staging updater manifest\n\nSource-Branch: release/1.3"
            }),
            stderr: ""
          };
        }
        if (command === "gh" && args[1] === "view" && args[2] === "desktop-staging" && args.includes("--json")) {
          return { exitCode: 0, stdout: JSON.stringify({ body: options.channelBody ?? "" }), stderr: "" };
        }
        if (command === "gh" && args[1] === "view" && args[2] === "desktop-staging") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "gh" && args[1] === "edit") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: `unexpected command ${key}` };
      }
    };
  }

  function resetInput(root: string, runner: CommandRunner, overrides: Partial<ReleaseResetStagingInput> = {}): ReleaseResetStagingInput {
    return {
      repoRoot: root,
      toBranch: "main",
      reason: "0.1 soak abandoned; shipping main again",
      confirmAbandon: "1.3.0-staging.2",
      dryRun: false,
      now: RESET_NOW,
      env: {},
      runner,
      ...overrides
    };
  }

  it("records old and new provenance on the pointer release without building or repointing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner = resetRunner(calls);

      const result = await resetStagingLineage(resetInput(root, runner));

      expect(result).toEqual({
        from: {
          version: "1.3.0-staging.2",
          tag: "v1.3.0-staging.2",
          commit: ACTIVE_COMMIT,
          sourceBranch: "release/1.3"
        },
        to: { branch: "main" },
        reason: "0.1 soak abandoned; shipping main again",
        resetAt: "2026-07-08T12:00:00.000Z",
        applied: true
      });
      const edit = calls.find((call) => call.command === "gh" && call.args[1] === "edit");
      expect(edit?.args[2]).toBe("desktop-staging");
      const notes = edit?.args.at(-1) ?? "";
      expect(notes).toContain("Lineage-Reset: 2026-07-08T12:00:00.000Z");
      expect(notes).toContain(`Reset-From: 1.3.0-staging.2 (${ACTIVE_COMMIT}) source release/1.3`);
      expect(notes).toContain("Reset-To: main");
      expect(notes).toContain("Reset-Reason: 0.1 soak abandoned; shipping main again");
      expect(calls.some((call) => call.command === "bazel")).toBe(false);
      expect(calls.some((call) => call.command === "gh" && call.args[1] === "upload")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps earlier reset records as an audit trail", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner = resetRunner(calls, {
        channelBody: [
          "Pointer-only desktop staging updater channel.",
          "",
          "Lineage-Reset: 2026-05-01T00:00:00Z",
          "Reset-From: 1.0.0-staging.4 (aaaa) source main",
          "Reset-To: release/1.0",
          "Reset-Reason: earlier abandon"
        ].join("\n")
      });

      await resetStagingLineage(resetInput(root, runner));

      const notes = calls.find((call) => call.command === "gh" && call.args[1] === "edit")?.args.at(-1) ?? "";
      expect(notes.indexOf("2026-07-08T12:00:00.000Z")).toBeLessThan(notes.indexOf("2026-05-01T00:00:00Z"));
      expect(notes).toContain("Reset-Reason: earlier abandon");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a confirmation that does not name the active candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner = resetRunner(calls);

      await expect(
        resetStagingLineage(resetInput(root, runner, { confirmAbandon: "1.3.0-staging.1" }))
      ).rejects.toThrow(/does not match the active staging candidate 1\.3\.0-staging\.2/);
      expect(calls.some((call) => call.command === "gh" && call.args[1] === "edit")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a reason and a valid destination branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner = resetRunner(calls);

      await expect(resetStagingLineage(resetInput(root, runner, { reason: "  " }))).rejects.toThrow(/requires --reason/);
      await expect(resetStagingLineage(resetInput(root, runner, { toBranch: "hotfix/x" }))).rejects.toThrow(
        /Expected main or release\/X\.Y/
      );
      await expect(resetStagingLineage(resetInput(root, runner, { confirmAbandon: " " }))).rejects.toThrow(
        /requires --confirm-abandon/
      );
      expect(calls.some((call) => call.command === "gh" && call.args[1] === "edit")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the channel has no active candidate to abandon", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner = resetRunner(calls, { activeVersion: null });

      await expect(resetStagingLineage(resetInput(root, runner))).rejects.toThrow(/no active staging candidate/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rehearses without editing the pointer release under --dry-run", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-"));
    try {
      const calls: CommandCall[] = [];
      const runner = resetRunner(calls);

      const result = await resetStagingLineage(resetInput(root, runner, { dryRun: true }));

      expect(result.applied).toBe(false);
      expect(calls.some((call) => call.command === "gh" && call.args[1] === "edit")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
