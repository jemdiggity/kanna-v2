import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./files";
import type { PortStatus } from "./port-status";

export interface FirebasePortInput {
  KANNA_FIREBASE_AUTH_PORT: number;
  KANNA_FIREBASE_FIRESTORE_PORT: number;
  KANNA_FIREBASE_FUNCTIONS_PORT: number;
  KANNA_FIREBASE_UI_PORT: number;
}

interface FirebaseConfig {
  functions?: unknown;
  emulators?: Record<string, unknown>;
}

function withFunctionsRuntime(functions: unknown): unknown {
  if (functions && typeof functions === "object" && !Array.isArray(functions)) {
    return { ...functions, runtime: "nodejs24" };
  }
  return functions;
}

export function writeFirebaseEmulatorConfig(repoRoot: string, ports: FirebasePortInput): string {
  const source = readJsonFile(join(repoRoot, "firebase.json")) as FirebaseConfig;
  const generated = {
    ...source,
    functions: withFunctionsRuntime(source.functions),
    emulators: {
      ...(source.emulators ?? {}),
      auth: { host: "0.0.0.0", port: ports.KANNA_FIREBASE_AUTH_PORT },
      firestore: { host: "0.0.0.0", port: ports.KANNA_FIREBASE_FIRESTORE_PORT },
      functions: { host: "0.0.0.0", port: ports.KANNA_FIREBASE_FUNCTIONS_PORT },
      ui: { enabled: true, host: "0.0.0.0", port: ports.KANNA_FIREBASE_UI_PORT }
    }
  };
  const path = join(repoRoot, `.firebase-${ports.KANNA_FIREBASE_FIRESTORE_PORT}.kanna.json`);
  writeJsonFile(path, generated);
  return path;
}

export function buildFirebaseEmulatorArgs(configPath: string, extraArgs: string[]): string[] {
  return ["exec", "firebase", "emulators:start", "--project", "kanna-local", "--config", configPath, ...extraArgs];
}

export function buildFirebaseCommandEnv(repoRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const repoNodeModules = join(repoRoot, "node_modules");
  return {
    ...env,
    NODE_PATH: env.NODE_PATH ? `${repoNodeModules}:${env.NODE_PATH}` : repoNodeModules
  };
}

export function resolveFirebaseEnvFromReference(
  currentRepoRoot: string,
  reference: string
): Record<keyof FirebasePortInput, string> {
  const sourceRoot = resolveFirebaseEnvSourceRoot(currentRepoRoot, reference);
  const configPath = findGeneratedFirebaseConfig(sourceRoot);
  if (!configPath) {
    throw new Error(`No Firebase emulator config found for ${reference}. Start that workspace with ./kd dev up --emulators first.`);
  }

  const config = readJsonFile(configPath) as FirebaseConfig;
  const emulators = config.emulators ?? {};
  return {
    KANNA_FIREBASE_AUTH_PORT: String(readEmulatorPort(emulators, "auth", configPath)),
    KANNA_FIREBASE_FIRESTORE_PORT: String(readEmulatorPort(emulators, "firestore", configPath)),
    KANNA_FIREBASE_FUNCTIONS_PORT: String(readEmulatorPort(emulators, "functions", configPath)),
    KANNA_FIREBASE_UI_PORT: String(readEmulatorPort(emulators, "ui", configPath))
  };
}

function resolveFirebaseEnvSourceRoot(currentRepoRoot: string, reference: string): string {
  if (reference.startsWith("/")) return reference;

  const marker = "/.kanna-worktrees/";
  const markerIndex = currentRepoRoot.indexOf(marker);
  if (markerIndex >= 0) {
    return join(currentRepoRoot.slice(0, markerIndex + marker.length - 1), reference);
  }

  return join(currentRepoRoot, ".kanna-worktrees", reference);
}

function findGeneratedFirebaseConfig(sourceRoot: string): string | null {
  if (!existsSync(sourceRoot)) return null;
  const candidates = readdirSync(sourceRoot)
    .filter((name) => /^\.firebase-\d+\.kanna\.json$/.test(name))
    .sort();
  const selected = candidates.at(-1);
  return selected ? join(sourceRoot, selected) : null;
}

function readEmulatorPort(
  emulators: Record<string, unknown>,
  name: string,
  configPath: string
): number {
  const entry = emulators[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Firebase emulator config ${configPath} is missing ${name}.port`);
  }
  const port = (entry as { port?: unknown }).port;
  if (!Number.isInteger(port)) {
    throw new Error(`Firebase emulator config ${configPath} has invalid ${name}.port`);
  }
  return port;
}

export function formatMissingFirebaseEmulators(
  reference: string,
  statuses: Pick<PortStatus, "name" | "port" | "listening">[]
): string | null {
  const missing = statuses
    .filter((status) => !status.listening)
    .map((status) => `${status.name}:${status.port}`);
  if (missing.length === 0) return null;
  return `Firebase emulator ports from ${reference} are not listening: ${missing.join(", ")}`;
}
