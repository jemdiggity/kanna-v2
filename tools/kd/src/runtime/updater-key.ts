import { createHash, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandRunner } from "./process";
import {
  UPDATER_KEYCHAIN_ACCOUNT_ENV,
  UPDATER_KEYCHAIN_PATH_ENV,
  UPDATER_KEYCHAIN_SERVICE_ENV,
  withMachineUpdaterKeySetupLock,
  writeMachineUpdaterKeySelectors
} from "./release-env";

/** Tauri's own env names for the signer. kd sets these only for the signer child process. */
export const TAURI_SIGNING_KEY_ENV = "TAURI_SIGNING_PRIVATE_KEY";
export const TAURI_SIGNING_PASSWORD_ENV = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";

const DEFAULT_SERVICE = "build.kanna.updater-key";
const DEFAULT_ACCOUNT = "tauri-updater-signing-key";

export interface UpdaterKeySelection {
  service: string;
  account: string;
  keychainPath: string;
}

interface UpdaterKeyRuntimeInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

interface SetupUpdaterKeyInput extends UpdaterKeyRuntimeInput {
  homeDir: string;
  service?: string;
  account?: string;
  keychainPath?: string;
}

function validSelector(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      `Missing ${label}. Run ./kd release setup-updater-key to store the updater signing key in a Keychain and record its selectors.`
    );
  }
  if (normalized.includes("\n") || normalized.includes("\r") || normalized.includes("\0")) {
    throw new Error(`Invalid ${label}: line breaks and NUL bytes are not allowed.`);
  }
  return normalized;
}

export function resolveUpdaterKeySelection(env: NodeJS.ProcessEnv): UpdaterKeySelection {
  const service = validSelector(env[UPDATER_KEYCHAIN_SERVICE_ENV], UPDATER_KEYCHAIN_SERVICE_ENV);
  const account = validSelector(env[UPDATER_KEYCHAIN_ACCOUNT_ENV], UPDATER_KEYCHAIN_ACCOUNT_ENV);
  const keychainPath = validSelector(env[UPDATER_KEYCHAIN_PATH_ENV], UPDATER_KEYCHAIN_PATH_ENV);
  if (!isAbsolute(keychainPath)) {
    throw new Error(
      `Invalid ${UPDATER_KEYCHAIN_PATH_ENV}: use an absolute Keychain path so every kd invocation selects the same file.`
    );
  }
  return { service, account, keychainPath };
}

function assertKeychainFile(keychainPath: string): void {
  if (!existsSync(keychainPath)) {
    throw new Error(
      `Configured updater key Keychain does not exist: ${keychainPath}. Run ./kd release setup-updater-key.`
    );
  }
  if (!statSync(keychainPath).isFile()) {
    throw new Error(`Configured updater key Keychain is not a file: ${keychainPath}.`);
  }
}

function lookupError(output: string): Error {
  if (/could not be found|SecKeychainSearchCopyNext/i.test(output)) {
    return new Error(
      "The updater signing key is not stored in the configured Keychain. Run ./kd release setup-updater-key to store it."
    );
  }
  if (/interaction.*not allowed|keychain.*locked|unable to unlock|user canceled|User interaction/i.test(output)) {
    return new Error(
      "The configured updater key Keychain is locked or denied access. Unlock it and allow kd to read the item, then retry."
    );
  }
  return new Error(
    "Unable to read the updater signing key from the configured Keychain. Check Keychain access, then retry ./kd release setup-updater-key if needed."
  );
}

/**
 * Resolve the updater signing key material.
 *
 * The Keychain is the only source. There is deliberately no key-file fallback:
 * a fallback lets a ship succeed against whatever key happens to be lying on
 * disk, which is exactly the case that should fail loudly instead. The returned
 * material is secret: pass it to the signer through the environment, never
 * through argv, a log, or disk.
 */
export async function resolveUpdaterSigningKey(input: UpdaterKeyRuntimeInput): Promise<string> {
  const selection = resolveUpdaterKeySelection(input.env);
  assertKeychainFile(selection.keychainPath);
  return readUpdaterSigningKey(input, selection);
}

async function readUpdaterSigningKey(
  input: UpdaterKeyRuntimeInput,
  selection: UpdaterKeySelection
): Promise<string> {
  const result = await input.runner.run(
    "security",
    [
      "find-generic-password",
      "-s",
      selection.service,
      "-a",
      selection.account,
      "-w",
      selection.keychainPath
    ],
    { cwd: input.cwd, env: input.env }
  );
  if (result.exitCode !== 0) {
    throw lookupError(`${result.stderr}\n${result.stdout}`);
  }
  const material = result.stdout.replace(/\r?\n$/, "").trim();
  if (!material) {
    throw new Error(
      "The updater signing key stored in the configured Keychain is empty. Re-run ./kd release setup-updater-key."
    );
  }
  return material;
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
        env: {
          ...input.env,
          [TAURI_SIGNING_KEY_ENV]: input.material,
          [TAURI_SIGNING_PASSWORD_ENV]: ""
        }
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
        "The updater private key does not match KANNA_UPDATER_PUBKEY. Refusing to store or use a key that existing installations cannot verify."
      );
    }
  } finally {
    rmSync(verificationDir, { recursive: true, force: true });
  }
}

async function storeUpdaterSigningKey(
  input: UpdaterKeyRuntimeInput,
  selection: UpdaterKeySelection
): Promise<boolean> {
  const stored = await input.runner.run(
    "security",
    [
      "add-generic-password",
      "-s",
      selection.service,
      "-a",
      selection.account,
      "-w"
    ],
    { cwd: input.cwd, env: input.env, interactive: true }
  );
  return stored.exitCode === 0;
}

async function deleteUpdaterSigningKey(
  input: UpdaterKeyRuntimeInput,
  selection: UpdaterKeySelection
): Promise<boolean> {
  const deleted = await input.runner.run(
    "security",
    [
      "delete-generic-password",
      "-s",
      selection.service,
      "-a",
      selection.account,
      selection.keychainPath
    ],
    { cwd: input.cwd, env: input.env }
  );
  return deleted.exitCode === 0;
}

async function readExistingUpdaterSigningKey(
  input: UpdaterKeyRuntimeInput,
  selection: UpdaterKeySelection
): Promise<string | undefined> {
  try {
    return await readUpdaterSigningKey(input, selection);
  } catch (error) {
    if (error instanceof Error && /not stored in the configured Keychain/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parseDefaultKeychainPath(output: string): string {
  const path = output.trim().replace(/^"|"$/g, "");
  if (!path || !isAbsolute(path)) {
    throw new Error("Unable to resolve the user's default file-based Keychain.");
  }
  return path;
}

/**
 * Delegate updater signing-key entry to the native Keychain prompt, verify the
 * stored item can sign for KANNA_UPDATER_PUBKEY, and only then record the
 * machine-local selectors.
 *
 * The Keychain becomes the key's home: its encryption and ACL are the
 * protection, which is why kd does not also require an rsign passphrase.
 */
export async function setupUpdaterKeyCredentials(
  input: SetupUpdaterKeyInput
): Promise<{ service: string; account: string; keychainPath: string; configPath: string }> {
  const publicKey = validSelector(input.env.KANNA_UPDATER_PUBKEY, "KANNA_UPDATER_PUBKEY");
  const service = validSelector(input.service ?? DEFAULT_SERVICE, "updater key Keychain service");
  const account = validSelector(input.account ?? DEFAULT_ACCOUNT, "updater key Keychain account");
  return withMachineUpdaterKeySetupLock(input.homeDir, async () => {
    const defaultKeychain = await input.runner.run("security", ["default-keychain", "-d", "user"], {
      cwd: input.cwd,
      env: input.env
    });
    if (defaultKeychain.exitCode !== 0) {
      throw new Error("Unable to resolve the user's default file-based Keychain.");
    }
    const defaultKeychainPath = parseDefaultKeychainPath(defaultKeychain.stdout);
    let keychainPath = input.keychainPath?.trim();
    if (!keychainPath) {
      keychainPath = defaultKeychainPath;
    }
    const selection = resolveUpdaterKeySelection({
      [UPDATER_KEYCHAIN_SERVICE_ENV]: service,
      [UPDATER_KEYCHAIN_ACCOUNT_ENV]: account,
      [UPDATER_KEYCHAIN_PATH_ENV]: keychainPath
    });
    assertKeychainFile(selection.keychainPath);
    const selectedStats = statSync(selection.keychainPath);
    const defaultStats = statSync(defaultKeychainPath);
    if (selectedStats.dev !== defaultStats.dev || selectedStats.ino !== defaultStats.ino) {
      throw new Error(
        "Updater key setup can securely prompt only into the user's current default file-based Keychain. Omit --keychain or make the selected Keychain the user default before retrying; kd will not change the global default."
      );
    }
    const runtimeInput = { cwd: input.cwd, env: input.env, runner: input.runner };
    const existingMaterial = await readExistingUpdaterSigningKey(runtimeInput, selection);
    if (existingMaterial !== undefined) {
      try {
        await assertUpdaterSigningKeyMatchesPublicKey({
          ...runtimeInput,
          material: existingMaterial,
          publicKey
        });
      } catch {
        throw new Error(
          "The existing updater key item does not match KANNA_UPDATER_PUBKEY. It was not overwritten; choose a fresh --service or --account to stage and validate the intended key safely."
        );
      }
      const configPath = writeMachineUpdaterKeySelectors({
        homeDir: input.homeDir,
        service: selection.service,
        account: selection.account,
        keychainPath: selection.keychainPath
      });
      return { ...selection, configPath };
    }

    let itemCreated = false;
    try {
      if (!await storeUpdaterSigningKey(runtimeInput, selection)) {
        throw new Error(
          "security did not store the updater signing key. No Keychain item or machine-local selector configuration was changed."
        );
      }
      itemCreated = true;
      const storedMaterial = await readUpdaterSigningKey(runtimeInput, selection);
      await assertUpdaterSigningKeyMatchesPublicKey({
        ...runtimeInput,
        material: storedMaterial,
        publicKey
      });

      const configPath = writeMachineUpdaterKeySelectors({
        homeDir: input.homeDir,
        service: selection.service,
        account: selection.account,
        keychainPath: selection.keychainPath
      });
      return { ...selection, configPath };
    } catch (error) {
      if (itemCreated) {
        if (!await deleteUpdaterSigningKey(runtimeInput, selection)) {
          throw new Error(
            "Updater key setup failed validation and kd could not remove the newly created Keychain item. Inspect that item before retrying; machine-local selector publication did not complete."
          );
        }
      }
      throw error;
    }
  });
}
