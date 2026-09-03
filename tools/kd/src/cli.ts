import { getTaskDefinition } from "./tasks/registry";
import {
  STAGING_DEVICE_TOKEN_ENV,
  STAGING_PASSWORD_ENV
} from "./runtime/staging-credentials";

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
  "--functions": "functions",
  "--portal": "portal",
  "--device": "device",
  "--remote": "remote",
  "--dev": "dev",
  "--with-credentials": "withCredentials",
  "--open": "open",
  "--upload": "upload",
  "--ota": "ota"
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
const CREDENTIALS_FLAG_ERROR = "--with-credentials is only supported for dev or staging desktop launch commands";

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
  if (input.withCredentials === true && input.production === true) {
    throw new Error(CREDENTIALS_FLAG_ERROR);
  }
  if (input.withCredentials === true && input.component && input.component !== "desktop") {
    throw new Error(CREDENTIALS_FLAG_ERROR);
  }
  return { taskId: "dev.restart", input };
}

function parseMobileUpInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { production: false, staging: false });
  const allowedKeys = new Set([
    "production",
    "staging",
    "withCredentials",
    "build",
    "owner",
    "cloud"
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error(
      "mobile up only accepts --build, --owner, --cloud, --production, or --staging"
    );
  }
  if (input.production === true && input.staging === true) {
    throw new Error("mobile up accepts only one of --production or --staging");
  }
  if (input.withCredentials === true && (input.production === true || input.staging === true)) {
    throw new Error(CREDENTIALS_FLAG_ERROR);
  }
  if (
    input.production === true ||
    input.staging === true ||
    typeof input.build === "string" ||
    typeof input.owner === "string" ||
    typeof input.cloud === "string"
  ) {
    return {
      taskId: "mobile.up",
      input: {
        production: input.production === true,
        staging: input.staging === true,
        ...(typeof input.build === "string" ? { build: input.build } : {}),
        ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
        ...(typeof input.cloud === "string" ? { cloud: input.cloud } : {}),
        ...(input.withCredentials === true ? { withCredentials: true } : {})
      }
    };
  }
  return {
    taskId: "dev.up",
    input: {
      ...defaultDevUpInput,
      mobile: true,
      ...(input.withCredentials === true
        ? { emulators: true, withCredentials: true }
        : {})
    }
  };
}

function parseMobileRunInput(rest: string[]): ParsedCliCommand {
  let simulator: true | string | undefined;
  const remainingArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg !== "--simulator") {
      remainingArgs.push(arg);
      continue;
    }
    if (simulator !== undefined) {
      throw new Error("mobile run accepts --simulator only once");
    }
    const value = rest[index + 1];
    if (value && !value.startsWith("--")) {
      simulator = value;
      index += 1;
    } else {
      simulator = true;
    }
  }
  const input = parseFlagInput(
    remainingArgs,
    { device: false, production: false, staging: false, install: false },
    { "--install": "install" }
  );
  if (simulator !== undefined) input.simulator = simulator;
  const unsupportedFlags = Object.entries(input)
    .filter(
      ([key, value]) =>
        ![
          "device",
          "simulator",
          "production",
          "staging",
          "withCredentials",
          "install",
          "build",
          "owner",
          "cloud"
        ].includes(key) && value === true
    )
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error(
      "mobile run only accepts --device, --simulator [<udid|name>], --production, --staging, or --install"
    );
  }
  if (input.production === true && input.staging === true) {
    throw new Error("mobile run accepts only one of --production or --staging");
  }
  if (input.device === true && input.simulator !== undefined) {
    throw new Error("mobile run accepts exactly one target: --device or --simulator [<udid|name>]");
  }
  if (input.device !== true && input.simulator === undefined) {
    throw new Error(
      "mobile run requires a target: use --simulator [<udid|name>] for an iOS Simulator or --device for a physical iPhone"
    );
  }
  if (input.simulator !== undefined && input.install === true) {
    throw new Error("mobile run --install is only supported with the physical-iPhone --device target");
  }
  if (input.withCredentials === true && (input.production === true || input.staging === true)) {
    throw new Error(CREDENTIALS_FLAG_ERROR);
  }
  return {
    taskId: "mobile.run",
    input: {
      device: input.device === true,
      ...(input.simulator !== undefined ? { simulator: input.simulator } : {}),
      production: input.production === true,
      staging: input.staging === true,
      ...(typeof input.build === "string" ? { build: input.build } : {}),
      ...(typeof input.owner === "string" ? { owner: input.owner } : {}),
      ...(typeof input.cloud === "string" ? { cloud: input.cloud } : {}),
      ...(input.install === true ? { install: true } : {}),
      ...(input.withCredentials === true ? { withCredentials: true } : {})
    }
  };
}

function parseMobileUninstallInput(rest: string[]): ParsedCliCommand {
  let confirmBundle: string | undefined;
  const remainingArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg !== "--confirm-bundle") {
      remainingArgs.push(arg);
      continue;
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error("--confirm-bundle requires a value");
    }
    confirmBundle = value;
    index += 1;
  }
  const input = parseFlagInput(
    remainingArgs,
    { device: false, production: false, staging: false, confirmProduction: false },
    { "--confirm-production": "confirmProduction" }
  );
  if (confirmBundle !== undefined) {
    input.confirmBundle = confirmBundle;
  }
  const allowedKeys = new Set([
    "device",
    "production",
    "staging",
    "confirmBundle",
    "confirmProduction"
  ]);
  const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(
      "mobile uninstall only accepts --device, exactly one of --staging or --production, --confirm-bundle, and --confirm-production"
    );
  }
  if (input.device !== true) {
    throw new Error("mobile uninstall requires --device");
  }
  if (input.production === input.staging) {
    throw new Error("mobile uninstall requires exactly one of --staging or --production");
  }
  if (typeof input.confirmBundle !== "string") {
    throw new Error("mobile uninstall requires --confirm-bundle <bundle-id>");
  }
  return {
    taskId: "mobile.uninstall",
    input: {
      device: true,
      production: input.production === true,
      staging: input.staging === true,
      confirmBundle: input.confirmBundle,
      confirmProduction: input.confirmProduction === true
    }
  };
}

function parseMobileDoctorInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(
    rest,
    { device: false, production: false, staging: false },
    { "--install": "install" }
  );
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["device", "production", "staging", "withCredentials"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("mobile doctor only accepts --device, --production, or --staging");
  }
  if (input.production === true && input.staging === true) {
    throw new Error("mobile run accepts only one of --production or --staging");
  }
  if (input.device !== true) {
    throw new Error("mobile run requires --device");
  }
  if (input.withCredentials === true) {
    throw new Error(CREDENTIALS_FLAG_ERROR);
  }
  return { taskId: "mobile.doctor", input };
}

function parseMobileQaInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, { production: false, ota: false });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) => !["production", "ota"].includes(key) && value === true)
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("mobile qa only accepts --production and --ota");
  }
  if (input.production !== true) {
    throw new Error("mobile qa requires --production");
  }
  return {
    taskId: "mobile.qa",
    input: {
      production: true,
      ota: input.ota === true
    }
  };
}

function parseMobileArchiveInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, {
    production: false,
    dryRun: false,
    upload: false,
    forceRebuild: false
  }, { "--force-rebuild": "forceRebuild" });
  const allowedKeys = new Set([
    "production",
    "dryRun",
    "upload",
    "buildNumber",
    "version",
    "outDir",
    "ref",
    "forceRebuild"
  ]);
  const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(
      "mobile archive only accepts --production, --ref, --build-number, --version, --out-dir, --upload, --force-rebuild, or --dry-run"
    );
  }
  return {
    taskId: "mobile.archive",
    input
  };
}

function parseMobilePublishInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(
    rest,
    { production: false, dryRun: false, forceRebuild: false, allowNonReleaseRef: false },
    { "--force-rebuild": "forceRebuild", "--allow-non-release-ref": "allowNonReleaseRef" }
  );
  const allowedKeys = new Set([
    "production",
    "dryRun",
    "ref",
    "buildNumber",
    "version",
    "outDir",
    "releaseType",
    "allowNonReleaseRef",
    "forceRebuild"
  ]);
  const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(
      "mobile publish only accepts --production, --ref, --build-number, --version, --out-dir, " +
        "--release-type, --allow-non-release-ref, --force-rebuild, or --dry-run"
    );
  }
  return { taskId: "mobile.publish", input };
}

function parseMobileVerifyInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, {});
  const allowedKeys = new Set(["ipa", "version", "buildNumber"]);
  const unsupportedKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error("mobile verify only accepts --ipa, --version, or --build-number");
  }
  if (typeof input.ipa !== "string") {
    throw new Error("mobile verify requires --ipa <path>");
  }
  return { taskId: "mobile.verify", input };
}

function parseRemoteE2eInput(rest: string[]): ParsedCliCommand {
  const input = parseFlagInput(rest, {
    dev: false,
    staging: false,
    mobileRelay: false,
    desktopPairing: false,
    ifChanged: false
  }, {
    "--mobile-relay": "mobileRelay",
    "--desktop-pairing": "desktopPairing",
    "--if-changed": "ifChanged"
  });
  const unsupportedFlags = Object.entries(input)
    .filter(([key, value]) =>
      !["dev", "staging", "mobileRelay", "desktopPairing", "ifChanged"].includes(key) &&
      value === true
    )
    .map(([key]) => key);
  if (unsupportedFlags.length > 0) {
    throw new Error("remote-e2e only accepts --dev, --staging, --mobile-relay, --desktop-pairing, or --if-changed");
  }
  if (input.dev === true && input.staging === true) {
    throw new Error("remote-e2e accepts only one of --dev or --staging");
  }
  if (input.ifChanged === true && input.staging === true) {
    throw new Error("remote-e2e --if-changed applies to the dev lane only");
  }
  return {
    taskId: "test.remote-e2e",
    input: {
      dev: input.staging !== true,
      staging: input.staging === true,
      mobileRelay: input.mobileRelay === true,
      desktopPairing: input.desktopPairing === true,
      ifChanged: input.ifChanged === true
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

function parseFlagInput(
  rest: string[],
  defaults: Record<string, unknown>,
  localBooleanFlagMap: Record<string, string> = {}
): Record<string, unknown> {
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
    if (arg === "--build" || arg === "--owner" || arg === "--cloud") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      input[arg.slice(2)] = value;
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
    if (arg === "--ref") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--ref requires a value");
      }
      input.ref = value;
      index += 1;
      continue;
    }
    if (arg === "--release-type") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--release-type requires a value");
      }
      input.releaseType = value;
      index += 1;
      continue;
    }
    if (arg === "--ipa") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--ipa requires a value");
      }
      input.ipa = value;
      index += 1;
      continue;
    }
    if (arg === "--build-number") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--build-number requires a value");
      }
      input.buildNumber = value;
      index += 1;
      continue;
    }
    if (arg === "--version") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--version requires a value");
      }
      input.version = value;
      index += 1;
      continue;
    }
    if (arg === "--rollback-to") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--rollback-to requires a value");
      }
      input.rollbackTo = value;
      index += 1;
      continue;
    }
    if (arg === "--branch") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--branch requires a value");
      }
      input.branch = value;
      index += 1;
      continue;
    }
    if (arg === "--to") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--to requires a value");
      }
      input.to = value;
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--reason requires a value");
      }
      input.reason = value;
      index += 1;
      continue;
    }
    if (arg === "--abandon-series") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--abandon-series requires a value");
      }
      input.abandonSeries = value;
      index += 1;
      continue;
    }
    if (arg === "--confirm-abandon") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--confirm-abandon requires a value");
      }
      input.confirmAbandon = value;
      index += 1;
      continue;
    }
    if (arg === "--override-soak") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--override-soak requires a reason value");
      }
      input.overrideSoak = value;
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
    if (arg === "--profile") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--profile requires a value");
      }
      input.profile = value;
      index += 1;
      continue;
    }
    if (arg === "--service") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--service requires a value");
      }
      input.service = value;
      index += 1;
      continue;
    }
    if (arg === "--account") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--account requires a value");
      }
      input.account = value;
      index += 1;
      continue;
    }
    if (arg === "--keychain") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--keychain requires a value");
      }
      input.keychain = value;
      index += 1;
      continue;
    }
    if (arg === "--") {
      input.extraArgs = rest.slice(index + 1);
      break;
    }
    const flagName = localBooleanFlagMap[arg] ?? booleanFlagMap[arg];
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
    throw new Error(CREDENTIALS_FLAG_ERROR);
  }
}

function validateDevUpCloudFlags(input: Record<string, unknown>): void {
  if (input.production === true) {
    throw new Error("dev up only supports --staging for cloud launch");
  }
  if (input.build !== undefined && input.build !== "dev") {
    throw new Error("dev up only supports --build dev");
  }
  if (input.owner !== undefined && input.owner !== "worktree") {
    throw new Error("dev up owns its worktree server and daemon; --owner must be worktree");
  }
}

function normalizeHelpTopic(args: string[]): string | undefined {
  const passthroughIndex = args.indexOf("--");
  const kdArgs = passthroughIndex >= 0 ? args.slice(0, passthroughIndex) : args;
  if (!kdArgs.includes("--help") && !kdArgs.includes("-h")) {
    return undefined;
  }
  return kdArgs.filter((arg) => arg !== "--help" && arg !== "-h").join(" ");
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
  if (group === "mobile" && command === "uninstall") {
    return parseMobileUninstallInput(rest);
  }
  if (group === "mobile" && command === "qa") {
    return parseMobileQaInput(rest);
  }
  if (group === "mobile" && command === "archive") {
    return parseMobileArchiveInput(rest);
  }
  if (group === "mobile" && command === "publish") {
    return parseMobilePublishInput(rest);
  }
  if (group === "mobile" && command === "verify") {
    return parseMobileVerifyInput(rest);
  }
  if (group === "mobile" && command === "doctor") {
    return parseMobileDoctorInput(rest);
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
          ref: undefined,
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
    if (subcommand === "provision") {
      return {
        taskId: "mobile.ota.provision",
        input: parseFlagInput(otaRest, { staging: false, production: false }),
      };
    }
    if (subcommand === "provision-secret") {
      return {
        taskId: "mobile.ota.provision-secret",
        input: parseFlagInput(otaRest, { staging: false, production: false }),
      };
    }
    throw new Error("mobile ota requires publish, status, doctor, preflight, provision, or provision-secret");
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
  // TEMPORARY COMPATIBILITY SHIM — remove once no branch predating the kache
  // migration is still open.
  //
  // Repo config, including `setup`, is read from the origin/main snapshot rather
  // than the task branch (RepoDefinitionSnapshot::resolve reads
  // refs/remotes/origin/<default_branch>), so a forked worktree runs main's
  // setup list against the branch's own kd. Config and code therefore cross the
  // stage boundary independently and cannot be changed atomically: `warm` is the
  // Kanache-era spelling main still invokes, and it must keep resolving here or
  // this branch cannot transition. For the same reason main's config keeps
  // saying `warm` — it is the only spelling both this kd and every older kd
  // accept — so branches cut before this change keep transitioning after it
  // merges.
  if (group === "rust-cache" && (command === "install" || command === "warm")) {
    return { taskId: "rust-cache.install", input: {} };
  }
  if (group === "rust-cache" && command === "status") {
    return { taskId: "rust-cache.status", input: {} };
  }
  if (group === "release" && command === "ship") {
    return { taskId: "release.ship", input: parseFlagInput(rest, {}) };
  }
  if (group === "release" && command === "promote") {
    const [version, ...flags] = rest;
    if (!version || version.startsWith("--")) {
      throw new Error("release promote requires a staging version, e.g. kd release promote 1.2.4-staging.3");
    }
    return { taskId: "release.promote", input: { version, ...parseFlagInput(flags, {}) } };
  }
  if (group === "release" && command === "reset-staging") {
    return { taskId: "release.reset-staging", input: parseFlagInput(rest, {}) };
  }
  if (group === "release" && command === "setup-notarization") {
    return { taskId: "release.setup-notarization", input: parseFlagInput(rest, {}) };
  }
  if (group === "release" && command === "cut") {
    return { taskId: "release.cut", input: parseFlagInput(rest, {}) };
  }
  if (group === "release" && command === "status") {
    return { taskId: "release.status", input: {} };
  }
  if (group === "cloud" && command === "deploy") {
    return {
      taskId: "cloud.deploy",
      input: parseFlagInput(rest, {
        staging: false,
        production: false,
        relay: false,
        functions: false,
        portal: false
      })
    };
  }
  if (group === "cloud" && command === "relay-provision") {
    return { taskId: "cloud.relay-provision", input: parseFlagInput(rest, { staging: false, production: false }) };
  }
  if (group === "relay" && command === "stats") {
    return {
      taskId: "relay.stats",
      input: parseFlagInput(rest, { staging: false, production: false, open: false, dryRun: false })
    };
  }
  if (group === "pages" && command === "build-schema") {
    return { taskId: "pages.build-schema", input: parseFlagInput(rest, {}) };
  }
  if (group === "test" && command === "all") {
    return { taskId: "test.all", input: {} };
  }
  if (group === "test" && command === "rust") {
    return { taskId: "test.rust", input: {} };
  }
  if (group === "test" && command === "desktop-e2e") {
    return { taskId: "test.desktop-e2e", input: {} };
  }
  if (group === "test" && command === "desktop-e2e-operator") {
    return { taskId: "test.desktop-e2e-operator", input: {} };
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
  if (group === "test" && command === "staging-smoke") {
    return { taskId: "test.staging-smoke", input: {} };
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
    "  dev up [--cloud emulators|staging] [--staging] [--with-credentials] [--mobile] [--emulators] [--seed] [--attach] [--db <path-or-name>] [--delete-db] [--firebase-env-from <task-or-path>]",
    "  dev up --remote",
    "  dev down [--kill-daemon]",
    "  dev restart [desktop|mobile|backend] [--staging|--production] [--with-credentials] [--mobile] [--emulators] [--seed] [--attach] [--delete-db]",
    "  dev status",
    "  dev log [window]",
    "  dev seed [--db <path-or-name>] [--delete-db]",
    "  daemon kill",
    "  mobile up [--build dev|staging] [--owner staging] [--cloud staging] [--production|--staging]",
    "  mobile run (--simulator [<udid|name>] | --device) [--build dev|staging] [--owner worktree|staging] [--cloud emulators|staging] [--production|--staging] [--install]",
    "  mobile uninstall --device --staging|--production --confirm-bundle <bundle-id> [--confirm-production]",
    "  mobile archive --production --ref <branch|tag|sha> --build-number <number> [--version <version>] [--out-dir <dir>] [--upload] [--dry-run]",
    "  mobile publish --production --ref release/X.Y [--build-number <number>|auto] [--release-type <type>] [--dry-run]",
    "  mobile verify --ipa <path> [--version <version>] [--build-number <number>]",
    "  mobile doctor --device",
    "  mobile qa --production [--ota]",
    "  mobile ota publish --staging|--production [--ref <branch|tag|sha>] [--dry-run] [--rollback-to <updateId>]",
    "  mobile ota status --staging|--production",
    "  mobile ota doctor|preflight --staging|--production",
    "  mobile ota provision --staging|--production",
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
    "  rust-cache install|status",
    "  release ship [--staging|--production] [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64] [--rollback-to <version>] [--branch main|release/X.Y]",
    "  release promote <staging-version> [--dry-run] [--arm64|--x86_64] [--override-soak <reason>]",
    "  release setup-notarization [--profile <name>] [--keychain <absolute-path>]",
    "  release cut [--major|--minor|--patch] [--version X.Y.0] [--abandon-series X.Y[,X.Y]] [--reason <why>]",
    "  release reset-staging --to main|release/X.Y --reason <why> --confirm-abandon <staging-version> [--dry-run]",
    "  release status",
    "  cloud deploy --staging|--production [--ref <branch|tag|sha>] [--functions] [--portal] [--relay]",
    "  cloud relay-provision --staging|--production",
    "  relay stats --staging|--production [--open] [--dry-run]",
    "  pages build-schema --out-dir <dir>",
    "  test rust",
    "  test desktop-e2e",
    "  test desktop-e2e-operator",
    "  test app-update-bundle",
    "  test cloud-emulator",
    "  test cloud-staging",
    "  test cloud-prod-smoke",
    "  test lan-lab --hosts <path>",
    "  test remote-e2e [--dev|--staging] [--mobile-relay] [--desktop-pairing] [--if-changed]",
    "  test staging-smoke",
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
    "Usage: kd dev up [--cloud emulators|staging] [--staging] [--with-credentials] [--mobile] [--emulators] [--seed] [--attach] [--db <path-or-name>] [--delete-db] [--firebase-env-from <task-or-path>]",
    "Usage: kd dev up --remote",
    "",
    "Start the Kanna dev environment.",
    "",
    "Options:",
    "  --mobile, -m                       Start desktop and mobile.",
    "  --emulators, -e                    Start Firebase emulators.",
    "  --cloud emulators|staging           Select cloud infrastructure; staging keeps the worktree server/daemon.",
    "  --staging                           Compatibility alias for --cloud staging.",
    "  --with-credentials                  Use local dev credentials, or staging credentials with --staging; local dev also starts emulators.",
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
    "  mobile up [--build dev|staging] [--owner staging] [--cloud staging] [--production|--staging]",
    "  mobile run (--simulator [<udid|name>] | --device) [--build dev|staging] [--owner worktree|staging] [--cloud emulators|staging] [--production|--staging] [--install]",
    "  mobile uninstall --device --staging|--production --confirm-bundle <bundle-id> [--confirm-production]",
    "  mobile archive --production --ref <branch|tag|sha> --build-number <number> [--version <version>] [--out-dir <dir>] [--upload] [--dry-run]",
    "  mobile doctor --device",
    "  mobile qa --production [--ota]",
    "  mobile ota <command>",
    "  mobile test",
    "  mobile device-smoke"
  ],
  "mobile up": [
    "Usage: kd mobile up [--build dev|staging] [--owner staging] [--cloud staging] [--production|--staging]",
    "",
    "Start Metro for a mobile client against an installed desktop owner.",
    "",
    "Options:",
    "  --production        Use the installed production desktop server.",
    "  --staging           Compatibility profile: staging build + installed staging owner + staging cloud.",
    "  --build <identity>  Mobile client identity: dev or staging.",
    "  --owner staging     Use the installed staging desktop server and daemon.",
    "  --cloud staging     Use staging Firebase and relay services."
  ],
  "mobile run": [
    "Usage: kd mobile run (--simulator [<udid|name>] | --device) [--build dev|staging] [--owner worktree|staging] [--cloud emulators|staging] [--production|--staging] [--install]",
    "",
    "Build, install, and launch Kanna mobile on an iOS Simulator or physical iPhone.",
    "",
    "Options:",
    "  --simulator [target] Target a simulator by optional UDID or name; defaults to a booted or newest available iPhone.",
    "  --device             Target a physical iPhone selected from KANNA_IOS_DEVICE_UDID or KANNA_IOS_PHYSICAL_DEVICE_NAME.",
    "  --production        Guarded compatibility profile for the production build, owner, and cloud.",
    "  --staging           Compatibility profile: staging build + installed staging owner + staging cloud.",
    "  --build <identity>  Client build identity (dev or staging for development).",
    "  --owner <owner>     Desktop owner: worktree or installed staging.",
    "  --cloud <target>    Cloud target: emulators or staging.",
    "  --install            Physical iPhone only: build and install a bundled Release app; skips Metro and dev-client hot loading.",
    "",
    "Marketing version defaults to apps/mobile/VERSION in every environment.",
    "KANNA_APP_VERSION is an explicit diagnostic/build override; it does not select identity, cloud, OTA, runtime, or signing settings."
  ],
  "mobile uninstall": [
    "Usage: kd mobile uninstall --device --staging|--production --confirm-bundle <bundle-id> [--confirm-production]",
    "",
    "Uninstall exactly one resolved Kanna mobile bundle from a physical iOS device.",
    "",
    "Options:",
    "  --device                       Required. Target a physical iOS device.",
    "  --staging                      Target the staging mobile identity.",
    "  --production                   Target the production mobile identity.",
    "  --confirm-bundle <bundle-id>   Required. Must exactly match the resolved environment bundle id.",
    "  --confirm-production           Additionally required before uninstalling production."
  ],
  "mobile archive": [
    "Usage: kd mobile archive --production --ref <branch|tag|sha> --build-number <number> [--version <version>] [--out-dir <dir>] [--upload] [--force-rebuild] [--dry-run]",
    "",
    "Build a production iOS archive and IPA through local Expo CNG and Xcode.",
    "After export, push an annotated archive provenance tag before any optional upload.",
    "",
    "Options:",
    "  --production              Required. Use the production Kanna mobile identity.",
    "  --ref <branch|tag|sha>    Required. Source ref to archive; must be the checked-out commit.",
    "  --build-number <number>   Required. App Store Connect build number (CFBundleVersion).",
    "  --version <version>       Marketing version (defaults to apps/mobile/VERSION).",
    "  --out-dir <dir>           Archive output directory (defaults to .build/mobile/ios-production).",
    "  --force-rebuild           Rebuild even when the artifacts already match the version and build number.",
    "  --upload                  Upload the exported IPA with xcrun altool.",
    "  --dry-run                 Print the archive/upload plan without building or uploading."
  ],
  "mobile publish": [
    "Usage: kd mobile publish --production --ref release/X.Y [--build-number <number>|auto] [--release-type <type>] [--dry-run]",
    "",
    "One staged, resumable operation for shipping an iOS build to App Store Connect:",
    "resolve the ref, pick and guard the build number, archive, verify the IPA, upload,",
    "wait for processing, attach the build, then record the publish and tag the commit.",
    "",
    "Export compliance, the release type, and submit-for-review stay human and are only printed.",
    "",
    "Options:",
    "  --production                Required. Publish the production Kanna mobile identity.",
    "  --ref <release/X.Y>         Required. Must be a release branch and the checked-out commit.",
    "  --build-number <number>     Required (or auto). Refused when App Store Connect already has it.",
    "  --build-number auto         Take the next number after the highest already uploaded.",
    "  --version <version>         Marketing version (defaults to apps/mobile/VERSION).",
    "  --out-dir <dir>             Archive output directory (defaults to .build/mobile/ios-production).",
    "  --release-type <type>       MANUAL, AFTER_APPROVAL, or SCHEDULED. Unset means untouched.",
    "  --allow-non-release-ref     Publish from a ref that is not release/X.Y. Deliberate override.",
    "  --force-rebuild             Rebuild the archive even when it already matches.",
    "  --dry-run                   Resolve everything and print the plan without building or uploading."
  ],
  "mobile verify": [
    "Usage: kd mobile verify --ipa <path> [--version <version>] [--build-number <number>]",
    "",
    "Run the pre-upload IPA checks on their own: Apple Distribution signing authority,",
    "an App Store provisioning profile, plan/IPA agreement, an opaque 1024 marketing icon,",
    "and a production embedded environment. Also prints the IPA SHA-256.",
    "",
    "Options:",
    "  --ipa <path>              Required. The IPA to check.",
    "  --version <version>       Expected marketing version (defaults to apps/mobile/VERSION).",
    "  --build-number <number>   Expected build number. Not asserted when omitted."
  ],
  "mobile doctor": [
    "Usage: kd mobile doctor --device [--build dev|staging] [--owner worktree|staging] [--cloud emulators|staging] [--production|--staging]",
    "",
    "Check physical iOS device mobile development readiness."
  ],
  "mobile qa": [
    "Usage: kd mobile qa --production [--ota]",
    "",
    "Run the repo-side production mobile QA gate for TestFlight/App Store candidates.",
    "",
    "Checks:",
    "  production config sanity",
    "  pnpm --dir apps/mobile run typecheck",
    "  pnpm --dir apps/mobile run test",
    "  pnpm --dir apps/mobile run test:e2e:preflight",
    "  pnpm --dir apps/mobile run test:e2e:smoke",
    "",
    "Options:",
    "  --production  Required. Validate the production mobile identity.",
    "  --ota         Also run production OTA status and doctor checks."
  ],
  "mobile ota": [
    "Usage: kd mobile ota <command>",
    "",
    "Commands:",
    "  mobile ota publish --staging|--production [--ref <branch|tag|sha>] [--dry-run] [--rollback-to <updateId>]",
    "  mobile ota status --staging|--production",
    "  mobile ota doctor|preflight --staging|--production",
    "  mobile ota provision --staging|--production",
    "  mobile ota provision-secret --staging|--production --key-path <path>"
  ],
  "mobile ota publish": [
    "Usage: kd mobile ota publish --staging|--production [--ref <branch|tag|sha>] [--dry-run] [--rollback-to <updateId>]",
    "",
    "Publish or roll back a Kanna mobile OTA update.",
    "",
    "Options:",
    "  --ref <branch|tag|sha>    Source ref the update is exported from. Required with",
    "                            --production. The export consumes the working tree, so the",
    "                            ref must be checked out and the tree clean. Omitted elsewhere,",
    "                            HEAD is resolved and reported. Not required for --rollback-to,",
    "                            which exports nothing.",
    "  --dry-run                 Export and stage without writing to GCS.",
    "  --rollback-to <updateId>  Repoint the channel at an already-published update."
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
  "mobile ota provision": [
    "Usage: kd mobile ota provision --staging|--production",
    "",
    "Provision the Kanna mobile OTA bucket and relay storage access."
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
  "rust-cache": [
    "Usage: kd rust-cache <command>",
    "",
    "Commands:",
    "  rust-cache install",
    "  rust-cache status",
    "",
    "`rust-cache warm` is a deprecated alias for `install`, kept while branches",
    "predating the kache migration are still open."
  ],
  "rust-cache install": [
    "Usage: kd rust-cache install",
    "",
    "Install the pinned kache compiler cache and create this repository's store."
  ],
  "rust-cache status": [
    "Usage: kd rust-cache status",
    "",
    "Show the pinned kache installation, this repository's store, and cache stats."
  ],
  release: [
    "Usage: kd release <command>",
    "",
    "Commands:",
    "  release ship [--staging|--production] [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64] [--rollback-to <version>] [--branch main|release/X.Y]",
    "  release promote <staging-version> [--dry-run] [--arm64|--x86_64] [--override-soak <reason>]",
    "  release setup-notarization [--profile <name>] [--keychain <absolute-path>]",
    "  release cut [--major|--minor|--patch] [--version X.Y.0] [--abandon-series X.Y[,X.Y]] [--reason <why>]",
    "  release reset-staging --to main|release/X.Y --reason <why> --confirm-abandon <staging-version> [--dry-run]",
    "  release status"
  ],
  "release ship": [
    "Usage: kd release ship [--staging|--production] [--dry-run] [--release] [--major|--minor|--patch] [--arm64|--x86_64] [--rollback-to <version>] [--branch main|release/X.Y]",
    "",
    "Build, sign, notarize, and optionally publish a Kanna release.",
    "A staging publish must be a descendant of the candidate the channel already serves, except for a verified and recorded forward-main resumption after promotion; a release/X.Y RC must build that branch's remote tip exactly.",
    "A bare main staging ship continues an active unpromoted main RC; otherwise it starts the next minor series from the greater of VERSION and the greatest production semantic version. Pass a bump flag to override it.",
    "Patch RCs in a production series are shipped from release/X.Y; the result reports versionFloor when stale VERSION was raised.",
    "While an unpromoted release/X.Y candidate is soaking, main staging publishes are refused; a genuine matching promotion resumes forward main automatically, while abandonment requires kd release reset-staging.",
    "Use --staging --rollback-to <version> to repoint the staging channel manifest without building."
  ],
  "release promote": [
    "Usage: kd release promote <staging-version> [--dry-run] [--arm64|--x86_64] [--override-soak <reason>]",
    "",
    "Promote a soaked staging prerelease (e.g. 1.2.4-staging.3) into the production release of the same commit.",
    "Rebuilds that exact commit with production identity, then tags, publishes, and repoints the updater manifest.",
    "Requires the checkout and the RC's resolved mechanical base (its exact release-branch tip, or main for a main RC) to still be at the staging build's commit, a valid staging lineage, and the",
    "release-policy.json soak window (default 24h) to have elapsed. --dry-run rehearses without publishing and runs the same gates.",
    "--override-soak <reason> is the explicit human override for the soak window only; it never waives lineage or base checks."
  ],
  "release reset-staging": [
    "Usage: kd release reset-staging --to main|release/X.Y --reason <why> --confirm-abandon <staging-version> [--dry-run]",
    "",
    "Abandon the active staging lineage so the next publish may move the channel non-linearly (a stale release soak or an older-series hotfix). Routine post-promotion return to main is automatic after verification.",
    "Builds nothing, publishes nothing, and leaves the channel pointer where it is: it records old/new provenance on the desktop-staging release.",
    "--confirm-abandon must name the exact active staging version (kd release status prints it), and the record authorizes only the next publish from --to."
  ],
  "release setup-notarization": [
    "Usage: kd release setup-notarization [--profile <name>] [--keychain <absolute-path>]",
    "",
    "Securely prompt for Apple notarization credentials, validate them, and store the named profile in an explicit file-based Keychain.",
    "Defaults to profile kanna-notarization and the current user's default login Keychain. Writes only the profile name and Keychain path to ~/.kanna/.env.release.local.",
    "That owner-only machine-global file is the sole release-environment file kd reads; repository and worktree .env.release.local files are ignored."
  ],
  "release cut": [
    "Usage: kd release cut [--major|--minor|--patch] [--version X.Y.0] [--abandon-series X.Y[,X.Y]] [--reason <why>]",
    "",
    "Cut a release/X.Y stabilization branch from origin/main for the next version series (default: --minor).",
    "The branch takes bugfix cherry-picks only; staging RCs shipped from it version themselves as X.Y.Z-staging.N.",
    "Bump flags infer the series from origin/main's VERSION, which only advances when a production release commits it.",
    "--version X.Y.0 names the intended series directly, which is the only way to skip a series that is being abandoned",
    "rather than released. Every unreleased release/X.Y the cut steps over must be named with --abandon-series and",
    "explained with --reason; each is recorded as an annotated abandoned/release/X.Y tag at that branch's tip.",
    "The abandoned branch is kept, never deleted or reused, and ship/promote then refuse that series."
  ],
  "release status": [
    "Usage: kd release status",
    "",
    "Show the latest production release, the staging channel pointer, its release branch (if cut), and lag vs origin/main.",
    "Separates mechanical promotability (the RC still matches its promotion branch tip) from safety state: the candidate's",
    "lineage relationship to the previous candidate, whether it is valid or promotion-authorized, soak age against the policy window,",
    "any active release-branch freeze, release-branch commits not retained on main, and every blocker to production promotion.",
    "Prints the promote command only when all of those gates pass."
  ],
  cloud: [
    "Usage: kd cloud <command>",
    "",
    "Commands:",
    "  cloud deploy --staging|--production [--ref <branch|tag|sha>] [--functions] [--portal] [--relay]",
    "  cloud relay-provision --staging|--production"
  ],
  "cloud deploy": [
    "Usage: kd cloud deploy --staging|--production [--ref <branch|tag|sha>] [--functions] [--portal] [--relay]",
    "",
    "Deploy Kanna Firebase cloud services.",
    "",
    "  --ref <branch|tag|sha>  Source ref the deploy builds from. Required with --production.",
    "                          The build consumes the working tree, so the ref must be checked",
    "                          out and the tree clean.",
    "  --functions             Build and deploy services/firebase-functions. Off by default so",
    "                          reviving function deployment stays deliberate.",
    "  --portal                Build and deploy the web account portal.",
    "  --relay                 Build and deploy only the relay VM image unless combined with",
    "                          another explicit target. With no target flag, deploy Firestore",
    "                          rules, indexes, and the account portal."
  ],
  "cloud relay-provision": [
    "Usage: kd cloud relay-provision --staging|--production",
    "",
    "Build the relay VM provisioning command plan."
  ],
  relay: [
    "Usage: kd relay <command>",
    "",
    "Commands:",
    "  relay stats --staging|--production [--open] [--dry-run]"
  ],
  "relay stats": [
    "Usage: kd relay stats --staging|--production [--open] [--dry-run]",
    "",
    "Read the relay's status surface with the operator token, instead of ssh-ing to the VM.",
    "The token comes from KANNA_RELAY_STATS_TOKEN when this shell sets it, otherwise from the",
    "kanna-relay-stats-token Secret Manager secret in the environment's project.",
    "",
    "  --open      Open the live status dashboard in a browser instead of printing the JSON.",
    "              The URL carries the token, so treat the printed line as a credential.",
    "  --dry-run   Print the resolved URLs and token source without reading the secret."
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
    "Build the static config-schema Pages artifact.",
    "",
    "This is the build step of .github/workflows/config-schema-pages.yml, which deploys the",
    "artifact to https://schemas.kanna.build/config.schema.json on pushes to main. There is no",
    "kd publish command: the repository's Pages source is \"GitHub Actions\", so publishing runs",
    "in CI. To publish out of band, re-run that workflow (`gh workflow run config-schema-pages.yml`)."
  ],
  test: [
    "Usage: kd test <command>",
    "",
    "Commands:",
    "  test all",
    "  test rust",
    "  test desktop-e2e",
    "  test desktop-e2e-operator",
    "  test app-update-bundle",
    "  test cloud-emulator",
    "  test cloud-staging",
    "  test cloud-prod-smoke",
    "  test lan-lab --hosts <path>",
    "  test remote-e2e [--dev|--staging] [--mobile-relay] [--desktop-pairing] [--if-changed]",
    "  test staging-smoke"
  ],
  "test all": [
    "Usage: kd test all",
    "",
    "Run all canonical local verification lanes."
  ],
  "test rust": [
    "Usage: kd test rust",
    "",
    "Run workspace Rust tests with daemon integration tests serialized."
  ],
  "test desktop-e2e": [
    "Usage: kd test desktop-e2e",
    "",
    "Run the unattended desktop real E2E tier.",
  ],
  "test desktop-e2e-operator": [
    "Usage: kd test desktop-e2e-operator",
    "",
    "Run credentialed and operator-only desktop real E2E files.",
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
    "Usage: kd test remote-e2e [--dev|--staging] [--mobile-relay] [--desktop-pairing] [--if-changed]",
    "",
    "Run remote task interaction E2E tests.",
    "",
    "  --mobile-relay     Run Layer C mobile Appium over relay.",
    "  --desktop-pairing  Run Layer D desktop pairing UI WebDriver test.",
    "  --if-changed       Run the dev lane only when this branch changes a remote",
    "                     E2E surface (relay, kanna-server, firebase-functions,",
    "                     mobile lib, tests/remote-e2e, kd), measured against the",
    "                     merge-base with the default branch. Otherwise exits 0",
    "                     without starting emulators or tests."
  ],
  "test staging-smoke": [
    "Usage: kd test staging-smoke",
    "",
    "Run the staging health smoke: 'kd doctor --remote --staging', then",
    "'kd test remote-e2e --staging', failing fast on the first broken step.",
    "",
    `Needs the staging Buffy credentials (${STAGING_DEVICE_TOKEN_ENV} and`,
    `${STAGING_PASSWORD_ENV}) in the environment; without them it exits 0`,
    "with the staging suite's SKIP message instead of failing."
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
    if (typeof input === "object" && input !== null) {
      const acceptedKeys = input as Record<string, unknown>;
      const unsupportedKey = Object.keys(parsed.input).find((key) => !(key in acceptedKeys));
      if (unsupportedKey) {
        const flag = unsupportedKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        throw new Error(`Unknown flag for ${task.id}: --${flag}`);
      }
    }
    const result = await task.execute({ cwd: process.cwd(), env }, input);
    if (!result.ok) {
      throw new Error(result.message);
    }
    console.log(result.message);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}
