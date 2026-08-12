import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  loadReleaseEnvironment,
  writeMachineNotarizationSelectors
} from "../src/runtime/release-env";

async function createFixture(): Promise<{
  root: string;
  home: string;
  globalEnvPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "kanna-release-env-"));
  const home = join(root, "home");
  const globalEnvPath = join(home, ".kanna", ".env.release.local");
  await mkdir(join(home, ".kanna"), { recursive: true });
  return { root, home, globalEnvPath };
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

interface SynchronizedMutation {
  done: Promise<void>;
  synchronization: {
    event: "after-release-file-read" | "after-temp-created" | "before-release-file-rename";
    readyPath: string;
    continuePath: string;
  };
}

function startSynchronizedMutation(input: {
  root: string;
  event: "after-release-file-read" | "after-temp-created" | "before-release-file-rename";
  mutation:
    | {
        kind: "replace-home";
        home: string;
        detachedHome: string;
        replacementSource: string;
      }
    | {
        kind: "replace-file";
        envPath: string;
        replacementSource: string;
      };
}): SynchronizedMutation {
  const readyPath = join(input.root, `worker-ready-${randomUUID()}`);
  const continuePath = join(input.root, `worker-continue-${randomUUID()}`);
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(process.argv[1]);
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10000;
while (!fs.existsSync(input.readyPath)) {
  if (Date.now() >= deadline) throw new Error("Timed out waiting for worker synchronization");
  Atomics.wait(waitArray, 0, 0, 10);
}
if (input.mutation.kind === "replace-home") {
  fs.renameSync(input.mutation.home, input.mutation.detachedHome);
  fs.mkdirSync(path.join(input.mutation.home, ".kanna"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(input.mutation.home, ".kanna", ".env.release.local"),
    input.mutation.replacementSource,
    { mode: 0o600 }
  );
} else {
  const competingPath = input.mutation.envPath + ".competing";
  fs.writeFileSync(competingPath, input.mutation.replacementSource, { mode: 0o600 });
  fs.renameSync(competingPath, input.mutation.envPath);
}
fs.writeFileSync(input.continuePath, "continue", { flag: "wx" });`,
      JSON.stringify({
        readyPath,
        continuePath,
        mutation: input.mutation
      })
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const done = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Synchronized mutation failed (${code ?? "signal"}): ${stderr.trim()}`));
      }
    });
  });
  return {
    done,
    synchronization: { event: input.event, readyPath, continuePath }
  };
}

function startConcurrentNotarizationWrite(input: {
  root: string;
  home: string;
}): SynchronizedMutation {
  const readyPath = join(input.root, `worker-ready-${randomUUID()}`);
  const continuePath = join(input.root, `worker-continue-${randomUUID()}`);
  const moduleUrl = new URL("../src/runtime/release-env.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
const input = JSON.parse(process.argv[1]);
const waitArray = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10000;
while (!fs.existsSync(input.readyPath)) {
  if (Date.now() >= deadline) throw new Error("Timed out waiting for first selector writer");
  Atomics.wait(waitArray, 0, 0, 10);
}
try {
  const module = await import(input.moduleUrl);
  module.writeMachineNotarizationSelectors({
    homeDir: input.home,
    profile: "concurrent-notary",
    keychainPath: "/concurrent-notary.keychain-db"
  });
  throw new Error("Concurrent selector writer unexpectedly succeeded");
} catch (error) {
  if (!String(error).includes("already in progress")) throw error;
} finally {
  fs.writeFileSync(input.continuePath, "continue", { flag: "wx" });
}`,
      JSON.stringify({ ...input, readyPath, continuePath, moduleUrl })
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const done = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Concurrent selector write failed (${code ?? "signal"}): ${stderr.trim()}`));
    });
  });
  return {
    done,
    synchronization: { event: "before-release-file-rename", readyPath, continuePath }
  };
}

describe("release environment", () => {
  it("loads a valid 0600 regular machine-global release environment", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    await writePrivateFile(
      globalEnvPath,
      `APPLE_KEYCHAIN_PROFILE=global-profile\nAPPLE_KEYCHAIN_PATH=${join(root, "login.keychain-db")}\nRELEASE_DEFAULT=global\n`
    );

    const env = loadReleaseEnvironment({ homeDir: home, env: {} });

    expect(env).toEqual(expect.objectContaining({
      APPLE_KEYCHAIN_PROFILE: "global-profile",
      APPLE_KEYCHAIN_PATH: join(root, "login.keychain-db"),
      RELEASE_DEFAULT: "global"
    }));
  });

  it("rejects a machine-global release environment symlinked to a repository file", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    const repositoryEnvPath = join(root, "repo", ".env.release.local");
    await mkdir(join(root, "repo"), { recursive: true });
    await writePrivateFile(repositoryEnvPath, "APPLE_KEYCHAIN_PROFILE=repository-profile\n");
    await symlink(repositoryEnvPath, globalEnvPath);

    expect(() => loadReleaseEnvironment({ homeDir: home, env: {} }))
      .toThrow(/regular file, not a symbolic link/);
  });

  it("rejects loading through a symlinked ~/.kanna directory", async () => {
    const { root, home } = await createFixture();
    const repositoryConfigDir = join(root, "repo", "machine-config");
    await mkdir(repositoryConfigDir, { recursive: true });
    await writePrivateFile(
      join(repositoryConfigDir, ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=repository-profile\n"
    );
    await rm(join(home, ".kanna"), { recursive: true });
    await symlink(repositoryConfigDir, join(home, ".kanna"));

    expect(() => loadReleaseEnvironment({ homeDir: home, env: {} }))
      .toThrow(/configuration directory must not be a symbolic link/);
  });

  it("fails a load when the canonical home path is replaced after the file is read", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    const detachedHome = join(root, "detached-home");
    const originalSource = "RELEASE_DEFAULT=original\n";
    const replacementSource = "RELEASE_DEFAULT=replacement\n";
    await writePrivateFile(globalEnvPath, originalSource);
    const mutation = startSynchronizedMutation({
      root,
      event: "after-release-file-read",
      mutation: {
        kind: "replace-home",
        home,
        detachedHome,
        replacementSource
      }
    });

    expect(() => loadReleaseEnvironment({
      homeDir: home,
      env: {},
      testSynchronization: mutation.synchronization
    })).toThrow(/canonical path changed during access/);
    await mutation.done;

    expect(await readFile(globalEnvPath, "utf8")).toBe(replacementSource);
    expect(await readFile(
      join(detachedHome, ".kanna", ".env.release.local"),
      "utf8"
    )).toBe(originalSource);
  });

  it("never reads a primary-checkout or worktree release file", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    const primary = join(root, "repo");
    const worktree = join(primary, ".kanna-worktrees", "task-123");
    await mkdir(worktree, { recursive: true });
    await writePrivateFile(globalEnvPath, "RELEASE_DEFAULT=global\n");
    await writeFile(
      join(primary, ".env.release.local"),
      "RELEASE_DEFAULT=primary\nPRIMARY_ONLY=must-not-load\nAPPLE_PASSWORD=must-not-load\n"
    );
    await writeFile(
      join(worktree, ".env.release.local"),
      "RELEASE_DEFAULT=worktree\nWORKTREE_ONLY=must-not-load\n"
    );

    const env = loadReleaseEnvironment({ homeDir: home, env: { PATH: "/usr/bin" } });

    expect(env).toEqual({ RELEASE_DEFAULT: "global", PATH: "/usr/bin" });
  });

  it("lets explicit inherited selectors override machine-global defaults", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    await writePrivateFile(
      globalEnvPath,
      `APPLE_KEYCHAIN_PROFILE=global-profile\nAPPLE_KEYCHAIN_PATH=${join(root, "global.keychain-db")}\n`
    );

    const env = loadReleaseEnvironment({
      homeDir: home,
      env: {
        APPLE_KEYCHAIN_PROFILE: "shell-profile",
        APPLE_KEYCHAIN_PATH: join(root, "shell.keychain-db")
      }
    });

    expect(env.APPLE_KEYCHAIN_PROFILE).toBe("shell-profile");
    expect(env.APPLE_KEYCHAIN_PATH).toBe(join(root, "shell.keychain-db"));
  });

  it.each([
    "APPLE_PASSWORD",
    "TAURI_PRIVATE_KEY_PASSWORD",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "GH_TOKEN"
  ])(
    "rejects plaintext release credential %s from machine-global config",
    async (credentialKey) => {
      const { home, globalEnvPath } = await createFixture();
      await writePrivateFile(globalEnvPath, `${credentialKey}=must-not-be-printed\n`);

      expect(() => loadReleaseEnvironment({ homeDir: home, env: {} }))
        .toThrow(new RegExp(`Plaintext release credentials.*${credentialKey}`));
    }
  );

  it("requires every machine-global release file to be owner-only", async () => {
    const { home, globalEnvPath } = await createFixture();
    await writeFile(globalEnvPath, "RELEASE_DEFAULT=value\n", { mode: 0o644 });
    await chmod(globalEnvPath, 0o644);

    expect(() => loadReleaseEnvironment({ homeDir: home, env: {} }))
      .toThrow(/owner-only \(0600\).*chmod 600/);
  });

  it("writes only non-secret selectors to machine config and repairs its mode", async () => {
    const { home, globalEnvPath } = await createFixture();
    await writeFile(
      globalEnvPath,
      "RELEASE_DEFAULT=keep\nAPPLE_KEYCHAIN_PROFILE=old\n",
      { mode: 0o644 }
    );

    expect(writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "new-profile",
      keychainPath: "/Users/test/Library/Keychains/login.keychain-db"
    })).toBe(globalEnvPath);

    expect(await readFile(globalEnvPath, "utf8")).toBe(
      'RELEASE_DEFAULT=keep\nAPPLE_KEYCHAIN_PROFILE="new-profile"\nAPPLE_KEYCHAIN_PATH="/Users/test/Library/Keychains/login.keychain-db"\n'
    );
    expect((await stat(globalEnvPath)).mode & 0o777).toBe(0o600);
  });

  it("serializes the final check and rename across notarization writers", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    await writePrivateFile(globalEnvPath, "RELEASE_DEFAULT=keep\n");
    const concurrent = startConcurrentNotarizationWrite({ root, home });

    writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "primary-notary",
      keychainPath: "/primary-notary.keychain-db",
      testSynchronization: concurrent.synchronization
    });
    await concurrent.done;

    expect(await readFile(globalEnvPath, "utf8")).toBe([
      "RELEASE_DEFAULT=keep",
      'APPLE_KEYCHAIN_PROFILE="primary-notary"',
      'APPLE_KEYCHAIN_PATH="/primary-notary.keychain-db"',
      ""
    ].join("\n"));
  });

  it.each([
    ["ownerless", undefined],
    ["malformed", "{not valid json"]
  ])("ignores an abandoned %s legacy selector lock", async (_label, ownerSource) => {
    const { home, globalEnvPath } = await createFixture();
    const legacyLock = join(home, ".kanna", ".release-environment-write.lock");
    await mkdir(legacyLock);
    if (ownerSource !== undefined) {
      await writeFile(join(legacyLock, "owner.json"), ownerSource, { mode: 0o600 });
    }

    expect(writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "recovered-notary",
      keychainPath: "/recovered-notary.keychain-db"
    })).toBe(globalEnvPath);
    expect(await readFile(globalEnvPath, "utf8")).toContain(
      'APPLE_KEYCHAIN_PROFILE="recovered-notary"'
    );
  });

  it("reacquires an abandoned lockf inode and persists owner-only modes", async () => {
    const { home, globalEnvPath } = await createFixture();
    const kannaDir = join(home, ".kanna");
    const lockPath = join(kannaDir, ".release-environment-write.lockf");
    await chmod(kannaDir, 0o755);
    await writeFile(lockPath, "stale lock inode\n", { mode: 0o644 });
    await chmod(lockPath, 0o644);

    expect(writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "first-reacquisition",
      keychainPath: "/first-reacquisition.keychain-db"
    })).toBe(globalEnvPath);
    expect(writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "second-reacquisition",
      keychainPath: "/second-reacquisition.keychain-db"
    })).toBe(globalEnvPath);

    expect(await readFile(globalEnvPath, "utf8")).toContain(
      'APPLE_KEYCHAIN_PROFILE="second-reacquisition"'
    );
    expect((await stat(kannaDir)).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });

  it("repairs the shared writer lock before existing config validation fails", async () => {
    const { home, globalEnvPath } = await createFixture();
    const kannaDir = join(home, ".kanna");
    const lockPath = join(kannaDir, ".release-environment-write.lockf");
    await chmod(kannaDir, 0o755);
    await writeFile(lockPath, "stale lock inode\n", { mode: 0o644 });
    await chmod(lockPath, 0o644);
    await writePrivateFile(globalEnvPath, "GH_TOKEN=plaintext-is-rejected\n");

    expect(() => writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "must-not-write",
      keychainPath: "/must-not-write.keychain-db"
    })).toThrow(/Plaintext release credentials/);

    expect((await stat(kannaDir)).mode & 0o777).toBe(0o700);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(globalEnvPath, "utf8")).toBe(
      "GH_TOKEN=plaintext-is-rejected\n"
    );
  });

  it("rejects setup through a symlinked ~/.kanna directory without modifying its target", async () => {
    const { root, home } = await createFixture();
    const repositoryConfigDir = join(root, "repo", "machine-config");
    const repositoryEnvPath = join(repositoryConfigDir, ".env.release.local");
    await mkdir(repositoryConfigDir, { recursive: true });
    await writePrivateFile(repositoryEnvPath, "RELEASE_DEFAULT=repository-owned\n");
    await rm(join(home, ".kanna"), { recursive: true });
    await symlink(repositoryConfigDir, join(home, ".kanna"));

    expect(() => writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "must-not-write",
      keychainPath: "/Users/test/Library/Keychains/login.keychain-db"
    })).toThrow(/configuration directory must not be a symbolic link/);

    expect(await readFile(repositoryEnvPath, "utf8")).toBe(
      "RELEASE_DEFAULT=repository-owned\n"
    );
  });

  it("fails setup when the canonical home path is replaced after temp creation", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    const detachedHome = join(root, "detached-home");
    const originalSource = "RELEASE_DEFAULT=original\n";
    const replacementSource = "RELEASE_DEFAULT=replacement\n";
    await writePrivateFile(globalEnvPath, originalSource);
    const mutation = startSynchronizedMutation({
      root,
      event: "after-temp-created",
      mutation: {
        kind: "replace-home",
        home,
        detachedHome,
        replacementSource
      }
    });

    expect(() => writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "must-not-write",
      keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
      testSynchronization: mutation.synchronization
    })).toThrow(/canonical path changed during access/);
    await mutation.done;

    expect(await readFile(globalEnvPath, "utf8")).toBe(replacementSource);
    expect(await readFile(
      join(detachedHome, ".kanna", ".env.release.local"),
      "utf8"
    )).toBe(originalSource);
  });

  it("does not overwrite a competing edit made after temp creation", async () => {
    const { root, home, globalEnvPath } = await createFixture();
    const originalSource = "RELEASE_DEFAULT=original\n";
    const competingSource = "RELEASE_DEFAULT=original\nCONCURRENT_EDIT=preserved\n";
    await writePrivateFile(globalEnvPath, originalSource);
    const mutation = startSynchronizedMutation({
      root,
      event: "after-temp-created",
      mutation: {
        kind: "replace-file",
        envPath: globalEnvPath,
        replacementSource: competingSource
      }
    });

    expect(() => writeMachineNotarizationSelectors({
      homeDir: home,
      profile: "must-not-write",
      keychainPath: "/Users/test/Library/Keychains/login.keychain-db",
      testSynchronization: mutation.synchronization
    })).toThrow(/changed while selectors were being written/);
    await mutation.done;

    expect(await readFile(globalEnvPath, "utf8")).toBe(competingSource);
  });

  it("strips every compiler-wrapper and cache control from file and process values", async () => {
    const { home, globalEnvPath } = await createFixture();
    await writePrivateFile(globalEnvPath, "RUSTC_WRAPPER=/from/dotenv\nRELEASE_DEFAULT=value\n");

    const env = loadReleaseEnvironment({
      homeDir: home,
      env: {
        PATH: "/usr/bin",
        RUSTC_WRAPPER: "/tools/kache",
        RUSTC_WORKSPACE_WRAPPER: "/bin/false",
        CARGO_BUILD_RUSTC_WRAPPER: "/bin/false",
        CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "/bin/false",
        CARGO_INCREMENTAL: "0",
        KACHE_CACHE_DIR: "/store",
        KACHE_DISABLED: "1"
      }
    });

    expect(env).toEqual({ RELEASE_DEFAULT: "value", PATH: "/usr/bin" });
  });

  it("returns an equivalent copy when the global file is absent", async () => {
    const { home } = await createFixture();
    const inherited = { PATH: "/usr/bin" };

    const env = loadReleaseEnvironment({ homeDir: home, env: inherited });

    expect(env).toEqual(inherited);
    expect(env).not.toBe(inherited);
  });

  it("fails with the global path when dotenv syntax is invalid", async () => {
    const { home, globalEnvPath } = await createFixture();
    await writePrivateFile(globalEnvPath, "BROKEN LINE\n");

    expect(() => loadReleaseEnvironment({ homeDir: home, env: {} }))
      .toThrow(globalEnvPath);
  });

  it("fails with the global path when the file cannot be read", async () => {
    const { home, globalEnvPath } = await createFixture();
    await mkdir(globalEnvPath);

    expect(() => loadReleaseEnvironment({ homeDir: home, env: {} }))
      .toThrow(globalEnvPath);
  });

  it("accepts Node dotenv comments and multiline quoted values", async () => {
    const { home, globalEnvPath } = await createFixture();
    await writePrivateFile(
      globalEnvPath,
      'RELEASE_DEFAULT="value" # machine default\nRELEASE_NOTES="line one\nline two"\n'
    );

    const env = loadReleaseEnvironment({ homeDir: home, env: {} });

    expect(env.RELEASE_DEFAULT).toBe("value");
    expect(env.RELEASE_NOTES).toBe("line one\nline two");
  });
});
