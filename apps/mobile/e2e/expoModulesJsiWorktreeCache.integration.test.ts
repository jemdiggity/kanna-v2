import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUN_INTEGRATION =
  process.env.KANNA_RUN_EXPO_MODULES_JSI_WORKTREE_CACHE_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function run(
  command: string,
  args: string[],
  cwd: string,
  logPath: string,
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n$ ${command} ${args.join(" ")}\n`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  await new Promise<void>((resolveLog) => log.end(resolveLog));

  if (exitCode !== 0) {
    const output = await readFile(logPath, "utf8");
    const tail = output.split("\n").slice(-200).join("\n");
    throw new Error(
      `${command} exited with ${String(exitCode)} in ${cwd}. Log: ${logPath}\n${tail}`
    );
  }
}

async function archiveWorkingTree(archivePath: string): Promise<void> {
  const git = spawn(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] }
  );
  const tar = spawn("tar", ["--null", "-T", "-", "-cf", archivePath], {
    cwd: repoRoot,
    stdio: ["pipe", "inherit", "inherit"]
  });
  git.stdout.pipe(tar.stdin);

  const [gitExit, tarExit] = await Promise.all([
    new Promise<number | null>((resolveExit, reject) => {
      git.once("error", reject);
      git.once("exit", resolveExit);
    }),
    new Promise<number | null>((resolveExit, reject) => {
      tar.once("error", reject);
      tar.once("exit", resolveExit);
    })
  ]);
  expect(gitExit).toBe(0);
  expect(tarExit).toBe(0);
}

async function findFiles(root: string, suffix: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findFiles(path, suffix)));
    } else if (entry.name.endsWith(suffix)) {
      matches.push(path);
    }
  }
  return matches;
}

async function expoModulesJsiRoot(worktreeRoot: string): Promise<string> {
  const expoRoot = await realpath(join(worktreeRoot, "apps/mobile/node_modules/expo"));
  const expoModulesCoreRoot = await realpath(
    join(dirname(expoRoot), "expo-modules-core")
  );
  return realpath(join(dirname(expoModulesCoreRoot), "expo-modules-jsi"));
}

async function installAndPrebuild(worktreeRoot: string, logPath: string): Promise<void> {
  await run("pnpm", ["install", "--frozen-lockfile"], worktreeRoot, logPath);
  await run(
    "pnpm",
    [
      "--dir",
      "apps/mobile",
      "exec",
      "expo",
      "prebuild",
      "--platform",
      "ios",
      "--clean"
    ],
    worktreeRoot,
    logPath,
    { CI: "1", KANNA_APP_ENV: "dev" }
  );
}

async function buildSimulator(worktreeRoot: string, logPath: string): Promise<void> {
  const iosRoot = join(worktreeRoot, "apps/mobile/ios");
  const workspace = (await readdir(iosRoot)).find((entry) =>
    entry.endsWith(".xcworkspace")
  );
  if (!workspace) {
    throw new Error(`Expo prebuild did not generate an xcworkspace in ${iosRoot}`);
  }
  const scheme = basename(workspace, ".xcworkspace");
  await run(
    "xcodebuild",
    [
      "-workspace",
      join("apps/mobile/ios", workspace),
      "-scheme",
      scheme,
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS Simulator",
      "-derivedDataPath",
      join(worktreeRoot, ".build/mobile-worktree-cache-integration"),
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "build"
    ],
    worktreeRoot,
    logPath
  );
}

describeIntegration("ExpoModulesJSI shared pnpm store isolation", () => {
  it(
    "rebuilds nested Xcode intermediates when sequential worktrees use different Pods roots",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "kanna-expo-jsi-worktrees-"));
      const archivePath = join(fixtureRoot, "source.tar");
      const firstRootPath = join(fixtureRoot, "worktree-a");
      const secondRootPath = join(fixtureRoot, "worktree-b");
      const logPath = join(fixtureRoot, "build.log");
      let sharedPackageRoot: string | undefined;
      let succeeded = false;

      try {
        await archiveWorkingTree(archivePath);
        await Promise.all([mkdir(firstRootPath), mkdir(secondRootPath)]);
        const firstRoot = await realpath(firstRootPath);
        const secondRoot = await realpath(secondRootPath);
        await run("tar", ["-xf", archivePath, "-C", firstRoot], repoRoot, logPath);
        await run("tar", ["-xf", archivePath, "-C", secondRoot], repoRoot, logPath);

        await installAndPrebuild(firstRoot, logPath);
        sharedPackageRoot = await expoModulesJsiRoot(firstRoot);
        await Promise.all(
          [".DerivedData", ".build", ".swiftpm", ".build-context"].map((directory) =>
            rm(join(sharedPackageRoot!, "apple", directory), {
              recursive: true,
              force: true
            })
          )
        );
        await buildSimulator(firstRoot, logPath);
        await rm(firstRoot, { recursive: true, force: true });

        await installAndPrebuild(secondRoot, logPath);
        expect(await expoModulesJsiRoot(secondRoot)).toBe(sharedPackageRoot);
        expect(
          existsSync(
            join(
              secondRoot,
              "apps/mobile/ios/Pods/Headers/Public/hermes-engine/hermes/hermes.h"
            )
          )
        ).toBe(true);
        await buildSimulator(secondRoot, logPath);

        const responseFiles = await findFiles(
          join(sharedPackageRoot, "apple/.DerivedData"),
          "common-args.resp"
        );
        expect(responseFiles.length).toBeGreaterThan(0);
        const responseContents = await Promise.all(
          responseFiles.map((path) => readFile(path, "utf8"))
        );
        const secondRootAliases = [secondRoot, secondRootPath];
        const firstRootAliases = [firstRoot, firstRootPath];
        expect(
          responseContents.some((contents) =>
            secondRootAliases.some((root) => contents.includes(root))
          )
        ).toBe(true);
        expect(
          responseContents.every((contents) =>
            firstRootAliases.every((root) => !contents.includes(root))
          )
        ).toBe(true);
        const buildLog = await readFile(logPath, "utf8");
        expect(buildLog.match(/Build roots changed; cleaned DerivedData and SwiftPM state/g))
          .toHaveLength(2);
        succeeded = true;
      } finally {
        if (sharedPackageRoot) {
          await Promise.all(
            [".DerivedData", ".build", ".swiftpm", ".build-context"].map((directory) =>
              rm(join(sharedPackageRoot!, "apple", directory), {
                recursive: true,
                force: true
              })
            )
          );
        }
        if (succeeded || process.env.KANNA_KEEP_MOBILE_BUILD_FIXTURES !== "1") {
          await rm(fixtureRoot, { recursive: true, force: true });
        } else {
          console.error(`Retained failed worktree fixtures at ${fixtureRoot}`);
        }
      }
    },
    30 * 60 * 1000
  );
});
