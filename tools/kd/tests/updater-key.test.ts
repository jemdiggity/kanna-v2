import { createHash, generateKeyPairSync, sign as signDigest } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/runtime/process";
import {
  assertUpdaterSigningKeyMatchesPublicKey,
  resolveUpdaterKeySelection,
  resolveUpdaterSigningKey,
  setupUpdaterKeyCredentials
} from "../src/runtime/updater-key";

const testKeyPair = generateKeyPairSync("ed25519");
const testKeyId = Buffer.from("0102030405060708", "hex");

function testUpdaterPublicKey(publicKey = testKeyPair.publicKey): string {
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const payload = Buffer.concat([Buffer.from("Ed"), testKeyId, publicDer.subarray(-32)]);
  const envelope = `untrusted comment: minisign public key\n${payload.toString("base64")}\n`;
  return Buffer.from(envelope).toString("base64");
}

async function writeTestSignature(challengePath: string): Promise<void> {
  const challenge = await readFile(challengePath);
  const signature = signDigest(
    null,
    createHash("blake2b512").update(challenge).digest(),
    testKeyPair.privateKey
  );
  const payload = Buffer.concat([Buffer.from("ED"), testKeyId, signature]);
  const envelope = `untrusted comment: test signature\n${payload.toString("base64")}\n`;
  await writeFile(`${challengePath}.sig`, Buffer.from(envelope).toString("base64"));
}

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

  it("rejects an empty item from the exact selected Keychain", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-"));
    const keychainPath = join(root, "login.keychain-db");
    await writeFile(keychainPath, "keychain fixture\n");
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, stdout: "\n", stderr: "" };
      }
    };

    await expect(resolveUpdaterSigningKey({
      cwd: root,
      env: updaterEnvironment(keychainPath),
      runner
    })).rejects.toThrow(/stored.*is empty/);
  });
});

describe("updater signing key setup", () => {
  async function setupFixture(): Promise<{ root: string; homeDir: string; keychainPath: string }> {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-setup-"));
    const homeDir = join(root, "home");
    const keychainPath = join(root, "login.keychain-db");
    await mkdir(homeDir);
    await writeFile(keychainPath, "keychain fixture\n");
    return { root, homeDir, keychainPath };
  }

  it("prompts natively, validates the stored item, and publishes owner-only selectors", async () => {
    const { root, homeDir, keychainPath } = await setupFixture();
    await mkdir(join(homeDir, ".kanna"));
    await mkdir(join(homeDir, ".kanna", ".updater-key-setup.lock"));
    await writeFile(
      join(homeDir, ".kanna", ".env.release.local"),
      "APPLE_KEYCHAIN_PROFILE=notary\nAPPLE_KEYCHAIN_PATH=/notary.keychain-db\n",
      { mode: 0o600 }
    );
    const calls: Array<{ command: string; args: string[]; interactive?: boolean }> = [];
    let lookupCount = 0;
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, interactive: options?.interactive });
        if (args[0] === "default-keychain") {
          return { exitCode: 0, stdout: `"${keychainPath}"\n`, stderr: "" };
        }
        if (args[0] === "find-generic-password") {
          lookupCount += 1;
          return lookupCount === 1
            ? { exitCode: 44, stdout: "", stderr: "SecKeychainSearchCopyNext: item could not be found" }
            : { exitCode: 0, stdout: "secret updater key\n", stderr: "" };
        }
        if (command === "pnpm") {
          const challengePath = args.at(-1);
          if (!challengePath) throw new Error("missing challenge path");
          await writeTestSignature(challengePath);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: {
        KANNA_UPDATER_PUBKEY: testUpdaterPublicKey(),
        TAURI_PRIVATE_KEY_PATH: "/must/not/be/read"
      },
      runner,
      keychainPath
    });

    expect(result).toEqual(expect.objectContaining({ keychainPath }));
    const promptCall = calls.find((call) => call.args[0] === "add-generic-password");
    expect(promptCall).toEqual({
      command: "security",
      args: [
        "add-generic-password",
        "-s",
        "build.kanna.updater-key",
        "-a",
        "tauri-updater-signing-key",
        keychainPath,
        "-w"
      ],
      interactive: true
    });
    expect(calls.flatMap((call) => call.args)).not.toContain("secret updater key");
    const config = await readFile(result.configPath, "utf8");
    expect(config).toContain("APPLE_KEYCHAIN_PROFILE=notary");
    expect(config).toContain('KANNA_UPDATER_KEYCHAIN_SERVICE="build.kanna.updater-key"');
    expect(config).not.toContain("secret updater key");
    expect((await stat(result.configPath)).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing valid item without invoking the destructive update form", async () => {
    const { root, homeDir, keychainPath } = await setupFixture();
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (args[0] === "default-keychain") {
          return { exitCode: 0, stdout: `"${keychainPath}"\n`, stderr: "" };
        }
        if (args[0] === "find-generic-password") {
          return { exitCode: 0, stdout: "secret updater key\n", stderr: "" };
        }
        if (command === "pnpm") {
          const challengePath = args.at(-1);
          if (!challengePath) throw new Error("missing challenge path");
          await writeTestSignature(challengePath);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      }
    };

    await expect(setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: { KANNA_UPDATER_PUBKEY: testUpdaterPublicKey() },
      runner,
      keychainPath
    })).resolves.toEqual(expect.objectContaining({ keychainPath }));
    expect(calls.some((call) => call.args[0] === "add-generic-password")).toBe(false);
    expect(calls.some((call) => call.args[0] === "delete-generic-password")).toBe(false);
  });

  it("rejects a non-default target before reading or changing any item", async () => {
    const { root, homeDir, keychainPath } = await setupFixture();
    const defaultKeychainPath = join(root, "default.keychain-db");
    await writeFile(defaultKeychainPath, "different keychain fixture\n");
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(_command, args) {
        calls.push(args[0] ?? "");
        return { exitCode: 0, stdout: `"${defaultKeychainPath}"\n`, stderr: "" };
      }
    };

    await expect(setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: { KANNA_UPDATER_PUBKEY: testUpdaterPublicKey() },
      runner,
      keychainPath
    })).rejects.toThrow(/current default file-based Keychain/);
    expect(calls).toEqual(["default-keychain"]);
  });

  it("preserves an existing mismatched item and requires a fresh selector", async () => {
    const { root, homeDir, keychainPath } = await setupFixture();
    const otherKeyPair = generateKeyPairSync("ed25519");
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(args[0] ?? command);
        if (args[0] === "default-keychain") {
          return { exitCode: 0, stdout: `"${keychainPath}"\n`, stderr: "" };
        }
        if (args[0] === "find-generic-password") {
          return { exitCode: 0, stdout: "existing key\n", stderr: "" };
        }
        const challengePath = args.at(-1);
        if (!challengePath) throw new Error("missing challenge path");
        await writeTestSignature(challengePath);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: { KANNA_UPDATER_PUBKEY: testUpdaterPublicKey(otherKeyPair.publicKey) },
      runner,
      keychainPath
    })).rejects.toThrow(/was not overwritten.*fresh --service or --account/);
    expect(calls).not.toContain("add-generic-password");
    expect(calls).not.toContain("delete-generic-password");
  });

  it("never deletes a newly prompted item when later selector publication fails", async () => {
    const { root, homeDir, keychainPath } = await setupFixture();
    const configPath = join(homeDir, ".kanna", ".env.release.local");
    await mkdir(join(homeDir, ".kanna"));
    await writeFile(configPath, "GH_TOKEN=plaintext-is-rejected\n", { mode: 0o600 });
    let lookupCount = 0;
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(args[0] ?? command);
        if (args[0] === "default-keychain") {
          return { exitCode: 0, stdout: `"${keychainPath}"\n`, stderr: "" };
        }
        if (args[0] === "find-generic-password") {
          lookupCount += 1;
          return lookupCount === 1
            ? { exitCode: 44, stdout: "", stderr: "item could not be found" }
            : { exitCode: 0, stdout: "new key\n", stderr: "" };
        }
        if (command === "pnpm") {
          const challengePath = args.at(-1);
          if (!challengePath) throw new Error("missing challenge path");
          await writeTestSignature(challengePath);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(setupUpdaterKeyCredentials({
      cwd: root,
      homeDir,
      env: { KANNA_UPDATER_PUBKEY: testUpdaterPublicKey() },
      runner,
      keychainPath
    })).rejects.toThrow(/Plaintext release credentials/);
    expect(calls).not.toContain("delete-generic-password");
    expect(await readFile(configPath, "utf8")).toBe("GH_TOKEN=plaintext-is-rejected\n");
  });

  it("lets only one of two contenders proceed past the same malformed legacy lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-setup-"));
    const homeDir = join(root, "home");
    const keychainPath = join(root, "login.keychain-db");
    await mkdir(homeDir);
    await mkdir(join(homeDir, ".kanna"));
    await mkdir(join(homeDir, ".kanna", ".updater-key-setup.lock"));
    await writeFile(
      join(homeDir, ".kanna", ".updater-key-setup.lock", "owner.json"),
      "{not valid json",
      { mode: 0o600 }
    );
    await writeFile(keychainPath, "keychain fixture\n");
    let releaseFirstLookup: (() => void) | undefined;
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve;
    });
    let firstLookupStarted: (() => void) | undefined;
    const firstLookupReady = new Promise<void>((resolve) => {
      firstLookupStarted = resolve;
    });
    let firstLookup = true;
    const firstRunner: CommandRunner = {
      async run(command, args) {
        if (args[0] === "default-keychain") {
          return { exitCode: 0, stdout: `"${keychainPath}"\n`, stderr: "" };
        }
        if (command === "pnpm") {
          const challengePath = args.at(-1);
          if (!challengePath) throw new Error("missing challenge path");
          await writeTestSignature(challengePath);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "find-generic-password" && firstLookup) {
          firstLookup = false;
          firstLookupStarted?.();
          await firstLookupGate;
          return {
            exitCode: 44,
            stdout: "",
            stderr: "SecKeychainSearchCopyNext: The specified item could not be found."
          };
        }
        if (args[0] === "find-generic-password") {
          return { exitCode: 0, stdout: "secret updater key\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const secondSecurityCalls: string[] = [];
    const secondRunner: CommandRunner = {
      async run(command, args) {
        if (command === "pnpm") {
          const challengePath = args.at(-1);
          if (!challengePath) throw new Error("missing challenge path");
          await writeTestSignature(challengePath);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        secondSecurityCalls.push(args[0] ?? command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const setupInput = {
      cwd: root,
      homeDir,
      env: {
        KANNA_UPDATER_PUBKEY: testUpdaterPublicKey()
      },
      keychainPath
    };

    const firstSetup = setupUpdaterKeyCredentials({ ...setupInput, runner: firstRunner });
    await firstLookupReady;
    await expect(setupUpdaterKeyCredentials({
      ...setupInput,
      runner: secondRunner
    })).rejects.toThrow(/already in progress/);
    expect(secondSecurityCalls).toEqual([]);
    releaseFirstLookup?.();
    await expect(firstSetup).resolves.toEqual(expect.objectContaining({ keychainPath }));
  });
});

describe("updater signing key compatibility", () => {
  it("verifies a Tauri minisign challenge without returning or logging key material", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-verify-"));
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(_command, args, options) {
        calls.push({ args, env: options?.env });
        const challengePath = args.at(-1);
        if (!challengePath) throw new Error("missing challenge path");
        await writeTestSignature(challengePath);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(assertUpdaterSigningKeyMatchesPublicKey({
      cwd: root,
      env: {},
      runner,
      material: "secret updater key",
      publicKey: testUpdaterPublicKey()
    })).resolves.toBeUndefined();
    expect(calls[0]?.args).not.toContain("secret updater key");
    expect(calls[0]?.env?.TAURI_SIGNING_PRIVATE_KEY).toBe("secret updater key");
    expect(calls[0]?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("");
  });
});
