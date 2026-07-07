import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveKdEnvironment } from "./environment";
import type { CommandRunner } from "./process";

export interface MobileQaCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MobileQaCommand {
  name: string;
  command: string;
  args: string[];
}

export interface MobileQaCommandResult extends MobileQaCommand {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MobileQaResult {
  configChecks: MobileQaCheck[];
  commands: MobileQaCommandResult[];
}

type JsonRecord = Record<string, unknown>;

export function buildProductionMobileQaCommands(repoRoot: string): MobileQaCommand[] {
  const mobileRoot = join(repoRoot, "apps", "mobile");
  return [
    {
      name: "typecheck",
      command: "pnpm",
      args: ["--dir", mobileRoot, "run", "typecheck"]
    },
    {
      name: "unit",
      command: "pnpm",
      args: ["--dir", mobileRoot, "run", "test"]
    },
    {
      name: "simulator-preflight",
      command: "pnpm",
      args: ["--dir", mobileRoot, "run", "test:e2e:preflight"]
    },
    {
      name: "simulator-smoke",
      command: "pnpm",
      args: ["--dir", mobileRoot, "run", "test:e2e:smoke"]
    }
  ];
}

export async function executeProductionMobileQa(input: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
}): Promise<MobileQaResult> {
  const configPath = join(input.repoRoot, "apps", "mobile", "src", "mobileEnvironments.json");
  const configChecks = validateProductionMobileConfig(JSON.parse(await readFile(configPath, "utf8")));
  const commands: MobileQaCommandResult[] = [];

  if (configChecks.some((check) => !check.ok)) {
    return { configChecks, commands };
  }

  const commandEnv = {
    ...input.env,
    KANNA_APP_ENV: "prod",
    KANNA_E2E_DESKTOP_SERVER_URL: input.env.KANNA_E2E_DESKTOP_SERVER_URL ?? "http://127.0.0.1:48120"
  };
  for (const command of buildProductionMobileQaCommands(input.repoRoot)) {
    const result = await input.runner.run(command.command, command.args, {
      cwd: input.repoRoot,
      env: commandEnv,
      streamOutput: true
    });
    commands.push({
      ...command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    });
    if (result.exitCode !== 0) {
      break;
    }
  }

  return { configChecks, commands };
}

export function validateProductionMobileConfig(environments: unknown): MobileQaCheck[] {
  const identity = resolveKdEnvironment("prod");
  const root = asRecord(environments);
  const prod = asRecord(root.prod);
  const firebase = asRecord(prod.firebase);

  return [
    expectString("displayName", prod.displayName, "Kanna"),
    expectString("scheme", prod.scheme, "kanna"),
    expectString("iosBundleId", prod.iosBundleId, identity.iosBundleId),
    expectString("iosGoogleServicesFile", prod.iosGoogleServicesFile, "./firebase/GoogleService-Info.production.plist"),
    expectNonEmpty("runtimeVersion", prod.runtimeVersion),
    expectString("firebase.projectId", firebase.projectId, identity.firebaseProjectId),
    expectString("firebase.storageBucket", firebase.storageBucket, identity.otaBucket ?? ""),
    expectProductionSecretLike("firebase.apiKey", firebase.apiKey),
    expectNonEmpty("firebase.appId", firebase.appId),
    expectString("relayUrl", prod.relayUrl, identity.relayUrl),
    expectString("otaChannel", prod.otaChannel, identity.otaChannel ?? "")
  ];
}

export function formatProductionMobileQaResult(result: MobileQaResult): string {
  const configLines = result.configChecks.map((check) =>
    `${check.ok ? "PASS" : "FAIL"} config:${check.name} ${check.detail}`
  );
  const commandLines = result.commands.map((command) =>
    `${command.exitCode === 0 ? "PASS" : "FAIL"} ${command.name}: ${command.command} ${command.args.join(" ")}`
  );
  const skippedCommands =
    result.configChecks.some((check) => !check.ok) && result.commands.length === 0
      ? ["SKIP automated commands: production mobile config sanity failed"]
      : [];
  return [
    "Production mobile QA gate",
    ...configLines,
    ...skippedCommands,
    ...commandLines,
    "",
    "Manual-only: install the TestFlight/App Store candidate on a physical iPhone, verify Local Network permission, sign in, connect to production desktop/relay, open a task, stream terminal output, send input, and confirm OTA update behavior when an OTA is expected."
  ].join("\n");
}

export function isProductionMobileQaOk(result: MobileQaResult): boolean {
  return result.configChecks.every((check) => check.ok) &&
    result.commands.length === buildProductionMobileQaCommands("").length &&
    result.commands.every((command) => command.exitCode === 0);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function expectString(name: string, actual: unknown, expected: string): MobileQaCheck {
  const actualString = typeof actual === "string" ? actual.trim() : "";
  return {
    name,
    ok: actualString === expected,
    detail: actualString === expected ? actualString : `expected ${expected}, got ${actualString || "<missing>"}`
  };
}

function expectNonEmpty(name: string, actual: unknown): MobileQaCheck {
  const actualString = typeof actual === "string" ? actual.trim() : "";
  return {
    name,
    ok: actualString.length > 0,
    detail: actualString.length > 0 ? actualString : "missing"
  };
}

function expectProductionSecretLike(name: string, actual: unknown): MobileQaCheck {
  const actualString = typeof actual === "string" ? actual.trim() : "";
  const ok = actualString.length > 0 && actualString !== "kanna-local";
  return {
    name,
    ok,
    detail: ok ? "set" : `expected production Firebase apiKey, got ${actualString || "<missing>"}`
  };
}
