import { createHash, randomBytes, timingSafeEqual, verify } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandRunner } from "./process";

/** Tauri's own env names for the signer. kd sets these only for signer children. */
export const TAURI_SIGNING_KEY_ENV = "TAURI_SIGNING_PRIVATE_KEY";
export const TAURI_SIGNING_PASSWORD_ENV = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";

interface UpdaterKeyRuntimeInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

function updaterPrivateKeyPath(env: NodeJS.ProcessEnv): string {
  const keyPath = env.TAURI_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) {
    throw new Error(
      "Missing TAURI_PRIVATE_KEY_PATH in the machine-global release environment."
    );
  }
  if (keyPath.includes("\n") || keyPath.includes("\r") || keyPath.includes("\0")) {
    throw new Error("Invalid TAURI_PRIVATE_KEY_PATH: line breaks and NUL bytes are not allowed.");
  }
  if (!isAbsolute(keyPath)) {
    throw new Error("Invalid TAURI_PRIVATE_KEY_PATH: use an absolute path.");
  }
  return keyPath;
}

function openUpdaterPrivateKey(keyPath: string): number {
  try {
    return openSync(
      keyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Tauri updater private key not found: ${keyPath}`);
    }
    if (code === "ELOOP") {
      throw new Error(`Tauri updater private key must not be a symbolic link: ${keyPath}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Tauri updater private key is not readable: ${keyPath}`);
    }
    throw new Error(`Unable to open the Tauri updater private key ${keyPath}: ${code ?? "unknown error"}`);
  }
}

/**
 * Read the exact updater key file selected by the machine-global release env.
 *
 * Opening with O_NOFOLLOW and validating the descriptor keeps a symlink or
 * pathname swap from redirecting release signing to a different file. The
 * returned material is secret and must only be passed to a signer child env.
 */
export async function resolveUpdaterSigningKey(
  input: Pick<UpdaterKeyRuntimeInput, "env">
): Promise<string> {
  const keyPath = updaterPrivateKeyPath(input.env);
  const descriptor = openUpdaterPrivateKey(keyPath);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`Tauri updater private key must be a regular file: ${keyPath}`);
    }
    if (typeof process.getuid !== "function") {
      throw new Error("Unable to verify ownership of the Tauri updater private key.");
    }
    if (opened.uid !== process.getuid()) {
      throw new Error(`Tauri updater private key must be owned by the current user: ${keyPath}`);
    }
    const permissions = opened.mode & 0o777;
    if (permissions !== 0o400 && permissions !== 0o600) {
      throw new Error(
        `Tauri updater private key must have owner-only read permissions (0400 or 0600), but is mode ${permissions.toString(8).padStart(4, "0")}: ${keyPath}`
      );
    }

    let material: string;
    try {
      material = readFileSync(descriptor, "utf8").trim();
    } catch {
      throw new Error(`Tauri updater private key is not readable: ${keyPath}`);
    }
    const configured = lstatSync(keyPath);
    if (
      configured.isSymbolicLink() ||
      !configured.isFile() ||
      configured.dev !== opened.dev ||
      configured.ino !== opened.ino
    ) {
      throw new Error(
        `TAURI_PRIVATE_KEY_PATH changed while the updater private key was being read: ${keyPath}`
      );
    }
    if (!material) {
      throw new Error(`Tauri updater private key is empty: ${keyPath}`);
    }
    return material;
  } finally {
    closeSync(descriptor);
  }
}

function decodeBase64(value: string, label: string): Buffer {
  const normalized = value.trim().replace(/\s/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error(`The configured updater ${label} is not valid base64.`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length === 0) {
    throw new Error(`The configured updater ${label} is empty.`);
  }
  return decoded;
}

function minisignPayload(value: string, label: string): Buffer {
  const decoded = decodeBase64(value, label).toString("utf8");
  const payload = decoded.split(/\r?\n/)[1];
  if (!payload) {
    throw new Error(`The configured updater ${label} has an invalid minisign envelope.`);
  }
  return decodeBase64(payload, label);
}

function signerEnvironment(env: NodeJS.ProcessEnv, material: string): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  // Ignore all ambient Tauri secret inputs. The validated file content and an
  // explicit empty password are the only signing inputs kd supplies.
  delete childEnv.TAURI_PRIVATE_KEY_PASSWORD;
  delete childEnv[TAURI_SIGNING_KEY_ENV];
  delete childEnv[TAURI_SIGNING_PASSWORD_ENV];
  delete childEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
  return {
    ...childEnv,
    [TAURI_SIGNING_KEY_ENV]: material,
    [TAURI_SIGNING_PASSWORD_ENV]: ""
  };
}

export function updaterSignerEnvironment(
  env: NodeJS.ProcessEnv,
  material: string
): NodeJS.ProcessEnv {
  return signerEnvironment(env, material);
}

/** Read and prove the configured updater key before a release can mutate state. */
export async function preflightUpdaterSigningKey(
  input: UpdaterKeyRuntimeInput
): Promise<string> {
  const publicKey = input.env.KANNA_UPDATER_PUBKEY?.trim();
  if (!publicKey) {
    throw new Error("Missing KANNA_UPDATER_PUBKEY in the machine-global release environment.");
  }
  const material = await resolveUpdaterSigningKey({ env: input.env });
  await assertUpdaterSigningKeyMatchesPublicKey({ ...input, material, publicKey });
  return material;
}

/** Prove a private key can create a signature accepted by KANNA_UPDATER_PUBKEY. */
export async function assertUpdaterSigningKeyMatchesPublicKey(input: UpdaterKeyRuntimeInput & {
  material: string;
  publicKey: string;
}): Promise<void> {
  const publicPayload = minisignPayload(input.publicKey, "public key");
  if (publicPayload.length !== 42 || publicPayload.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error("The configured updater public key has an unsupported minisign format.");
  }

  const verificationDir = mkdtempSync(`${tmpdir()}/kanna-updater-key-check-`);
  const challengePath = `${verificationDir}/challenge`;
  const signaturePath = `${challengePath}.sig`;
  try {
    writeFileSync(challengePath, randomBytes(32), { mode: 0o600 });
    const signer = await input.runner.run(
      "pnpm",
      ["--dir", join(input.cwd, "apps", "desktop"), "exec", "tauri", "signer", "sign", challengePath],
      {
        cwd: input.cwd,
        env: signerEnvironment(input.env, input.material)
      }
    );
    if (signer.exitCode !== 0 || !existsSync(signaturePath)) {
      throw new Error(
        "The updater private key could not sign a verification challenge. Check that it is a valid unencrypted Tauri updater key."
      );
    }
    const signaturePayload = minisignPayload(readFileSync(signaturePath, "utf8"), "signature");
    if (signaturePayload.length !== 74 || signaturePayload.subarray(0, 2).toString("ascii") !== "ED") {
      throw new Error("The updater private key produced an unsupported minisign signature.");
    }
    const publicKeyId = publicPayload.subarray(2, 10);
    const signatureKeyId = signaturePayload.subarray(2, 10);
    const publicKey = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicPayload.subarray(10)
    ]);
    const challengeDigest = createHash("blake2b512").update(readFileSync(challengePath)).digest();
    if (
      !timingSafeEqual(publicKeyId, signatureKeyId) ||
      !verify(
        null,
        challengeDigest,
        { key: publicKey, format: "der", type: "spki" },
        signaturePayload.subarray(10)
      )
    ) {
      throw new Error(
        "The updater private key does not match KANNA_UPDATER_PUBKEY. kd cannot use a key that existing installations cannot verify."
      );
    }
  } finally {
    rmSync(verificationDir, { recursive: true, force: true });
  }
}
