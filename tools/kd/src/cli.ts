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

function normalizeHelpTopic(args: string[]): string | undefined {
  if (!args.includes("--help") && !args.includes("-h")) {
    return undefined;
  }
  return args.filter((arg) => arg !== "--help" && arg !== "-h").join(" ");
}

export function parseCliArgs(args: string[]): ParsedCliCommand {
  const helpTopic = normalizeHelpTopic(args);
  if (helpTopic !== undefined) {
    return { taskId: "help", input: { topic: helpTopic } };
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

const helpTopics: Record<string, string[]> = {
  "": [
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
    "  doctor [--remote] [--staging]",
    "",
    "Run 'kd <command> --help' for command-specific help."
  ],
  dev: [
    "Usage: kd dev <command>",
    "",
    "Commands:",
    "  dev up [options]",
    "  dev down [--kill-daemon]",
    "  dev restart [desktop|mobile|backend] [options]",
    "  dev status",
    "  dev log [window]",
    "  dev seed [options]"
  ],
  "dev up": [
    "Usage: kd dev up [--mobile] [--emulators] [--seed] [--attach] [--db <path-or-name>] [--delete-db] [--firebase-env-from <task-or-path>]",
    "Usage: kd dev up --remote",
    "",
    "Start the Kanna dev environment.",
    "",
    "Options:",
    "  --mobile, -m                       Start desktop and mobile.",
    "  --emulators, -e                    Start Firebase emulators.",
    "  --remote                           Start a remote-poking dev stack.",
    "  --seed, -s                         Seed the dev database after startup.",
    "  --attach, -a                       Attach to the tmux session.",
    "  --db <path-or-name>                Override the dev database.",
    "  --daemon-dir <dir>                 Override the daemon directory.",
    "  --transfer-root <dir>              Override the task transfer root.",
    "  --delete-db                        Reset the dev database before startup.",
    "  --firebase-env-from <task-or-path> Borrow Firebase emulator ports from another env."
  ],
  "dev down": [
    "Usage: kd dev down [--kill-daemon]",
    "",
    "Stop the Kanna dev environment.",
    "",
    "Options:",
    "  --kill-daemon, -k  Kill workspace daemons after stopping tmux."
  ],
  "dev restart": [
    "Usage: kd dev restart [desktop|mobile|backend] [--staging|--production] [--with-credentials] [--mobile] [--emulators] [--seed] [--attach] [--delete-db]",
    "",
    "Restart the Kanna dev environment or one tmux component window.",
    "",
    "Components:",
    "  desktop",
    "  mobile",
    "  backend",
    "",
    "Options:",
    "  --staging              Restart against staging settings.",
    "  --production           Restart against production settings.",
    "  --with-credentials     Use local staging desktop credentials.",
    "  --mobile, -m           Include mobile when restarting the full stack.",
    "  --emulators, -e        Include Firebase emulators.",
    "  --seed, -s             Seed the dev database.",
    "  --attach, -a           Attach to the tmux session.",
    "  --delete-db            Reset the dev database before startup.",
    "  --kill-daemon, -k      Kill workspace daemons while restarting."
  ],
  "dev status": [
    "Usage: kd dev status",
    "",
    "Show Kanna dev environment status."
  ],
  "dev log": [
    "Usage: kd dev log [window]",
    "",
    "Show recent tmux output for a Kanna dev window."
  ],
  "dev seed": [
    "Usage: kd dev seed [--db <path-or-name>] [--delete-db]",
    "",
    "Seed the Kanna dev database.",
    "",
    "Options:",
    "  --db <path-or-name>  Override the dev database.",
    "  --delete-db          Reset the dev database before seeding."
  ],
  daemon: [
    "Usage: kd daemon <command>",
    "",
    "Commands:",
    "  daemon kill"
  ],
  "daemon kill": [
    "Usage: kd daemon kill",
    "",
    "Kill Kanna daemon processes for this workspace."
  ],
  mobile: [
    "Usage: kd mobile <command>",
    "",
    "Commands:",
    "  mobile up [--production|--staging] [--with-credentials]",
    "  mobile run --device [--production|--staging] [--with-credentials]",
    "  mobile doctor --device",
    "  mobile ota <command>",
    "  mobile test",
    "  mobile device-smoke"
  ],
  "mobile up": [
    "Usage: kd mobile up [--production|--staging] [--with-credentials]",
    "",
    "Start Kanna mobile against production or staging cloud.",
    "",
    "Options:",
    "  --production        Use the installed production desktop server.",
    "  --staging           Use staging cloud services.",
    "  --with-credentials  Use local staging desktop credentials."
  ],
  "mobile run": [
    "Usage: kd mobile run --device [--production|--staging] [--with-credentials]",
    "",
    "Build, install, and launch Kanna mobile on a physical iOS device.",
    "",
    "Options:",
    "  --device            Required. Target a physical iOS device.",
    "  --production        Launch against production settings.",
    "  --staging           Launch against staging settings.",
    "  --with-credentials  Use local staging desktop credentials."
  ],
  "mobile doctor": [
    "Usage: kd mobile doctor --device [--production|--staging]",
    "",
    "Check physical iOS device mobile development readiness."
  ],
  "mobile ota": [
    "Usage: kd mobile ota <command>",
    "",
    "Commands:",
    "  mobile ota publish --staging|--production [--dry-run] [--rollback-to <updateId>]",
    "  mobile ota status --staging|--production",
    "  mobile ota doctor|preflight --staging|--production",
    "  mobile ota provision-secret --staging|--production --key-path <path>"
  ],
  "mobile ota publish": [
    "Usage: kd mobile ota publish --staging|--production [--dry-run] [--rollback-to <updateId>]",
    "",
    "Publish or roll back a Kanna mobile OTA update."
  ],
  "mobile ota status": [
    "Usage: kd mobile ota status --staging|--production",
    "",
    "Show the current Kanna mobile OTA channel pointer."
  ],
  "mobile ota doctor": [
    "Usage: kd mobile ota doctor --staging|--production",
    "",
    "Run read-only preflight checks for Kanna mobile OTA cloud and relay wiring."
  ],
  "mobile ota preflight": [
    "Usage: kd mobile ota preflight --staging|--production",
    "",
    "Alias for 'kd mobile ota doctor'."
  ],
  "mobile ota provision-secret": [
    "Usage: kd mobile ota provision-secret --staging|--production --key-path <path>",
    "",
    "Provision the Kanna mobile OTA private key into cloud Secret Manager."
  ],
  "mobile test": [
    "Usage: kd mobile test",
    "",
    "Run Kanna mobile tests."
  ],
  "mobile device-smoke": [
    "Usage: kd mobile device-smoke",
    "",
    "Run Kanna mobile physical-device smoke tests."
  ],
  emulators: [
    "Usage: kd emulators <command>",
    "",
    "Commands:",
    "  emulators up",
    "  emulators down",
    "  emulators status",
    "  emulators exec -- <command...>"
  ],
  "emulators up": [
    "Usage: kd emulators up",
    "",
    "Start Firebase emulators for Kanna."
  ],
  "emulators down": [
    "Usage: kd emulators down",
    "",
    "Stop Firebase emulators for Kanna."
  ],
  "emulators status": [
    "Usage: kd emulators status",
    "",
    "Show Firebase emulator status for Kanna."
  ],
  "emulators exec": [
    "Usage: kd emulators exec -- <command...>",
    "",
    "Run a command with Firebase emulators."
  ],
  env: [
    "Usage: kd env <command>",
    "",
    "Commands:",
    "  env print",
    "  env sync"
  ],
  "env print": [
    "Usage: kd env print",
    "",
    "Print resolved Kanna development environment."
  ],
  "env sync": [
    "Usage: kd env sync",
    "",
    "Sync Kanna development environment files."
  ],
  setup: [
    "Usage: kd setup [--check]",
    "",
    "Check Kanna prerequisites and install workspace dependencies.",
    "",
    "Options:",
    "  --check  Check prerequisites without installing dependencies."
  ],
  clean: [
    "Usage: kd clean [--all] [--dry] [--shared-rust-build]",
    "",
    "Clean Kanna build artifacts."
  ],
  build: [
    "Usage: kd build <command>",
    "",
    "Commands:",
    "  build desktop",
    "  build sidecars"
  ],
  "build desktop": [
    "Usage: kd build desktop",
    "",
    "Build the Kanna desktop app through the workspace build graph."
  ],
  "build sidecars": [
    "Usage: kd build sidecars",
    "",
    "Build Kanna desktop sidecars."
  ],
  release: [
    "Usage: kd release <command>",
    "",
    "Commands:",
    "  release ship [--staging|--production] [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64]"
  ],
  "release ship": [
    "Usage: kd release ship [--staging|--production] [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64]",
    "",
    "Build, sign, notarize, and optionally publish a Kanna release."
  ],
  cloud: [
    "Usage: kd cloud <command>",
    "",
    "Commands:",
    "  cloud deploy --staging|--production [--relay]",
    "  cloud relay-provision --staging|--production"
  ],
  "cloud deploy": [
    "Usage: kd cloud deploy --staging|--production [--relay]",
    "",
    "Deploy Kanna Firebase cloud services."
  ],
  "cloud relay-provision": [
    "Usage: kd cloud relay-provision --staging|--production",
    "",
    "Build the relay VM provisioning command plan."
  ],
  pages: [
    "Usage: kd pages <command>",
    "",
    "Commands:",
    "  pages build-schema --out-dir <dir>"
  ],
  "pages build-schema": [
    "Usage: kd pages build-schema --out-dir <dir>",
    "",
    "Build the static config-schema Pages artifact."
  ],
  test: [
    "Usage: kd test <command>",
    "",
    "Commands:",
    "  test app-update-bundle",
    "  test cloud-emulator",
    "  test cloud-staging",
    "  test cloud-prod-smoke",
    "  test lan-lab --hosts <path>",
    "  test remote-e2e [--dev|--staging]"
  ],
  "test app-update-bundle": [
    "Usage: kd test app-update-bundle",
    "",
    "Run the full-bundle app update E2E test."
  ],
  "test cloud-emulator": [
    "Usage: kd test cloud-emulator",
    "",
    "Run cloud sync E2E against Firebase emulators."
  ],
  "test cloud-staging": [
    "Usage: kd test cloud-staging",
    "",
    "Run cloud sync E2E against staging cloud services."
  ],
  "test cloud-prod-smoke": [
    "Usage: kd test cloud-prod-smoke",
    "",
    "Run minimal cloud smoke against production cloud services."
  ],
  "test lan-lab": [
    "Usage: kd test lan-lab --hosts <path>",
    "",
    "Run LAN sync tests against physical Macs over SSH."
  ],
  "test remote-e2e": [
    "Usage: kd test remote-e2e [--dev|--staging]",
    "",
    "Run remote task interaction E2E tests."
  ],
  doctor: [
    "Usage: kd doctor [--remote] [--staging]",
    "",
    "Check Kanna development prerequisites.",
    "",
    "Options:",
    "  --remote   Check remote task E2E prerequisites.",
    "  --staging  Use staging for remote checks."
  ],
  start: [
    "Usage: kd start [dev-up-options]",
    "",
    "Legacy alias for 'kd dev up'."
  ],
  restart: [
    "Usage: kd restart [desktop|mobile|backend] [dev-restart-options]",
    "",
    "Legacy alias for 'kd dev restart'."
  ],
  stop: [
    "Usage: kd stop [--kill-daemon]",
    "",
    "Legacy alias for 'kd dev down'."
  ],
  "kill-daemon": [
    "Usage: kd kill-daemon",
    "",
    "Legacy alias for 'kd daemon kill'."
  ],
  log: [
    "Usage: kd log [window]",
    "",
    "Legacy alias for 'kd dev log'."
  ],
  seed: [
    "Usage: kd seed [dev-seed-options]",
    "",
    "Legacy alias for 'kd dev seed'."
  ]
};

function helpText(topic = ""): string {
  const parts = topic.split(" ").filter((part) => part && !part.startsWith("-"));
  let resolvedTopic = parts.join(" ");
  while (resolvedTopic && !helpTopics[resolvedTopic]) {
    parts.pop();
    resolvedTopic = parts.join(" ");
  }
  if (topic.trim() && parts.length === 0) {
    const hasCommandToken = topic.split(" ").some((part) => part && !part.startsWith("-"));
    if (hasCommandToken) {
      throw new Error(`Unknown help topic: ${topic}`);
    }
  }
  const lines = helpTopics[resolvedTopic];
  if (!lines) {
    throw new Error(`Unknown help topic: ${topic}`);
  }
  return lines.join("\n");
}

export async function runCli(args: string[], env = process.env): Promise<number> {
  try {
    const parsed = parseCliArgs(args);
    if (parsed.taskId === "help") {
      const topic = typeof parsed.input.topic === "string" ? parsed.input.topic : "";
      console.log(helpText(topic));
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
