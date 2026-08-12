import { createHash, generateKeyPairSync, sign as signDigest } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/runtime/process";
import { shipRelease } from "../src/runtime/release";
import {
  assertUpdaterSigningKeyMatchesPublicKey,
  preflightUpdaterSigningKey,
  resolveUpdaterSigningKey,
  updaterSignerEnvironment
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

async function privateKeyFixture(
  contents = "secret updater key\n",
  mode = 0o600
): Promise<{ root: string; keyPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-"));
  const keyPath = join(root, "updater-private.key");
  await writeFile(keyPath, contents, { mode });
  await chmod(keyPath, mode);
  return { root, keyPath };
}

describe("updater private key file", () => {
  it.each([0o400, 0o600])("reads an owner-only regular file with mode %s", async (mode) => {
    const { keyPath } = await privateKeyFixture("secret updater key\n", mode);

    await expect(resolveUpdaterSigningKey({
      env: { TAURI_PRIVATE_KEY_PATH: keyPath }
    })).resolves.toBe("secret updater key");
  });

  it("requires TAURI_PRIVATE_KEY_PATH to be present and absolute", async () => {
    await expect(resolveUpdaterSigningKey({ env: {} }))
      .rejects.toThrow(/Missing TAURI_PRIVATE_KEY_PATH/);
    await expect(resolveUpdaterSigningKey({
      env: { TAURI_PRIVATE_KEY_PATH: "relative/updater.key" }
    })).rejects.toThrow(/absolute path/);
  });

  it("rejects a missing path and a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-key-"));
    await expect(resolveUpdaterSigningKey({
      env: { TAURI_PRIVATE_KEY_PATH: join(root, "missing.key") }
    })).rejects.toThrow(/not found/);
    await expect(resolveUpdaterSigningKey({
      env: { TAURI_PRIVATE_KEY_PATH: root }
    })).rejects.toThrow(/regular file/);
  });

  it("rejects a symlink without reading its owner-only target", async () => {
    const { root, keyPath } = await privateKeyFixture();
    const linkPath = join(root, "updater-private-link.key");
    await symlink(keyPath, linkPath);

    await expect(resolveUpdaterSigningKey({
      env: { TAURI_PRIVATE_KEY_PATH: linkPath }
    })).rejects.toThrow(/must not be a symbolic link/);
  });

  it.each([0o000, 0o200, 0o700, 0o640, 0o604])(
    "rejects unsafe or unreadable mode %s",
    async (mode) => {
      const { keyPath } = await privateKeyFixture("secret updater key\n", mode);

      await expect(resolveUpdaterSigningKey({
        env: { TAURI_PRIVATE_KEY_PATH: keyPath }
      })).rejects.toThrow(/not readable|owner-only read permissions \(0400 or 0600\)/);
    }
  );

  it.skipIf(typeof process.getuid !== "function" || process.getuid() === 0)(
    "rejects a real regular file owned by another user",
    async () => {
      await expect(resolveUpdaterSigningKey({
        env: { TAURI_PRIVATE_KEY_PATH: "/etc/hosts" }
      })).rejects.toThrow(/owned by the current user/);
    }
  );

  it("rejects an empty key file", async () => {
    const { keyPath } = await privateKeyFixture("\n");

    await expect(resolveUpdaterSigningKey({
      env: { TAURI_PRIVATE_KEY_PATH: keyPath }
    })).rejects.toThrow(/private key is empty/);
  });
});

describe("updater signing key compatibility", () => {
  it("passes material only through the signer child environment", async () => {
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
      env: {
        TAURI_PRIVATE_KEY_PASSWORD: "ambient password",
        TAURI_SIGNING_PRIVATE_KEY: "ambient key",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ambient signing password"
      },
      runner,
      material: "secret updater key",
      publicKey: testUpdaterPublicKey()
    })).resolves.toBeUndefined();

    expect(calls[0]?.args).not.toContain("secret updater key");
    expect(calls[0]?.args).not.toContain("ambient password");
    expect(calls[0]?.env?.TAURI_PRIVATE_KEY_PASSWORD).toBeUndefined();
    expect(calls[0]?.env?.TAURI_SIGNING_PRIVATE_KEY).toBe("secret updater key");
    expect(calls[0]?.env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe("");
  });

  it("fails a wrong-public-key preflight without exposing private material", async () => {
    const { root, keyPath } = await privateKeyFixture();
    const runner: CommandRunner = {
      async run(_command, args) {
        const challengePath = args.at(-1);
        if (!challengePath) throw new Error("missing challenge path");
        await writeTestSignature(challengePath);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const otherKeyPair = generateKeyPairSync("ed25519");

    let message = "";
    try {
      await preflightUpdaterSigningKey({
        cwd: root,
        env: {
          KANNA_UPDATER_PUBKEY: testUpdaterPublicKey(otherKeyPair.publicKey),
          TAURI_PRIVATE_KEY_PATH: keyPath
        },
        runner,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/does not match KANNA_UPDATER_PUBKEY/);
    expect(message).not.toContain("secret updater key");
  });

  it("sanitizes ambient signing secrets for bundle signer children", () => {
    const env = updaterSignerEnvironment({
      PATH: "/usr/bin",
      TAURI_PRIVATE_KEY_PASSWORD: "ambient password",
      TAURI_SIGNING_PRIVATE_KEY: "ambient key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "ambient signing password"
    }, "validated key");

    expect(env).toEqual({
      PATH: "/usr/bin",
      TAURI_SIGNING_PRIVATE_KEY: "validated key",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""
    });
  });
});

describe("release updater preflight wiring", () => {
  async function releaseFixture(): Promise<{
    root: string;
    repoRoot: string;
    keyPath: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "kanna-updater-preflight-"));
    const repoRoot = join(root, "repo");
    const tauriDir = join(repoRoot, "apps", "desktop", "src-tauri");
    const keyPath = join(root, "updater-private.key");
    await mkdir(tauriDir, { recursive: true });
    await writeFile(join(repoRoot, "VERSION"), "1.2.3\n");
    await writeFile(join(tauriDir, "tauri.conf.json"), '{"version":"1.2.3"}\n');
    await writeFile(join(tauriDir, "Cargo.toml"), 'version = "1.2.3"\n');
    await writeFile(keyPath, "secret updater key\n", { mode: 0o600 });
    await chmod(keyPath, 0o600);
    return { root, repoRoot, keyPath };
  }

  it("stops an unsafe file before any release command or version mutation", async () => {
    const { repoRoot, keyPath } = await releaseFixture();
    await chmod(keyPath, 0o644);
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command) {
        calls.push(command);
        return { exitCode: 1, stdout: "", stderr: "must not run" };
      }
    };

    await expect(shipRelease({
      repoRoot,
      bump: "patch",
      archLabels: ["arm64"],
      release: false,
      dryRun: true,
      env: {
        KANNA_UPDATER_PUBKEY: testUpdaterPublicKey(),
        TAURI_PRIVATE_KEY_PATH: keyPath
      },
      runner
    })).rejects.toThrow(/owner-only read permissions/);

    expect(calls).toEqual([]);
    expect(await readFile(join(repoRoot, "VERSION"), "utf8")).toBe("1.2.3\n");
  });

  it("stops a wrong public key before git, Bazel, bundling, or version mutation", async () => {
    const { repoRoot, keyPath } = await releaseFixture();
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(command);
        if (command !== "pnpm") {
          return { exitCode: 1, stdout: "", stderr: "must not run" };
        }
        const challengePath = args.at(-1);
        if (!challengePath) throw new Error("missing challenge path");
        await writeTestSignature(challengePath);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const otherKeyPair = generateKeyPairSync("ed25519");

    await expect(shipRelease({
      repoRoot,
      bump: "patch",
      archLabels: ["arm64"],
      release: false,
      dryRun: true,
      env: {
        KANNA_UPDATER_PUBKEY: testUpdaterPublicKey(otherKeyPair.publicKey),
        TAURI_PRIVATE_KEY_PATH: keyPath
      },
      runner
    })).rejects.toThrow(/does not match KANNA_UPDATER_PUBKEY/);

    expect(calls).toEqual(["pnpm"]);
    expect(await readFile(join(repoRoot, "VERSION"), "utf8")).toBe("1.2.3\n");
  });
});
