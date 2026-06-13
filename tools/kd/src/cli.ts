import { getTaskDefinition } from "./tasks/registry";

export interface ParsedCliCommand {
  taskId: string;
  input: Record<string, unknown>;
}

const booleanFlagMap: Record<string, string> = {
  "--mobile": "mobile",
  "-m": "mobile",
  "--emulators": "emulators",
  "-e": "emulators",
  "--seed": "seed",
  "-s": "seed",
  "--attach": "attach",
  "-a": "attach",
  "--delete-db": "deleteDb",
  "--kill-daemon": "killDaemon",
  "-k": "killDaemon",
  "--all": "all",
  "--dry": "dry",
  "--shared-rust-build": "sharedRustBuild",
  "--check": "check",
  "--release": "release",
  "--dry-run": "dryRun",
  "--major": "major",
  "--minor": "minor",
  "--patch": "patch",
  "--arm64": "arm64",
  "--x86_64": "x86_64",
  "--staging": "staging",
  "--production": "production",
  "--relay": "relay",
  "--device": "device"
};

const defaultDevUpInput = {
  mobile: false,
  emulators: false,
  seed: false,
  attach: false,
  deleteDb: false,
  killDaemon: false
};

function parseMobileUpInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { production: false, staging: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["production", "staging"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("mobile up only accepts --production or --staging");
  }
  if (input.production === true && input.staging === true) {
    throw new Error("mobile up accepts only one of --production or --staging");
  }
  if (input.production === true || input.staging === true) {
    return { taskId: "mobile.up", input: { production: input.production === true, staging: input.staging === true } };
  }
  return { taskId: "dev.up", input: { ...defaultDevUpInput, mobile: true } };
}

function parseMobileRunInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { device: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => key !== "device" && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("mobile run only accepts --device");
  }
  if (input.device !== true) {
    throw new Error("mobile run requires --device");
  }
  return { taskId: "mobile.run", input: { device: true } };
}

function parseFlagInput(rest: string[], defaults: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...defaults };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--db") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--db requires a value");
      }
      input.db = value;
      index += 1;
      continue;
    }
    if (arg === "--daemon-dir") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--daemon-dir requires a value");
      }
      input.daemonDir = value;
      index += 1;
      continue;
    }
    if (arg === "--transfer-root") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--transfer-root requires a value");
      }
      input.transferRoot = value;
      index += 1;
      continue;
    }
    if (arg === "--hosts") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--hosts requires a value");
      }
      input.hosts = value;
      index += 1;
      continue;
    }
    if (arg === "--firebase-env-from") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--firebase-env-from requires a value");
      }
      input.firebaseEnvFrom = value;
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--out-dir requires a value");
      }
      input.outDir = value;
      index += 1;
      continue;
    }
    if (arg === "--") {
      input.extraArgs = rest.slice(index + 1);
      break;
    }
    const flagName = booleanFlagMap[arg];
    if (!flagName) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    input[flagName] = true;
  }
  if (input.emulators === true && typeof input.firebaseEnvFrom === "string") {
    throw new Error("--emulators and --firebase-env-from cannot be used together");
  }
  return input;
}

export function parseCliArgs(args: string[]): ParsedCliCommand {
  if (args[0] === "--help" || args[0] === "-h") {
    return { taskId: "help", input: {} };
  }
  if (args.length === 0 || args[0]?.startsWith("-")) {
    return { taskId: "dev.up", input: parseFlagInput(args, defaultDevUpInput) };
  }

  const [group, command, ...rest] = args;
  const commandKey = command ? `${group} ${command}` : group;

  if (group === "dev" && command === "up") {
    return { taskId: "dev.up", input: parseFlagInput(rest, defaultDevUpInput) };
  }
  if (group === "mobile" && command === "up") {
    return parseMobileUpInput(rest);
  }
  if (group === "mobile" && command === "run") {
    return parseMobileRunInput(rest);
  }
  if (group === "mobile" && command === "doctor") {
    const parsed = parseMobileRunInput(rest);
    return { taskId: "mobile.doctor", input: parsed.input };
  }
  if (group === "dev" && command === "restart") {
    return { taskId: "dev.restart", input: parseFlagInput(rest, defaultDevUpInput) };
  }
  if (group === "dev" && command === "down") {
    return { taskId: "dev.down", input: { killDaemon: rest.includes("--kill-daemon") || rest.includes("-k") } };
  }
  if (group === "dev" && command === "status") {
    return { taskId: "dev.status", input: {} };
  }
  if (group === "dev" && command === "log") {
    return { taskId: "dev.log", input: { window: rest[0] ?? "desktop" } };
  }
  if (group === "dev" && command === "seed") {
    return { taskId: "dev.seed", input: parseFlagInput(rest, { deleteDb: false }) };
  }
  if (group === "emulators" && command === "exec") {
    const separator = rest.indexOf("--");
    return { taskId: "emulators.exec", input: { extraArgs: separator >= 0 ? rest.slice(separator + 1) : rest } };
  }
  if (group === "build" && command === "desktop") {
    return { taskId: "build.desktop", input: {} };
  }
  if (group === "build" && command === "sidecars") {
    return { taskId: "build.sidecars", input: {} };
  }
  if (group === "release" && command === "ship") {
    return { taskId: "release.ship", input: parseFlagInput(rest, {}) };
  }
  if (group === "cloud" && command === "deploy") {
    return { taskId: "cloud.deploy", input: parseFlagInput(rest, { staging: false, production: false, relay: false }) };
  }
  if (group === "cloud" && command === "relay-provision") {
    return { taskId: "cloud.relay-provision", input: parseFlagInput(rest, { staging: false, production: false }) };
  }
  if (group === "pages" && command === "build-schema") {
    return { taskId: "pages.build-schema", input: parseFlagInput(rest, {}) };
  }
  if (group === "test" && command === "app-update-bundle") {
    return { taskId: "test.app-update-bundle", input: {} };
  }
  if (group === "test" && command === "cloud-emulator") {
    return { taskId: "test.cloud-emulator", input: {} };
  }
  if (group === "test" && command === "cloud-staging") {
    return { taskId: "test.cloud-staging", input: {} };
  }
  if (group === "test" && command === "cloud-prod-smoke") {
    return { taskId: "test.cloud-prod-smoke", input: {} };
  }
  if (group === "test" && command === "lan-lab") {
    return { taskId: "test.lan-lab", input: parseFlagInput(rest, {}) };
  }
  if (group === "setup") {
    return { taskId: "setup", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), { check: false }) };
  }
  if (group === "clean") {
    return { taskId: "clean", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), { all: false, dry: false, sharedRustBuild: false }) };
  }
  if (group === "start") {
    return { taskId: "dev.up", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), defaultDevUpInput) };
  }
  if (group === "restart") {
    return { taskId: "dev.restart", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), defaultDevUpInput) };
  }
  if (group === "stop") {
    const legacyRest = [command, ...rest].filter((arg): arg is string => Boolean(arg));
    return { taskId: "dev.down", input: { killDaemon: legacyRest.includes("--kill-daemon") || legacyRest.includes("-k") } };
  }
  if (group === "kill-daemon") {
    return { taskId: "daemon.kill", input: {} };
  }
  if (group === "log") {
    return { taskId: "dev.log", input: { window: command ?? "desktop" } };
  }
  if (group === "seed") {
    return { taskId: "dev.seed", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), { deleteDb: false }) };
  }

  const aliases: Record<string, ParsedCliCommand> = {
    "mobile test": { taskId: "mobile.test", input: {} },
    "mobile device-smoke": { taskId: "mobile.device-smoke", input: {} },
    "emulators up": { taskId: "emulators.up", input: {} },
    "emulators down": { taskId: "emulators.down", input: {} },
    "emulators status": { taskId: "emulators.status", input: {} },
    "daemon kill": { taskId: "daemon.kill", input: {} },
    "env print": { taskId: "env.print", input: {} },
    "env sync": { taskId: "env.sync", input: {} },
    doctor: { taskId: "doctor", input: {} }
  };

  const alias = aliases[commandKey];
  if (alias) {
    return alias;
  }

  throw new Error(`Unknown command: ${args.join(" ")}`);
}

function helpText(): string {
  return [
    "Usage: kd <command>",
    "",
    "Commands:",
    "  dev up [--mobile] [--emulators] [--seed] [--attach] [--db <path-or-name>] [--delete-db] [--firebase-env-from <task-or-path>]",
    "  dev down [--kill-daemon]",
    "  dev restart [--mobile] [--emulators] [--seed] [--attach] [--delete-db]",
    "  dev status",
    "  dev log [window]",
    "  dev seed [--db <path-or-name>] [--delete-db]",
    "  daemon kill",
    "  mobile up [--production|--staging]",
    "  mobile run --device",
    "  mobile doctor --device",
    "  mobile test",
    "  mobile device-smoke",
    "  emulators up|down|status",
    "  emulators exec -- <command...>",
    "  env print",
    "  env sync",
    "  setup [--check]",
    "  clean [--all] [--dry] [--shared-rust-build]",
    "  build desktop",
    "  build sidecars",
    "  release ship [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64]",
    "  cloud deploy --staging|--production [--relay]",
    "  cloud relay-provision --staging|--production",
    "  pages build-schema --out-dir <dir>",
    "  test app-update-bundle",
    "  test cloud-emulator",
    "  test cloud-staging",
    "  test cloud-prod-smoke",
    "  test lan-lab --hosts <path>",
    "  doctor"
  ].join("\n");
}

export async function runCli(args: string[], env = process.env): Promise<number> {
  try {
    const parsed = parseCliArgs(args);
    if (parsed.taskId === "help") {
      console.log(helpText());
      return 0;
    }
    const task = getTaskDefinition(parsed.taskId);
    const input = task.inputSchema.parse(parsed.input);
    const result = await task.execute({ cwd: process.cwd(), env }, input);
    console.log(result.message);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}
