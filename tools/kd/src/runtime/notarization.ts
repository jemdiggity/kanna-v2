import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CommandRunner } from "./process";
import {
  NOTARIZATION_KEYCHAIN_ENV,
  NOTARIZATION_PROFILE_ENV,
  writeMachineNotarizationSelectors
} from "./release-env";

export interface NotarizationCredentialSelection {
  profile: string;
  keychainPath: string;
}

interface NotarizationRuntimeInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}

interface SetupNotarizationInput extends NotarizationRuntimeInput {
  homeDir: string;
  profile?: string;
  keychainPath?: string;
}

const DEFAULT_PROFILE = "kanna-notarization";

function validSelector(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      `Missing ${label}. Run ./kd release setup-notarization to store a machine-local profile and Keychain selector.`
    );
  }
  if (normalized.includes("\n") || normalized.includes("\r") || normalized.includes("\0")) {
    throw new Error(`Invalid ${label}: line breaks and NUL bytes are not allowed.`);
  }
  return normalized;
}

export function resolveNotarizationCredentialSelection(
  env: NodeJS.ProcessEnv
): NotarizationCredentialSelection {
  const profile = validSelector(env[NOTARIZATION_PROFILE_ENV], NOTARIZATION_PROFILE_ENV);
  const keychainPath = validSelector(env[NOTARIZATION_KEYCHAIN_ENV], NOTARIZATION_KEYCHAIN_ENV);
  if (!isAbsolute(keychainPath)) {
    throw new Error(
      `Invalid ${NOTARIZATION_KEYCHAIN_ENV}: use an absolute Keychain path so Bazel and kd select the same file.`
    );
  }
  return { profile, keychainPath };
}

function assertKeychainFile(keychainPath: string): void {
  if (!existsSync(keychainPath)) {
    throw new Error(
      `Configured notarization Keychain does not exist: ${keychainPath}. Run ./kd release setup-notarization.`
    );
  }
  if (!statSync(keychainPath).isFile()) {
    throw new Error(`Configured notarization Keychain is not a file: ${keychainPath}.`);
  }
}

function notarizationPreflightError(output: string): Error {
  if (/No Keychain password item found for profile|specified item could not be found/i.test(output)) {
    return new Error(
      "The configured notarization profile is missing from the selected Keychain. Run ./kd release setup-notarization to store it there."
    );
  }
  if (
    /interaction.*not allowed|user interaction.*not allowed|keychain.*locked|unable to unlock|passphrase.*not correct|no keychain is available|specified keychain could not be found/i.test(output)
  ) {
    return new Error(
      "The configured notarization Keychain is locked or inaccessible. Unlock the selected Keychain, then retry kd; do not pass its password in plaintext configuration."
    );
  }
  if (/invalid credentials|authentication failed|unauthorized|not authorized|status code: 401|app-specific password/i.test(output)) {
    return new Error(
      "Apple rejected the configured notarization credentials. Run ./kd release setup-notarization to replace and validate the Keychain profile."
    );
  }
  return new Error(
    "notarytool could not validate the configured profile and Keychain. Check Keychain access and Apple connectivity, then retry ./kd release setup-notarization if needed."
  );
}

export async function preflightNotarizationCredentials(
  input: NotarizationRuntimeInput
): Promise<NotarizationCredentialSelection> {
  const selection = resolveNotarizationCredentialSelection(input.env);
  assertKeychainFile(selection.keychainPath);
  const result = await input.runner.run(
    "xcrun",
    [
      "notarytool",
      "history",
      "--keychain-profile",
      selection.profile,
      "--keychain",
      selection.keychainPath,
      "--output-format",
      "json",
      "--no-progress"
    ],
    { cwd: input.cwd, env: input.env }
  );
  if (result.exitCode !== 0) {
    throw notarizationPreflightError(`${result.stderr}\n${result.stdout}`);
  }
  return selection;
}

function parseDefaultKeychainPath(output: string): string {
  const path = output.trim().replace(/^"|"$/g, "");
  if (!path || !isAbsolute(path)) {
    throw new Error("Unable to resolve the user's default file-based Keychain.");
  }
  return path;
}

export async function setupNotarizationCredentials(
  input: SetupNotarizationInput
): Promise<{ profile: string; keychainPath: string; configPath: string }> {
  const profile = validSelector(input.profile ?? DEFAULT_PROFILE, "notarization profile name");
  let keychainPath = input.keychainPath?.trim();
  if (!keychainPath) {
    const defaultKeychain = await input.runner.run(
      "security",
      ["default-keychain", "-d", "user"],
      { cwd: input.cwd, env: input.env }
    );
    if (defaultKeychain.exitCode !== 0) {
      throw new Error("Unable to resolve the user's default file-based Keychain.");
    }
    keychainPath = parseDefaultKeychainPath(defaultKeychain.stdout);
  }
  const selection = resolveNotarizationCredentialSelection({
    [NOTARIZATION_PROFILE_ENV]: profile,
    [NOTARIZATION_KEYCHAIN_ENV]: keychainPath
  });
  assertKeychainFile(selection.keychainPath);

  const stored = await input.runner.run(
    "xcrun",
    [
      "notarytool",
      "store-credentials",
      selection.profile,
      "--keychain",
      selection.keychainPath,
      "--validate"
    ],
    { cwd: input.cwd, env: input.env, interactive: true }
  );
  if (stored.exitCode !== 0) {
    throw new Error(
      "notarytool did not store the profile. No machine-local selector configuration was changed."
    );
  }

  const configPath = writeMachineNotarizationSelectors({
    homeDir: input.homeDir,
    profile: selection.profile,
    keychainPath: selection.keychainPath
  });
  return { ...selection, configPath };
}
