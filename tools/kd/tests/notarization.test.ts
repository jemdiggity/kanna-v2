import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  preflightNotarizationCredentials,
  resolveNotarizationCredentialSelection,
  setupNotarizationCredentials
} from "../src/runtime/notarization";
import type { CommandRunner } from "../src/runtime/process";

describe("notarization credential selection", () => {
  it("requires both the profile and absolute Keychain selector", () => {
    expect(() => resolveNotarizationCredentialSelection({})).toThrow(
      /Missing APPLE_KEYCHAIN_PROFILE/
    );
    expect(() => resolveNotarizationCredentialSelection({
      APPLE_KEYCHAIN_PROFILE: "profile"
    })).toThrow(/Missing APPLE_KEYCHAIN_PATH/);
    expect(() => resolveNotarizationCredentialSelection({
      APPLE_KEYCHAIN_PROFILE: "profile",
      APPLE_KEYCHAIN_PATH: "relative.keychain-db"
    })).toThrow(/absolute Keychain path/);
  });

  it("runs online validation with the exact profile and Keychain pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-notary-preflight-"));
    const keychainPath = join(root, "login.keychain-db");
    await writeFile(keychainPath, "keychain fixture\n");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        return { exitCode: 0, stdout: '{"history":[]}', stderr: "" };
      }
    };

    await expect(preflightNotarizationCredentials({
      cwd: root,
      env: {
        APPLE_KEYCHAIN_PROFILE: "kanna-notarization",
        APPLE_KEYCHAIN_PATH: keychainPath
      },
      runner
    })).resolves.toEqual({
      profile: "kanna-notarization",
      keychainPath
    });
    expect(calls).toEqual([{
      command: "xcrun",
      args: [
        "notarytool",
        "history",
        "--keychain-profile",
        "kanna-notarization",
        "--keychain",
        keychainPath,
        "--output-format",
        "json",
        "--no-progress"
      ]
    }]);
  });

  it.each([
    [
      "missing profile item",
      "No Keychain password item found for profile: kanna-notarization",
      /profile is missing from the selected Keychain/
    ],
    [
      "locked Keychain",
      "User interaction is not allowed while the keychain is locked",
      /Keychain is locked or inaccessible/
    ],
    [
      "invalid credentials",
      "Authentication failed: invalid credentials for super-secret-value",
      /Apple rejected the configured notarization credentials/
    ]
  ])("classifies %s without echoing command output", async (_label, stderr, expected) => {
    const root = await mkdtemp(join(tmpdir(), "kanna-notary-preflight-"));
    const keychainPath = join(root, "login.keychain-db");
    await writeFile(keychainPath, "keychain fixture\n");
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 69, stdout: "", stderr };
      }
    };

    let message = "";
    try {
      await preflightNotarizationCredentials({
        cwd: root,
        env: {
          APPLE_KEYCHAIN_PROFILE: "kanna-notarization",
          APPLE_KEYCHAIN_PATH: keychainPath
        },
        runner
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(expected);
    expect(message).not.toContain("super-secret-value");
  });

  it("distinguishes a missing Keychain file without invoking notarytool", async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error("notarytool must not run");
      }
    };

    await expect(preflightNotarizationCredentials({
      cwd: "/tmp",
      env: {
        APPLE_KEYCHAIN_PROFILE: "profile",
        APPLE_KEYCHAIN_PATH: "/tmp/definitely-missing-kanna.keychain-db"
      },
      runner
    })).rejects.toThrow(/Keychain does not exist/);
  });
});

describe("notarization setup", () => {
  it("stores credentials interactively before writing owner-only machine selectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-notary-setup-"));
    const primary = join(root, "repo");
    const homeDir = join(root, "home");
    const keychainPath = join(root, "login.keychain-db");
    await mkdir(primary);
    await writeFile(keychainPath, "keychain fixture\n");
    const calls: Array<{
      command: string;
      args: string[];
      interactive?: boolean;
    }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, interactive: options?.interactive });
        if (command === "security") {
          return { exitCode: 0, stdout: `    \"${keychainPath}\"\n`, stderr: "" };
        }
        if (command === "git") {
          return { exitCode: 0, stdout: `worktree ${primary}\nHEAD abc123\n\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await setupNotarizationCredentials({
      cwd: root,
      homeDir,
      env: { PATH: "/usr/bin" },
      runner
    });

    expect(result).toEqual({
      profile: "kanna-notarization",
      keychainPath,
      configPath: join(homeDir, ".kanna", ".env.release.local")
    });
    expect(calls).toEqual([
      {
        command: "security",
        args: ["default-keychain", "-d", "user"],
        interactive: undefined
      },
      {
        command: "xcrun",
        args: [
          "notarytool",
          "store-credentials",
          "kanna-notarization",
          "--keychain",
          keychainPath,
          "--validate"
        ],
        interactive: true
      },
      {
        command: "git",
        args: ["worktree", "list", "--porcelain"],
        interactive: undefined
      }
    ]);
    expect(await readFile(result.configPath, "utf8")).toContain(
      'APPLE_KEYCHAIN_PROFILE="kanna-notarization"'
    );
    expect(await readFile(result.configPath, "utf8")).toContain(
      `APPLE_KEYCHAIN_PATH=${JSON.stringify(keychainPath)}`
    );
    expect((await stat(result.configPath)).mode & 0o777).toBe(0o600);
  });

  it("does not write selector config when credential validation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-notary-setup-"));
    const homeDir = join(root, "home");
    const keychainPath = join(root, "login.keychain-db");
    await writeFile(keychainPath, "keychain fixture\n");
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 69, stdout: "", stderr: "invalid credentials" };
      }
    };

    await expect(setupNotarizationCredentials({
      cwd: root,
      homeDir,
      env: {},
      runner,
      profile: "profile",
      keychainPath
    })).rejects.toThrow(/did not store the profile/);
    await expect(readFile(join(homeDir, ".kanna", ".env.release.local"), "utf8"))
      .rejects.toThrow();
  });
});
