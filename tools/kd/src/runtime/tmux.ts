import type { DevWindow } from "./dev-plan";
import type { CommandRunner } from "./process";

export interface TmuxTarget {
  server: string;
  session: string;
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

  const firstResult = await runner.run(
    "tmux",
    ["-L", target.server, "new-session", "-d", "-s", target.session, "-n", first.name, "-c", first.cwd, first.command],
    { env: first.env }
  );
  if (firstResult.exitCode !== 0) {
    if (isDuplicateSessionError(firstResult.stderr)) {
      await addMissingTmuxWindows(runner, target, windows);
      return;
    }
    throw new Error(`tmux failed to start ${target.session}:${first.name}: ${firstResult.stderr}`);
  }

  await runner.run("tmux", ["-L", target.server, "set-option", "-t", target.session, "remain-on-exit", "on"]);

  for (const window of rest) {
    const result = await runner.run(
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
    const result = await runner.run(
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
  await runner.run("tmux", ["-L", target.server, "kill-session", "-t", target.session]);
  return true;
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
