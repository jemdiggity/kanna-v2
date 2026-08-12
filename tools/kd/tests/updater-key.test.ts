import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/runtime/process";
import {
  resolveUpdaterKeySelection,
  resolveUpdaterSigningKey,
  setupUpdaterKeyCredentials
} from "../src/runtime/updater-key";

function updaterEnvironment(keychainPath: string): NodeJS.ProcessEnv {
  return {
    KANNA_UPDATER_KEYCHAIN_SERVICE: "build.kanna.updater-key",
    KANNA_UPDATER_KEYCHAIN_ACCOUNT: "tauri-updater-signing-key",
    KANNA_UPDATER_KEYCHAIN_PATH: keychainPath
  };
}

describe("updater signing key selection", () => {
  it("requires a complete selector set and an absolute Keychain path", () => {
    expect(() => resolveUpdaterKeySelection({})).toThrow(
      /Missing KANNA_UPDATER_KEYCHAIN_SERVICE/
    );
    expect(() => resolveUpdaterKeySelection({
      KANNA_UPDATER_KEYCHAIN_SERVICE: "service"
    })).toThrow(/Missing KANNA_UPDATER_KEYCHAIN_ACCOUNT/);
    expect(() => resolveUpdaterKeySelection({
      KANNA_UPDATER_KEYCHAIN_SERVICE: "service",
      KANNA_UPDATER_KEYCHAIN_ACCOUNT: "account",
      KANNA_UPDATER_KEYCHAIN_PATH: "relative.keychain-db"
    })).toThrow(/absolute Keychain path/);
  });

  it("reads only the exact generic-password item selected in the configured Keychain", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-"));
    const keychainPath = join(root, "login.keychain-db");
    await writeFile(keychainPath, "keychain fixture\n");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: "secret updater key\n", stderr: "" };
      }
    };

    await expect(resolveUpdaterSigningKey({
      cwd: root,
      env: {
        ...updaterEnvironment(keychainPath),
        TAURI_PRIVATE_KEY_PATH: "/must/not/be/read"
      },
      runner
    })).resolves.toBe("secret updater key");
    expect(calls).toEqual([{
      command: "security",
      args: [
        "find-generic-password",
        "-s",
        "build.kanna.updater-key",
        "-a",
        "tauri-updater-signing-key",
        "-w",
        keychainPath
      ]
    }]);
  });

  it.each([
    ["missing item", "SecKeychainSearchCopyNext: The specified item could not be found.", /not stored/],
    ["locked Keychain", "User interaction is not allowed.", /locked or denied access/],
    ["unexpected failure", "failure containing secret updater key", /Unable to read/]
  ])("classifies %s without echoing command output", async (_label, stderr, expected) => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-"));
    const keychainPath = join(root, "login.keychain-db");
    await writeFile(keychainPath, "keychain fixture\n");
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 44, stdout: "", stderr };
      }
    };

    let message = "";
    try {
      await resolveUpdaterSigningKey({
        cwd: root,
        env: updaterEnvironment(keychainPath),
        runner
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(expected);
    expect(message).not.toContain("secret updater key");
  });
});

describe("updater signing key setup", () => {
  it("round-trips the key before writing owner-only selectors and preserves notarization config", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-setup-"));
    const homeDir = join(root, "home");
    const keychainPath = join(root, "login.keychain-db");
    const privateKeyPath = join(root, "updater.key");
    await mkdir(join(homeDir, ".kanna"), { recursive: true });
    await writeFile(keychainPath, "keychain fixture\n");
    await writeFile(privateKeyPath, "secret updater key\n");
    await writeFile(
      join(homeDir, ".kanna", ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=notary\nAPPLE_KEYCHAIN_PATH=/notary.keychain-db\n",
      { mode: 0o600 }
    );
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (args[0] === "add-generic-password") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "secret updater key\n", stderr: "" };
      }
    };

    const result = await setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: { TAURI_PRIVATE_KEY_PATH: privateKeyPath },
      runner,
      keychainPath
    });

    expect(result).toEqual({
      service: "build.kanna.updater-key",
      account: "tauri-updater-signing-key",
      keychainPath,
      configPath: join(homeDir, ".kanna", ".env.release.local")
    });
    expect(calls).toEqual([
      {
        command: "security",
        args: [
          "add-generic-password",
          "-U",
          "-s",
          "build.kanna.updater-key",
          "-a",
          "tauri-updater-signing-key",
          "-w",
          "secret updater key",
          keychainPath
        ]
      },
      {
        command: "security",
        args: [
          "find-generic-password",
          "-s",
          "build.kanna.updater-key",
          "-a",
          "tauri-updater-signing-key",
          "-w",
          keychainPath
        ]
      }
    ]);
    const config = await readFile(result.configPath, "utf8");
    expect(config).toContain("APPLE_KEYCHAIN_PROFILE=notary");
    expect(config).toContain('KANNA_UPDATER_KEYCHAIN_SERVICE="build.kanna.updater-key"');
    expect(config).toContain(`KANNA_UPDATER_KEYCHAIN_PATH=${JSON.stringify(keychainPath)}`);
    expect(config).not.toContain("secret updater key");
    expect((await stat(result.configPath)).mode & 0o777).toBe(0o600);
  });

  it("does not write selectors when the stored key fails round-trip verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-setup-"));
    const homeDir = join(root, "home");
    const keychainPath = join(root, "login.keychain-db");
    const privateKeyPath = join(root, "updater.key");
    await mkdir(homeDir);
    await writeFile(keychainPath, "keychain fixture\n");
    await writeFile(privateKeyPath, "expected key\n");
    const runner: CommandRunner = {
      async run(_command, args) {
        return args[0] === "add-generic-password"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: "different key\n", stderr: "" };
      }
    };

    await expect(setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: { TAURI_PRIVATE_KEY_PATH: privateKeyPath },
      runner,
      keychainPath
    })).rejects.toThrow(/does not match the source key/);
    await expect(readFile(join(homeDir, ".kanna", ".env.release.local"), "utf8"))
      .rejects.toThrow();
  });
});
