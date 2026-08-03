import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
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

  it.each(["APPLE_PASSWORD", "TAURI_PRIVATE_KEY_PASSWORD", "GH_TOKEN"])(
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
