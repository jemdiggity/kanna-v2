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
  const chunks: Buffer[] = [];
  git.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const gitExit = await new Promise<number | null>((resolveExit, reject) => {
    git.once("error", reject);
    git.once("exit", resolveExit);
  });
  expect(gitExit).toBe(0);

  const existingPaths = Buffer.concat(chunks)
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(join(repoRoot, path)));
  const tar = spawn("tar", ["--null", "-T", "-", "-cf", archivePath], {
    cwd: repoRoot,
    stdio: ["pipe", "inherit", "inherit"]
  });
  tar.stdin.end(`${existingPaths.join("\0")}\0`);
  const tarExit = await new Promise<number | null>((resolveExit, reject) => {
    tar.once("error", reject);
    tar.once("exit", resolveExit);
  });
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

async function installAndPrebuild(
  worktreeRoot: string,
  storeRoot: string,
  logPath: string
): Promise<void> {
  await run(
    "pnpm",
    ["install", "--frozen-lockfile", "--store-dir", storeRoot],
    worktreeRoot,
    logPath
  );
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
    logPath,
    { KANNA_APP_ENV: "dev" }
  );
}

describeIntegration("ExpoModulesJSI shared pnpm store isolation", () => {
  it(
    "isolates ExpoModulesJSI state while two worktrees build concurrently",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "kanna-expo-jsi-worktrees-"));
      const archivePath = join(fixtureRoot, "source.tar");
      const storeRoot = join(fixtureRoot, "pnpm-store");
      const firstRootPath = join(fixtureRoot, "worktree-a");
      const secondRootPath = join(fixtureRoot, "worktree-b");
      const setupLogPath = join(fixtureRoot, "setup.log");
      const firstBuildLogPath = join(fixtureRoot, "build-a.log");
      const secondBuildLogPath = join(fixtureRoot, "build-b.log");
      const packageRoots = new Set<string>();
      let succeeded = false;

      try {
        await archiveWorkingTree(archivePath);
        await Promise.all([mkdir(firstRootPath), mkdir(secondRootPath)]);
        const firstRoot = await realpath(firstRootPath);
        const secondRoot = await realpath(secondRootPath);
        await Promise.all([
          run("tar", ["-xf", archivePath, "-C", firstRoot], repoRoot, setupLogPath),
          run("tar", ["-xf", archivePath, "-C", secondRoot], repoRoot, setupLogPath)
        ]);

        await Promise.all([
          installAndPrebuild(firstRoot, storeRoot, setupLogPath),
          installAndPrebuild(secondRoot, storeRoot, setupLogPath)
        ]);

        const firstPackageRoot = await expoModulesJsiRoot(firstRoot);
        const secondPackageRoot = await expoModulesJsiRoot(secondRoot);
        packageRoots.add(firstPackageRoot);
        packageRoots.add(secondPackageRoot);
        expect(firstPackageRoot).not.toBe(secondPackageRoot);

        for (const worktreeRoot of [firstRoot, secondRoot]) {
          expect(
            existsSync(
              join(
                worktreeRoot,
                "apps/mobile/ios/Pods/Headers/Public/hermes-engine/hermes/hermes.h"
              )
            )
          ).toBe(true);
        }

        const firstBuild = buildSimulator(firstRoot, firstBuildLogPath);
        const secondBuild = buildSimulator(secondRoot, secondBuildLogPath);
        await Promise.all([firstBuild, secondBuild]);

        const contexts = [
          {
            packageRoot: firstPackageRoot,
            ownRoots: [firstRoot, firstRootPath],
            otherRoots: [secondRoot, secondRootPath]
          },
          {
            packageRoot: secondPackageRoot,
            ownRoots: [secondRoot, secondRootPath],
            otherRoots: [firstRoot, firstRootPath]
          }
        ];
        for (const { packageRoot, ownRoots, otherRoots } of contexts) {
          const responseFiles = await findFiles(
            join(packageRoot, "apple/.DerivedData"),
            "common-args.resp"
          );
          expect(responseFiles.length).toBeGreaterThan(0);
          const responseContents = await Promise.all(
            responseFiles.map((path) => readFile(path, "utf8"))
          );
          expect(
            responseContents.some((contents) =>
              ownRoots.some((root) => contents.includes(root))
            )
          ).toBe(true);
          expect(
            responseContents.every((contents) =>
              otherRoots.every((root) => !contents.includes(root))
            )
          ).toBe(true);
        }
        succeeded = true;
      } finally {
        for (const packageRoot of packageRoots) {
          await Promise.all(
            [".DerivedData", ".build", ".swiftpm", ".build-context"].map((directory) =>
              rm(join(packageRoot, "apple", directory), {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 200
              })
            )
          );
        }
        if (succeeded || process.env.KANNA_KEEP_MOBILE_BUILD_FIXTURES !== "1") {
          await rm(fixtureRoot, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200
          });
        } else {
          console.error(`Retained failed worktree fixtures at ${fixtureRoot}`);
        }
      }
    },
    45 * 60 * 1000
  );
});
