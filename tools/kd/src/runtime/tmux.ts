import type { DevWindow } from "./dev-plan";
import type { CommandRunner } from "./process";
import { recordInventoryResource, removeInventoryResource } from "./process-inventory";

export interface TmuxTarget {
  server: string;
  session: string;
  inventoryPath?: string;
}

function tmuxWindowEnvArgs(env: NodeJS.ProcessEnv): string[] {
  const keys = [
    "KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL",
    "KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD",
  ];
  return keys.flatMap((key) => {
    const value = env[key];
    return typeof value === "string" && value.length > 0
      ? [`${key}=${value}`]
      : [];
  });
}

function hasTmuxWindowEnv(env: NodeJS.ProcessEnv): boolean {
  return tmuxWindowEnvArgs(env).length > 0;
}

function tmuxQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runTmuxSourceCommand(
  runner: CommandRunner,
  target: TmuxTarget,
  command: string,
  env: NodeJS.ProcessEnv
) {
  return runner.run(
    "tmux",
    ["-L", target.server, "source-file", "-"],
    { env, stdin: `${command}\n` },
  );
}

function tmuxCommandLine(command: string, args: string[]): string {
  return [command, ...args.map(tmuxQuote)].join(" ");
}

async function setRemainOnExit(runner: CommandRunner, target: TmuxTarget): Promise<void> {
  await runner.run("tmux", ["-L", target.server, "set-option", "-t", target.session, "remain-on-exit", "on"]);
}

async function newTmuxWindowWithEnv(
  runner: CommandRunner,
  target: TmuxTarget,
  window: DevWindow
) {
  return runTmuxSourceCommand(
    runner,
    target,
    tmuxCommandLine("new-window", [
      "-t",
      target.session,
      "-n",
      window.name,
      "-c",
      window.cwd,
      ...tmuxWindowEnvArgs(window.env).flatMap((entry) => ["-e", entry]),
      window.command,
    ]),
    window.env,
  );
}

async function respawnTmuxWindowWithEnv(
  runner: CommandRunner,
  target: TmuxTarget,
  window: DevWindow
) {
  return runTmuxSourceCommand(
    runner,
    target,
    tmuxCommandLine("respawn-window", [
      "-k",
      "-t",
      `${target.session}:${window.name}`,
      "-c",
      window.cwd,
      ...tmuxWindowEnvArgs(window.env).flatMap((entry) => ["-e", entry]),
      window.command,
    ]),
    window.env,
  );
}

export async function hasTmuxSession(runner: CommandRunner, target: TmuxTarget): Promise<boolean> {
  const result = await runner.run("tmux", ["-L", target.server, "has-session", "-t", target.session]);
  return result.exitCode === 0;
}

export async function startTmuxSession(runner: CommandRunner, target: TmuxTarget, windows: DevWindow[]): Promise<void> {
  const [first, ...rest] = windows;
  if (!first) {
    throw new Error("Cannot start tmux session without windows");
  }

  const firstCommand = hasTmuxWindowEnv(first.env) ? "sleep 2147483647" : first.command;
  const firstResult = await runner.run(
    "tmux",
    [
      "-L", target.server,
      "new-session", "-d",
      "-s", target.session,
      "-n", first.name,
      "-c", first.cwd,
      firstCommand
    ],
    { env: first.env }
  );
  if (firstResult.exitCode !== 0) {
    if (isDuplicateSessionError(firstResult.stderr)) {
      if (target.inventoryPath) {
        recordInventoryResource(target.inventoryPath, { kind: "tmux-server", socket: target.server });
      }
      await addMissingTmuxWindows(runner, target, windows);
      return;
    }
    throw new Error(`tmux failed to start ${target.session}:${first.name}: ${firstResult.stderr}`);
  }
  if (target.inventoryPath) {
    recordInventoryResource(target.inventoryPath, { kind: "tmux-server", socket: target.server });
  }

  await setRemainOnExit(runner, target);

  if (hasTmuxWindowEnv(first.env)) {
    const respawned = await respawnTmuxWindow(runner, target, first);
    if (!respawned) {
      throw new Error(`tmux failed to start ${target.session}:${first.name}: window was not created`);
    }
  }

  for (const window of rest) {
    const result = hasTmuxWindowEnv(window.env)
      ? await newTmuxWindowWithEnv(runner, target, window)
      : await runner.run(
          "tmux",
          [
            "-L",
            target.server,
            "new-window",
            "-t",
            target.session,
            "-n",
            window.name,
            "-c",
            window.cwd,
            window.command
          ],
          { env: window.env }
        );
    if (result.exitCode !== 0) {
      throw new Error(`tmux failed to start ${target.session}:${window.name}: ${result.stderr}`);
    }
  }
}

function isDuplicateSessionError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return normalized.includes("duplicate session") || normalized.includes("session already exists");
}

async function addMissingTmuxWindows(
  runner: CommandRunner,
  target: TmuxTarget,
  windows: DevWindow[]
): Promise<void> {
  const list = await runner.run("tmux", ["-L", target.server, "list-windows", "-t", target.session, "-F", "#{window_name}"]);
  if (list.exitCode !== 0) {
    throw new Error(`tmux failed to inspect existing session ${target.session}: ${list.stderr}`);
  }
  await setRemainOnExit(runner, target);

  const existing = new Set(
    list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );

  for (const window of windows) {
    if (existing.has(window.name)) {
      continue;
    }
    const result = hasTmuxWindowEnv(window.env)
      ? await newTmuxWindowWithEnv(runner, target, window)
      : await runner.run(
          "tmux",
          [
            "-L",
            target.server,
            "new-window",
            "-t",
            target.session,
            "-n",
            window.name,
            "-c",
            window.cwd,
            window.command
          ],
          { env: window.env }
        );
    if (result.exitCode !== 0) {
      throw new Error(`tmux failed to start ${target.session}:${window.name}: ${result.stderr}`);
    }
  }
}

export async function stopTmuxSession(runner: CommandRunner, target: TmuxTarget): Promise<boolean> {
  if (!(await hasTmuxSession(runner, target))) {
    return false;
  }

  const list = await runner.run("tmux", ["-L", target.server, "list-windows", "-t", target.session, "-F", "#{window_name}"]);
  for (const name of list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    await runner.run("tmux", ["-L", target.server, "send-keys", "-t", `${target.session}:${name}`, "C-c"]);
  }
  const killed = await runner.run("tmux", ["-L", target.server, "kill-session", "-t", target.session]);
  if (killed.exitCode === 0 && target.inventoryPath) {
    removeInventoryResource(target.inventoryPath, { kind: "tmux-server", socket: target.server });
  }
  return killed.exitCode === 0;
}

export async function stopTmuxWindow(runner: CommandRunner, target: TmuxTarget, window: string): Promise<boolean> {
  const list = await runner.run("tmux", ["-L", target.server, "list-windows", "-t", target.session, "-F", "#{window_name}"]);
  if (list.exitCode !== 0) {
    return false;
  }
  const exists = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(window);
  if (!exists) {
    return false;
  }

  await runner.run("tmux", ["-L", target.server, "send-keys", "-t", `${target.session}:${window}`, "C-c"]);
  await runner.run("tmux", ["-L", target.server, "kill-window", "-t", `${target.session}:${window}`]);
  return true;
}

export async function respawnTmuxWindow(runner: CommandRunner, target: TmuxTarget, window: DevWindow): Promise<boolean> {
  const list = await runner.run("tmux", ["-L", target.server, "list-windows", "-t", target.session, "-F", "#{window_name}"]);
  if (list.exitCode !== 0) {
    return false;
  }
  const exists = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(window.name);
  if (!exists) {
    return false;
  }

  await setRemainOnExit(runner, target);

  const result = hasTmuxWindowEnv(window.env)
    ? await respawnTmuxWindowWithEnv(runner, target, window)
    : await runner.run(
        "tmux",
        [
          "-L",
          target.server,
          "respawn-window",
          "-k",
          "-t",
          `${target.session}:${window.name}`,
          "-c",
          window.cwd,
          window.command
        ],
        { env: window.env }
      );
  if (result.exitCode !== 0) {
    throw new Error(`tmux failed to respawn ${target.session}:${window.name}: ${result.stderr}`);
  }
  const after = await runner.run("tmux", ["-L", target.server, "list-windows", "-t", target.session, "-F", "#{window_name}"]);
  if (after.exitCode !== 0) {
    return false;
  }
  return after.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(window.name);
}

export async function captureTmuxLog(runner: CommandRunner, target: TmuxTarget, window: string): Promise<string> {
  const result = await runner.run("tmux", [
    "-L",
    target.server,
    "capture-pane",
    "-t",
    `${target.session}:${window}`,
    "-p",
    "-S",
    "-50"
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`tmux log failed for ${target.session}:${window}: ${result.stderr}`);
  }
  return result.stdout;
}
