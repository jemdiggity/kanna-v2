import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli";
import {
  archiveTagName,
  buildMobileIosArchivePlan,
  executeMobileIosArchiveWithContext,
  isUploaderUnavailable,
  parseArchiveIdentity,
  parseXcodeMajorVersion,
  type MobileIosArchivePlan
} from "./mobile-archive";
import { nodeCommandRunner, type CommandRunner } from "./process";

const HEAD_COMMIT = "9c8b7a6d5e4f30210123456789abcdef01234567";
const SHORT_COMMIT = HEAD_COMMIT.slice(0, 12);

/**
 * Mock runner that answers the git source-ref probes plus whatever the caller
 * stubs for the archive toolchain.
 */
function archiveRunner(options: {
  calls?: string[];
  status?: string;
  xcodeVersion?: string;
} = {}): CommandRunner {
  const calls = options.calls ?? [];
  return {
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: options.status ?? "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
      }
      if (command === "xcodebuild" && args[0] === "-version") {
        return {
          exitCode: 0,
          stdout: options.xcodeVersion ?? "Xcode 26.0\nBuild version 17A123\n",
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
}

async function writeMinimalRepo(
  root: string,
  mobileVersion: string | null = "1.0.0"
): Promise<void> {
  await mkdir(join(root, "apps/mobile/src"), { recursive: true });
  await writeFile(join(root, "VERSION"), "0.0.67\n");
  if (mobileVersion !== null) {
    await writeFile(join(root, "apps/mobile/VERSION"), `${mobileVersion}\n`);
  }
  await writeFile(
    join(root, "apps/mobile/src/mobileEnvironments.json"),
    JSON.stringify({
      prod: {
        name: "prod",
        displayName: "Kanna",
        iosBundleId: "build.kanna.app",
        runtimeVersion: "1.0.0"
      }
    })
  );
}

describe("kd mobile archive", () => {
  it("parses the production archive command with build metadata", () => {
    expect(
      parseCliArgs([
        "mobile",
        "archive",
        "--production",
        "--ref",
        "release/0.2",
        "--build-number",
        "45",
        "--version",
        "1.2.3",
        "--out-dir",
        ".build/mobile-release",
        "--upload",
        "--dry-run"
      ])
    ).toEqual({
      taskId: "mobile.archive",
      input: {
        production: true,
        ref: "release/0.2",
        buildNumber: "45",
        version: "1.2.3",
        outDir: ".build/mobile-release",
        upload: true,
        dryRun: true,
        forceRebuild: false
      }
    });
    expect(() => parseCliArgs(["mobile", "archive", "--production", "--rollback-to", "1"])).toThrow(
      "mobile archive only accepts"
    );
  });

  it("builds an archive and export plan that allows automatic provisioning updates", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-plan-"));
    await writeMinimalRepo(repoRoot);

    const plan = await buildMobileIosArchivePlan({
      repoRoot,
      buildNumber: "45",
      version: "1.2.3",
      outDir: ".build/mobile-release",
      upload: true
    });

    expect(plan).toMatchObject({
      appEnv: "prod",
      bundleId: "build.kanna.app",
      displayName: "Kanna",
      teamId: "EA4J68749Z",
      version: "1.2.3",
      buildNumber: "45",
      runtimeVersion: "1.0.0",
      archivePath: join(repoRoot, ".build/mobile-release/Kanna.xcarchive"),
      exportPath: join(repoRoot, ".build/mobile-release/export"),
      ipaPath: join(repoRoot, ".build/mobile-release/export/Kanna.ipa")
    });
    expect(plan.commands.map((command) => `${command.command} ${command.args.join(" ")}`)).toEqual([
      `pnpm --dir ${repoRoot}/apps/mobile exec expo prebuild --platform ios --clean`,
      [
        "xcodebuild",
        `-workspace ${repoRoot}/apps/mobile/ios/Kanna.xcworkspace`,
        "-scheme Kanna",
        "-configuration Release",
        "-sdk iphoneos",
        "-destination generic/platform=iOS",
        `-archivePath ${repoRoot}/.build/mobile-release/Kanna.xcarchive`,
        "MARKETING_VERSION=1.2.3",
        "CURRENT_PROJECT_VERSION=45",
        "-allowProvisioningUpdates",
        "archive"
      ].join(" "),
      [
        "xcodebuild",
        "-exportArchive",
        `-archivePath ${repoRoot}/.build/mobile-release/Kanna.xcarchive`,
        `-exportPath ${repoRoot}/.build/mobile-release/export`,
        `-exportOptionsPlist ${repoRoot}/.build/mobile-release/ExportOptions.plist`,
        "-allowProvisioningUpdates"
      ].join(" "),
      `xcrun altool --upload-app -f ${repoRoot}/.build/mobile-release/export/Kanna.ipa -t ios --apiKey <APP_STORE_CONNECT_API_KEY_ID> --apiIssuer <APP_STORE_CONNECT_API_ISSUER_ID>`
    ]);
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_ENV: "prod",
      KANNA_APP_VERSION: "1.2.3",
      KANNA_IOS_BUILD_NUMBER: "45"
    });
  });

  it("requires Xcode 26 or later before executing archive commands", async () => {
    expect(parseXcodeMajorVersion("Xcode 26.0\nBuild version 17A123")).toBe(26);
    expect(parseXcodeMajorVersion("Xcode 25.4\nBuild version 16F6")).toBe(25);

    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-xcode-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner = archiveRunner({ calls, xcodeVersion: "Xcode 25.4\nBuild version 16F6\n" });

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, ref: "release/0.2", buildNumber: "45" },
        { repoRoot, env: {}, runner }
      )
    ).rejects.toThrow("Xcode 26 or later is required");
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse --verify --quiet HEAD^{commit}",
      "git rev-parse --verify --quiet release/0.2^{commit}",
      "xcodebuild -version"
    ]);
  });

  it("requires an explicit --ref and a clean worktree", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-ref-"));
    await writeMinimalRepo(repoRoot);

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, buildNumber: "45", dryRun: true },
        { repoRoot, env: {}, runner: archiveRunner() }
      )
    ).rejects.toThrow("mobile archive --production requires --ref <branch|tag|sha>");

    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, ref: "release/0.2", buildNumber: "45", dryRun: true },
        { repoRoot, env: {}, runner: archiveRunner({ status: " M apps/mobile/app.json\n" }) }
      )
    ).rejects.toThrow("Refusing to run mobile archive from a dirty git worktree");
  });

  it("dry-runs without invoking archive or upload commands", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-dry-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner = archiveRunner({ calls });

    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "45", dryRun: true },
      { repoRoot, env: {}, runner }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Dry run: mobile production archive 1.0.0 (45)");
    expect(result.message).toContain(`Source: release/0.2 (${SHORT_COMMIT})`);
    expect(result.message).toContain("Runtime version: 1.0.0");
    expect(result.message).toContain("would push git tag mobile-archive-v1.0.0-45");
    const plan = result.data as MobileIosArchivePlan;
    expect(plan.source).toEqual({ ref: "release/0.2", commit: HEAD_COMMIT, shortCommit: SHORT_COMMIT });
    expect(plan.version).toBe("1.0.0");
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_VERSION: "1.0.0",
      KANNA_IOS_BUILD_NUMBER: "45"
    });
    expect(calls).toEqual([
      "git status --porcelain",
      "git rev-parse --verify --quiet HEAD^{commit}",
      "git rev-parse --verify --quiet release/0.2^{commit}",
      "xcodebuild -version"
    ]);
  });

  it("pushes an annotated archive provenance tag before an optional upload", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-ledger-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    let tagRecord: unknown;
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "git" && args[0] === "status") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "cat-file") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "tag") {
          tagRecord = JSON.parse(args[5] ?? "null") as unknown;
        }
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 0, stdout: "/Applications/Xcode.app/altool\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "45", upload: true },
      {
        repoRoot,
        env: {
          APP_STORE_CONNECT_API_KEY_ID: "KEY",
          APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER"
        },
        runner,
        now: () => new Date("2026-09-03T01:02:03.000Z")
      }
    );

    expect(result.ok).toBe(true);
    expect(archiveTagName("1.0.0", "45")).toBe("mobile-archive-v1.0.0-45");
    expect(tagRecord).toEqual({
      kind: "kanna-mobile-ios-archive",
      version: "1.0.0",
      buildNumber: "45",
      runtimeVersion: "1.0.0",
      bundleId: "build.kanna.app",
      ref: "release/0.2",
      commit: HEAD_COMMIT,
      shortCommit: SHORT_COMMIT,
      archivedAt: "2026-09-03T01:02:03.000Z"
    });
    const tagIndex = calls.findIndex((call) => call.startsWith("git tag -a mobile-archive-v1.0.0-45"));
    const pushIndex = calls.indexOf("git push origin refs/tags/mobile-archive-v1.0.0-45");
    const uploadIndex = calls.findIndex((call) => call.startsWith("xcrun altool --upload-app"));
    expect(tagIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(tagIndex);
    expect(uploadIndex).toBeGreaterThan(pushIndex);
  });

  function existingArchiveTagRunner(input: {
    calls: string[];
    tagType: "tag" | "commit";
    contents?: string;
  }): CommandRunner {
    return {
      async run(command, args) {
        input.calls.push(`${command} ${args.join(" ")}`);
        if (command === "git" && args[0] === "status") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "cat-file") {
          return { exitCode: 0, stdout: `${input.tagType}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "for-each-ref") {
          return { exitCode: 0, stdout: input.contents ?? "", stderr: "" };
        }
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 0, stdout: "/Applications/Xcode.app/altool\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
  }

  function existingProvenanceRecord(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      kind: "kanna-mobile-ios-archive",
      version: "1.0.0",
      buildNumber: "45",
      runtimeVersion: "1.0.0",
      bundleId: "build.kanna.app",
      ref: "release/0.2",
      commit: HEAD_COMMIT,
      shortCommit: SHORT_COMMIT,
      archivedAt: "2026-09-03T01:02:03.000Z",
      ...overrides
    });
  }

  it("reuses a valid existing annotated provenance tag without rewriting it", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-existing-valid-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "45" },
      {
        repoRoot,
        env: {},
        runner: existingArchiveTagRunner({ calls, tagType: "tag", contents: existingProvenanceRecord() })
      }
    );

    expect(result.ok).toBe(true);
    expect(calls).toContain("git push origin refs/tags/mobile-archive-v1.0.0-45");
    expect(calls.some((call) => call.startsWith("git tag "))).toBe(false);
  });

  it.each([
    { name: "lightweight", tagType: "commit" as const, contents: undefined, expected: "not an annotated tag" },
    { name: "malformed JSON", tagType: "tag" as const, contents: "not json", expected: "not readable JSON" },
    {
      name: "same-commit mismatched record",
      tagType: "tag" as const,
      contents: existingProvenanceRecord({ runtimeVersion: "0.9.0" }),
      expected: "runtimeVersion"
    }
  ])("rejects a $name archive tag before push or upload", async ({ tagType, contents, expected }) => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-existing-invalid-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "45", upload: true },
      {
        repoRoot,
        env: { APP_STORE_CONNECT_API_KEY_ID: "KEY", APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER" },
        runner: existingArchiveTagRunner({ calls, tagType, contents })
      }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain(expected);
    expect(calls.some((call) => call.startsWith("git push "))).toBe(false);
    expect(calls.some((call) => call.startsWith("xcrun altool "))).toBe(false);
  });

  async function runGit(cwd: string, args: string[]): Promise<string> {
    const result = await nodeCommandRunner.run("git", args, { cwd, env: process.env });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    return result.stdout.trim();
  }

  async function createRealGitArchiveFixture(): Promise<{
    repoRoot: string;
    remote: string;
    commit: string;
    calls: string[];
    runner: CommandRunner;
  }> {
    const root = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-git-"));
    const repoRoot = join(root, "repo");
    const remote = join(root, "origin.git");
    await mkdir(repoRoot);
    await writeMinimalRepo(repoRoot);
    await writeFile(join(repoRoot, ".gitignore"), ".build/\n");
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["config", "user.name", "Kanna Test"]);
    await runGit(repoRoot, ["config", "user.email", "kanna-test@example.invalid"]);
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "fixture"]);
    await runGit(root, ["init", "--bare", remote]);
    await runGit(repoRoot, ["remote", "add", "origin", remote]);
    const commit = await runGit(repoRoot, ["rev-parse", "HEAD"]);
    await seedArtifacts(repoRoot, "1.0.0", "45", commit);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "git") {
          return nodeCommandRunner.run(command, args, {
            ...options,
            env: { ...process.env, ...options?.env }
          });
        }
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 0, stdout: "/Applications/Xcode.app/altool\n", stderr: "" };
        }
        if (command === "plutil") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ApplicationProperties: {
                CFBundleShortVersionString: "1.0.0",
                CFBundleVersion: "45"
              }
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    return { repoRoot, remote, commit, calls, runner };
  }

  it("validates existing provenance through real annotated and lightweight git objects", async () => {
    const valid = await createRealGitArchiveFixture();
    const tag = archiveTagName("1.0.0", "45");
    const validRecord = existingProvenanceRecord({
      commit: valid.commit,
      shortCommit: valid.commit.slice(0, 12)
    });
    await runGit(valid.repoRoot, ["tag", "-a", tag, valid.commit, "-m", validRecord]);
    await runGit(valid.repoRoot, ["push", "origin", `refs/tags/${tag}`]);
    const originalTagObject = await runGit(valid.repoRoot, ["rev-parse", `refs/tags/${tag}`]);

    const validResult = await executeMobileIosArchiveWithContext(
      { production: true, ref: "HEAD", buildNumber: "45" },
      { repoRoot: valid.repoRoot, env: process.env, runner: valid.runner }
    );

    expect(validResult.ok).toBe(true);
    expect(await runGit(valid.repoRoot, ["rev-parse", `refs/tags/${tag}`])).toBe(originalTagObject);
    expect(await runGit(valid.remote, ["rev-parse", `refs/tags/${tag}`])).toBe(originalTagObject);
    expect(valid.calls.some((call) => call.startsWith("git tag "))).toBe(false);

    const invalidCases: Array<{
      createTag: (fixture: Awaited<ReturnType<typeof createRealGitArchiveFixture>>) => Promise<void>;
      expected: string;
    }> = [
      {
        createTag: async (fixture) => {
          await runGit(fixture.repoRoot, ["tag", tag, fixture.commit]);
        },
        expected: "not an annotated tag"
      },
      {
        createTag: async (fixture) => {
          await runGit(fixture.repoRoot, ["tag", "-a", tag, fixture.commit, "-m", "not json"]);
        },
        expected: "not readable JSON"
      },
      {
        createTag: async (fixture) => {
          await runGit(fixture.repoRoot, [
            "tag",
            "-a",
            tag,
            fixture.commit,
            "-m",
            existingProvenanceRecord({
              commit: fixture.commit,
              shortCommit: fixture.commit.slice(0, 12),
              bundleId: "build.kanna.wrong"
            })
          ]);
        },
        expected: "bundleId"
      },
      {
        createTag: async (fixture) => {
          const tree = await runGit(fixture.repoRoot, ["rev-parse", `${fixture.commit}^{tree}`]);
          const differentCommit = await runGit(fixture.repoRoot, [
            "commit-tree",
            tree,
            "-p",
            fixture.commit,
            "-m",
            "different tag target"
          ]);
          await runGit(fixture.repoRoot, [
            "tag",
            "-a",
            tag,
            differentCommit,
            "-m",
            existingProvenanceRecord({
              commit: fixture.commit,
              shortCommit: fixture.commit.slice(0, 12)
            })
          ]);
        },
        expected: "points to commit"
      }
    ];

    for (const invalidCase of invalidCases) {
      const fixture = await createRealGitArchiveFixture();
      await invalidCase.createTag(fixture);
      const result = await executeMobileIosArchiveWithContext(
        { production: true, ref: "HEAD", buildNumber: "45", upload: true },
        {
          repoRoot: fixture.repoRoot,
          env: {
            ...process.env,
            APP_STORE_CONNECT_API_KEY_ID: "KEY",
            APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER"
          },
          runner: fixture.runner
        }
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain(invalidCase.expected);
      expect(fixture.calls.some((call) => call.startsWith("git push "))).toBe(false);
      expect(fixture.calls.some((call) => call.startsWith("xcrun altool "))).toBe(false);
    }
  });

  it("falls back to the repository VERSION when apps/mobile/VERSION is absent", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-fallback-"));
    await writeMinimalRepo(repoRoot, null);

    const plan = await buildMobileIosArchivePlan({
      repoRoot,
      buildNumber: "45"
    });

    expect(plan.version).toBe("0.0.67");
    expect(plan.commands[0]?.env).toMatchObject({
      KANNA_APP_VERSION: "0.0.67"
    });
  });

  it("fails loudly when apps/mobile/VERSION is empty", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-empty-"));
    await writeMinimalRepo(repoRoot, "  ");
    const mobileVersionPath = join(repoRoot, "apps/mobile/VERSION");

    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(mobileVersionPath);
    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(/is empty/);
  });

  it("fails loudly when apps/mobile/VERSION is malformed", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-malformed-"));
    await writeMinimalRepo(repoRoot, "not-a-version");
    const mobileVersionPath = join(repoRoot, "apps/mobile/VERSION");

    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(mobileVersionPath);
    await expect(
      buildMobileIosArchivePlan({ repoRoot, buildNumber: "45" })
    ).rejects.toThrow(/is malformed/);
  });

  // --- only build when required -------------------------------------------

  /**
   * Seed an archive and IPA on disk. `sourceCommit` is the commit the archive
   * was built from, baked in exactly where `expo prebuild` puts it; pass null
   * to model an archive predating that provenance.
   */
  async function seedArtifacts(
    repoRoot: string,
    version: string,
    buildNumber: string,
    sourceCommit: string | null = HEAD_COMMIT
  ): Promise<void> {
    const outDir = join(repoRoot, ".build/mobile/ios-production");
    const appDir = join(outDir, "Kanna.xcarchive/Products/Applications/Kanna.app");
    await mkdir(join(appDir, "EXConstants.bundle"), { recursive: true });
    await mkdir(join(outDir, "export"), { recursive: true });
    await writeFile(join(outDir, "export/Kanna.ipa"), "not-a-real-ipa");
    await writeFile(
      join(outDir, "Kanna.xcarchive/Info.plist"),
      `<plist><dict><key>ApplicationProperties</key><dict>` +
        `<key>CFBundleShortVersionString</key><string>${version}</string>` +
        `<key>CFBundleVersion</key><string>${buildNumber}</string>` +
        `</dict></dict></plist>`
    );
    if (sourceCommit !== null) {
      await writeFile(
        join(appDir, "EXConstants.bundle/app.config"),
        JSON.stringify({
          extra: {
            kanna: {
              appEnv: "prod",
              ota: { channel: "production" },
              source: { ref: "release/0.2", commit: sourceCommit }
            }
          }
        })
      );
    }
  }

  function reuseArchiveRunner(calls: string[], identity: { version: string; buildNumber: string } | null): CommandRunner {
    return {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "cat-file") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 0, stdout: "/Applications/Xcode.app/Contents/Developer/usr/bin/altool", stderr: "" };
        }
        if (command === "plutil") {
          if (!identity) return { exitCode: 1, stdout: "", stderr: "unreadable" };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ApplicationProperties: {
                CFBundleShortVersionString: identity.version,
                CFBundleVersion: identity.buildNumber
              }
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
  }

  it("reuses a matching archive instead of rebuilding", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-reuse-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "7");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "7" }) }
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Reused existing mobile production archive 1.0.0 (7)");
    expect(calls.some((call) => call.startsWith("git rev-parse"))).toBe(true);
    expect(calls.some((call) => call.includes("prebuild"))).toBe(false);
    expect(calls.some((call) => call.startsWith("xcodebuild -workspace"))).toBe(false);
    expect(calls.some((call) => call.includes("-exportArchive"))).toBe(false);
  });

  it("rebuilds when the existing archive is a different build number", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-stale-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "6");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "6" }) }
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Built mobile production archive");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
  });

  it("rebuilds when the existing archive was built from a different commit", async () => {
    // Version and build number do not identify a commit. An attempt that
    // archives and then stops before Apple consumes the number leaves an
    // archive behind under a number that is still free, so a rerun at another
    // commit with the same number must not reuse it.
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-othercommit-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "7", "1111111111111111111111111111111111111111");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "7" }) }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Built mobile production archive");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
    expect((result.data as { reuseReason: string }).reuseReason).toContain(
      "was built from 111111111111"
    );
  });

  it("rebuilds when the existing archive bakes in no source commit at all", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-nocommit-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "7", null);
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "7" }) }
    );

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
    expect((result.data as { reuseReason: string }).reuseReason).toContain("no source commit");
  });

  it("rebuilds when no artifacts exist", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-fresh-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7" },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, null) }
    );
    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
  });

  it("rebuilds a matching archive when --force-rebuild is passed", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-force-"));
    await writeMinimalRepo(repoRoot);
    await seedArtifacts(repoRoot, "1.0.0", "7");
    const calls: string[] = [];
    const result = await executeMobileIosArchiveWithContext(
      { production: true, ref: "release/0.2", buildNumber: "7", forceRebuild: true },
      { repoRoot, env: {}, runner: reuseArchiveRunner(calls, { version: "1.0.0", buildNumber: "7" }) }
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Built mobile production archive");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(true);
  });

  it("fails before building when the uploader is unavailable for --upload", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-notransporter-"));
    await writeMinimalRepo(repoRoot);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xcodebuild" && args[0] === "-version") {
          return { exitCode: 0, stdout: "Xcode 26.0\nBuild version 17A123\n", stderr: "" };
        }
        if (command === "git" && args[0] === "rev-parse") {
          return { exitCode: 0, stdout: `${HEAD_COMMIT}\n`, stderr: "" };
        }
        if (command === "xcrun" && args[0] === "--find") {
          return { exitCode: 1, stdout: "", stderr: "xcrun: error: unable to find utility \"altool\"" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    await expect(
      executeMobileIosArchiveWithContext(
        { production: true, ref: "release/0.2", buildNumber: "7", upload: true },
        {
          repoRoot,
          env: {
            APP_STORE_CONNECT_API_KEY_ID: "KEY",
            APP_STORE_CONNECT_API_ISSUER_ID: "ISSUER"
          },
          runner
        }
      )
    ).rejects.toThrow("needs altool");
    expect(calls.some((call) => call.includes("prebuild"))).toBe(false);
  });

  it("detects a missing uploader", () => {
    expect(isUploaderUnavailable("", 'xcrun: error: unable to find utility "altool"')).toBe(true);
    expect(isUploaderUnavailable("/Applications/Xcode.app/.../altool", "")).toBe(false);
  });

  it("uploads with altool rather than iTMSTransporter", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-mobile-archive-uploader-"));
    await writeMinimalRepo(repoRoot);
    const plan = await buildMobileIosArchivePlan({ repoRoot, buildNumber: "3", upload: true });
    const upload = plan.commands.find((command) => command.kind === "upload");
    expect(upload?.args[0]).toBe("altool");
    expect(upload?.args).toContain("--upload-app");
    expect(plan.commands.some((command) => command.args.includes("iTMSTransporter"))).toBe(false);
  });

  it("parses archive identity from plist json", () => {
    expect(
      parseArchiveIdentity(
        JSON.stringify({
          ApplicationProperties: { CFBundleShortVersionString: "1.2.3", CFBundleVersion: "9" }
        })
      )
    ).toEqual({ version: "1.2.3", buildNumber: "9" });
    expect(
      parseArchiveIdentity(
        JSON.stringify({ CFBundleShortVersionString: "1.2.3", CFBundleVersion: "9" })
      )
    ).toEqual({ version: "1.2.3", buildNumber: "9" });
    expect(parseArchiveIdentity("not json")).toBeNull();
    expect(parseArchiveIdentity(JSON.stringify({}))).toBeNull();
  });

});
