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

const defaultJavaBinDirs = [
  "/opt/homebrew/opt/openjdk/bin",
  "/opt/homebrew/opt/openjdk@25/bin",
  "/opt/homebrew/opt/openjdk@21/bin",
];

function withFunctionsRuntime(functions: unknown): unknown {
  if (functions && typeof functions === "object" && !Array.isArray(functions)) {
    return { ...functions, runtime: "nodejs24" };
  }
  return functions;
}

export function writeFirebaseEmulatorConfig(repoRoot: string, ports: FirebasePortInput): string {
  const path = buildFirebaseEmulatorConfigPath(repoRoot, ports.KANNA_FIREBASE_FIRESTORE_PORT);
  writeJsonFile(path, buildFirebaseEmulatorConfig(ports, readJsonFile(join(repoRoot, "firebase.json")) as FirebaseConfig));
  return path;
}

export function buildFirebaseEmulatorConfigPath(repoRoot: string, firestorePort: number): string {
  return join(repoRoot, `.firebase-${firestorePort}.kanna.json`);
}

export function buildFirebaseEmulatorConfig(
  ports: FirebasePortInput,
  source: FirebaseConfig = {
    firestore: {
      rules: "firestore.rules",
    },
    functions: {
      source: "services/firebase-functions",
    },
  } as FirebaseConfig
): Record<string, unknown> {
  return {
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
}

export function buildFirebaseEmulatorArgs(configPath: string, extraArgs: string[]): string[] {
  return ["exec", "firebase", "emulators:start", "--project", "kanna-local", "--config", configPath, ...extraArgs];
}

export function buildFirebaseEmulatorCommand(configPath: string): { command: string; args: string[] } {
  return {
    command: "pnpm",
    args: buildFirebaseEmulatorArgs(configPath, [])
  };
}

export function buildFirebaseCommandEnv(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  javaBinDirs: string[] = defaultJavaBinDirs
): NodeJS.ProcessEnv {
  const repoNodeModules = join(repoRoot, "node_modules");
  const pathEntries = [
    ...javaBinDirs,
    ...(env.PATH ? env.PATH.split(":") : [])
  ].filter((entry, index, entries) => entry && entries.indexOf(entry) === index);
  return {
    ...env,
    NODE_PATH: env.NODE_PATH ? `${repoNodeModules}:${env.NODE_PATH}` : repoNodeModules,
    PATH: pathEntries.join(":")
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
  return port as number;
}

export function formatMissingFirebaseEmulators(
  reference: string,
  statuses: Pick<PortStatus, "name" | "port" | "listening" | "pids">[]
): string | null {
  const missing = statuses
    .filter((status) => !status.listening)
    .map((status) => `${status.name}:${status.port}`);
  if (missing.length === 0) return null;
  return `Firebase emulator ports from ${reference} are not listening: ${missing.join(", ")}`;
}
