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
  "--device": "device",
  "--remote": "remote",
  "--dev": "dev",
  "--with-credentials": "withCredentials"
};

const defaultDevUpInput = {
  mobile: false,
  emulators: false,
  seed: false,
  attach: false,
  deleteDb: false,
  killDaemon: false
};

const defaultDevRestartInput = {
  ...defaultDevUpInput,
  staging: false,
  production: false
};

const restartComponents = new Set(["desktop", "mobile", "backend"]);

function parseDevRestartInput(rest: string[]): ParsedCliCommand {
  const [first, ...remaining] = rest;
  const hasComponent = typeof first === "string" && !first.startsWith("-");
  if (hasComponent && !restartComponents.has(first)) {
    throw new Error(`Unknown restart component: ${first}`);
  }
  const input = parseFlagInput(hasComponent ? remaining : rest, defaultDevRestartInput);
  if (input.production === true && input.staging === true) {
    throw new Error("dev restart accepts only one of --production or --staging");
  }
  if (hasComponent) {
    input.component = first;
  }
  if (input.withCredentials === true && (input.component !== "desktop" || input.production === true)) {
    throw new Error("--with-credentials is only supported for dev or staging desktop launch commands");
  }
  return { taskId: "dev.restart", input };
}

function parseMobileUpInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { production: false, staging: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["production", "staging", "withCredentials"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("mobile up only accepts --production or --staging");
  }
  if (input.production === true && input.staging === true) {
    throw new Error("mobile up accepts only one of --production or --staging");
  }
  if (input.withCredentials === true && input.staging !== true) {
    throw new Error("--with-credentials is only supported for dev or staging desktop launch commands");
  }
  if (input.production === true || input.staging === true) {
    return {
      taskId: "mobile.up",
      input: {
        production: input.production === true,
        staging: input.staging === true,
        ...(input.withCredentials === true ? { withCredentials: true } : {})
      }
    };
  }
  return { taskId: "dev.up", input: { ...defaultDevUpInput, mobile: true } };
}

function parseMobileRunInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { device: false, production: false, staging: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["device", "production", "staging", "withCredentials"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("mobile run only accepts --device, --production, or --staging");
  }
  if (input.production === true && input.staging === true) {
    throw new Error("mobile run accepts only one of --production or --staging");
  }
  if (input.device !== true) {
    throw new Error("mobile run requires --device");
  }
  if (input.withCredentials === true && input.staging !== true) {
    throw new Error("--with-credentials is only supported for dev or staging desktop launch commands");
  }
  return {
    taskId: "mobile.run",
    input: {
      device: true,
      production: input.production === true,
      staging: input.staging === true,
      ...(input.withCredentials === true ? { withCredentials: true } : {})
    }
  };
}

function parseRemoteE2eInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { dev: false, staging: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["dev", "staging"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("remote-e2e only accepts --dev or --staging");
  }
  if (input.dev === true && input.staging === true) {
    throw new Error("remote-e2e accepts only one of --dev or --staging");
  }
  return {
    taskId: "test.remote-e2e",
    input: {
      dev: input.staging !== true,
      staging: input.staging === true
    }
  };
}

function parseRemoteDoctorInput(rest: string[]): ParsedCliCommand {
  const [first, ...remaining] = rest;
  if (first !== "--remote") {
    throw new Error(`Unknown doctor command: ${["doctor", ...rest].join(" ")}`);
  }
  const input = parseFlagInput(remaining, { staging: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["staging"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("doctor --remote only accepts --staging");
  }
  return {
    taskId: "doctor.remote",
    input: {
      staging: input.staging === true
    }
  };
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
    if (arg === "--rollback-to") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--rollback-to requires a value");
      }
      input.rollbackTo = value;
      index += 1;
      continue;
    }
    if (arg === "--key-path") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--key-path requires a value");
      }
      input.keyPath = value;
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
  if (input.remote === true && typeof input.firebaseEnvFrom === "string") {
    throw new Error("--remote and --firebase-env-from cannot be used together");
  }
  return input;
}

function rejectUnsupportedCredentialsFlag(input: Record<string, unknown>): void {
  if (input.withCredentials === true) {
    throw new Error("--with-credentials is only supported for dev or staging desktop launch commands");
  }
}

function validateDevUpCloudFlags(input: Record<string, unknown>): void {
  if (input.production === true) {
    throw new Error("dev up only supports --staging for cloud launch");
  }
}

export function parseCliArgs(args: string[]): ParsedCliCommand {
  if (args[0] === "--help" || args[0] === "-h") {
    return { taskId: "help", input: {} };
  }
  if (args.length === 0 || args[0]?.startsWith("-")) {
    const input = parseFlagInput(args, defaultDevUpInput);
    validateDevUpCloudFlags(input);
    return { taskId: "dev.up", input };
  }

  const [group, command, ...rest] = args;
  const commandKey = command ? `${group} ${command}` : group;

  if (group === "dev" && command === "up") {
    const input = parseFlagInput(rest, defaultDevUpInput);
    validateDevUpCloudFlags(input);
    return { taskId: "dev.up", input };
  }
  if (group === "mobile" && command === "up") {
    return parseMobileUpInput(rest);
  }
  if (group === "mobile" && command === "run") {
    return parseMobileRunInput(rest);
  }
  if (group === "mobile" && command === "doctor") {
    const parsed = parseMobileRunInput(rest);
    if (parsed.input.withCredentials === true) {
      throw new Error("--with-credentials is only supported for dev or staging desktop launch commands");
    }
    return { taskId: "mobile.doctor", input: parsed.input };
  }
  if (group === "mobile" && command === "ota") {
    const [subcommand, ...otaRest] = rest;
    if (subcommand === "publish") {
      return {
        taskId: "mobile.ota.publish",
        input: parseFlagInput(otaRest, {
          staging: false,
          production: false,
          dryRun: false,
          rollbackTo: undefined,
        }),
      };
    }
    if (subcommand === "status") {
      return {
        taskId: "mobile.ota.status",
        input: parseFlagInput(otaRest, { staging: false, production: false }),
      };
    }
    if (subcommand === "doctor" || subcommand === "preflight") {
      return {
        taskId: "mobile.ota.doctor",
        input: parseFlagInput(otaRest, { staging: false, production: false }),
      };
    }
    if (subcommand === "provision-secret") {
      return {
        taskId: "mobile.ota.provision-secret",
        input: parseFlagInput(otaRest, { staging: false, production: false }),
      };
    }
    throw new Error("mobile ota requires publish, status, doctor, preflight, or provision-secret");
  }
  if (group === "dev" && command === "restart") {
    return parseDevRestartInput(rest);
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
  if (group === "test" && command === "remote-e2e") {
    return parseRemoteE2eInput(rest);
  }
  if (group === "doctor" && command === "--remote") {
    return parseRemoteDoctorInput([command, ...rest]);
  }
  if (group === "setup") {
    return { taskId: "setup", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), { check: false }) };
  }
  if (group === "clean") {
    return { taskId: "clean", input: parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), { all: false, dry: false, sharedRustBuild: false }) };
  }
  if (group === "start" || group === "up") {
    const input = parseFlagInput([command, ...rest].filter((arg): arg is string => Boolean(arg)), defaultDevUpInput);
    validateDevUpCloudFlags(input);
    return { taskId: "dev.up", input };
  }
  if (group === "restart") {
    return parseDevRestartInput([command, ...rest].filter((arg): arg is string => Boolean(arg)));
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
    "  dev up [--staging] [--with-credentials] [--mobile] [--emulators] [--seed] [--attach] [--db <path-or-name>] [--delete-db] [--firebase-env-from <task-or-path>]",
    "  dev up --remote",
    "  dev down [--kill-daemon]",
    "  dev restart [desktop|mobile|backend] [--staging|--production] [--with-credentials] [--mobile] [--emulators] [--seed] [--attach] [--delete-db]",
    "  dev status",
    "  dev log [window]",
    "  dev seed [--db <path-or-name>] [--delete-db]",
    "  daemon kill",
    "  mobile up [--production|--staging] [--with-credentials]",
    "  mobile run --device [--production|--staging] [--with-credentials]",
    "  mobile doctor --device",
    "  mobile ota publish --staging|--production [--dry-run] [--rollback-to <updateId>]",
    "  mobile ota status --staging|--production",
    "  mobile ota doctor|preflight --staging|--production",
    "  mobile ota provision-secret --staging|--production --key-path <path>",
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
    "  release ship [--staging|--production] [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64]",
    "  cloud deploy --staging|--production [--relay]",
    "  cloud relay-provision --staging|--production",
    "  pages build-schema --out-dir <dir>",
    "  test app-update-bundle",
    "  test cloud-emulator",
    "  test cloud-staging",
    "  test cloud-prod-smoke",
    "  test lan-lab --hosts <path>",
    "  test remote-e2e [--dev|--staging]",
    "  doctor [--remote] [--staging]"
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
