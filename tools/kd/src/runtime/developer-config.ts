import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface DeveloperCredentials {
  email: string;
  password: string;
}

export const devDesktopAuth: DeveloperCredentials = {
  email: "upvote.sieve.7t@icloud.com",
  password: "password123"
};

export function resolveDeveloperConfigRoot(homeDir: string = homedir()): string {
  return join(homeDir, ".kanna", "developer");
}

export function devDesktopAuthPath(homeDir: string = homedir()): string {
  return join(resolveDeveloperConfigRoot(homeDir), "dev", "desktop-auth.toml");
}

export function stagingDesktopAuthPath(homeDir: string = homedir()): string {
  return join(resolveDeveloperConfigRoot(homeDir), "staging", "desktop-auth.toml");
}

export function parseDesktopAuth(body: string): DeveloperCredentials | null {
  let parsed: unknown;
  try {
    parsed = parseToml(body);
  } catch (error) {
    throw new Error(`desktop-auth.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const desktopAuth = (parsed as { desktop_auth?: unknown }).desktop_auth;
  if (!desktopAuth || typeof desktopAuth !== "object") return null;
  const email = (desktopAuth as { email?: unknown }).email;
  const password = (desktopAuth as { password?: unknown }).password;
  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password.trim()) {
    return null;
  }
  return { email: email.trim(), password: password.trim() };
}

export function parseStagingDesktopAuth(body: string): DeveloperCredentials | null {
  return parseDesktopAuth(body);
}

export function readDevDesktopAuth(homeDir: string = homedir()): DeveloperCredentials {
  const path = devDesktopAuthPath(homeDir);
  if (!existsSync(path)) {
    return devDesktopAuth;
  }

  const credentials = parseDesktopAuth(readFileSync(path, "utf8"));
  if (!credentials) {
    throw new Error(`${path} exists but has no [desktop_auth] email/password entries.`);
  }
  return credentials;
}

export function readStagingDesktopAuth(homeDir: string = homedir()): DeveloperCredentials {
  const path = stagingDesktopAuthPath(homeDir);
  if (!existsSync(path)) {
    throw new Error(
      `Staging desktop auth credentials not found at ${path}. ` +
        'Create it with [desktop_auth] email = "developer@example.com" and password = "not committed".'
    );
  }

  const credentials = parseStagingDesktopAuth(readFileSync(path, "utf8"));
  if (!credentials) {
    throw new Error(`${path} exists but has no [desktop_auth] email/password entries.`);
  }
  return credentials;
}
