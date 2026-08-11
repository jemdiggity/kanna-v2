import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CommandRunner } from "./process";
import {
  UPDATER_KEYCHAIN_ACCOUNT_ENV,
  UPDATER_KEYCHAIN_PATH_ENV,
  UPDATER_KEYCHAIN_SERVICE_ENV,
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

function parseDefaultKeychainPath(output: string): string {
  const path = output.trim().replace(/^"|"$/g, "");
  if (!path || !isAbsolute(path)) {
    throw new Error("Unable to resolve the user's default file-based Keychain.");
  }
  return path;
}

/**
 * Import the updater signing key from TAURI_PRIVATE_KEY_PATH into an explicit
 * file-based Keychain, verify the stored copy can actually sign, and only then
 * record the machine-local selectors.
 *
 * The Keychain becomes the key's home: its encryption and ACL are the
 * protection, which is why kd does not also require an rsign passphrase.
 */
export async function setupUpdaterKeyCredentials(
  input: SetupUpdaterKeyInput
): Promise<{ service: string; account: string; keychainPath: string; configPath: string }> {
  const privateKeyPath = input.env.TAURI_PRIVATE_KEY_PATH?.trim();
  if (!privateKeyPath) {
    throw new Error(
      "Missing TAURI_PRIVATE_KEY_PATH. Point it at the updater private key to import before running setup-updater-key."
    );
  }
  if (!existsSync(privateKeyPath)) {
    throw new Error(`Tauri updater private key not found: ${privateKeyPath}.`);
  }
  const material = readFileSync(privateKeyPath, "utf8").trim();
  if (!material) {
    throw new Error(`Tauri updater private key is empty: ${privateKeyPath}.`);
  }

  const service = validSelector(input.service ?? DEFAULT_SERVICE, "updater key Keychain service");
  const account = validSelector(input.account ?? DEFAULT_ACCOUNT, "updater key Keychain account");
  let keychainPath = input.keychainPath?.trim();
  if (!keychainPath) {
    const defaultKeychain = await input.runner.run("security", ["default-keychain", "-d", "user"], {
      cwd: input.cwd,
      env: input.env
    });
    if (defaultKeychain.exitCode !== 0) {
      throw new Error("Unable to resolve the user's default file-based Keychain.");
    }
    keychainPath = parseDefaultKeychainPath(defaultKeychain.stdout);
  }
  const selection = resolveUpdaterKeySelection({
    [UPDATER_KEYCHAIN_SERVICE_ENV]: service,
    [UPDATER_KEYCHAIN_ACCOUNT_ENV]: account,
    [UPDATER_KEYCHAIN_PATH_ENV]: keychainPath
  });
  assertKeychainFile(selection.keychainPath);

  const stored = await input.runner.run(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      selection.service,
      "-a",
      selection.account,
      "-w",
      material,
      selection.keychainPath
    ],
    { cwd: input.cwd, env: input.env }
  );
  if (stored.exitCode !== 0) {
    throw new Error(
      "security did not store the updater signing key. No machine-local selector configuration was changed."
    );
  }

  const roundTripped = await resolveUpdaterSigningKey({
    cwd: input.cwd,
    env: {
      ...input.env,
      [UPDATER_KEYCHAIN_SERVICE_ENV]: selection.service,
      [UPDATER_KEYCHAIN_ACCOUNT_ENV]: selection.account,
      [UPDATER_KEYCHAIN_PATH_ENV]: selection.keychainPath
    },
    runner: input.runner
  });
  if (roundTripped !== material) {
    throw new Error(
      "The updater signing key read back from the Keychain does not match the source key. No machine-local selector configuration was changed."
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
