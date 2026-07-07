import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRequiredCommands } from "../src/runtime/doctor";
import { findWorkspaceDesktopDevProcesses, killWorkspaceDesktopDevProcesses } from "../src/runtime/daemon";
import { buildMobileDeviceSmokeCommand, buildMobileTestCommand } from "../src/runtime/mobile-commands";
import { getPortStatuses } from "../src/runtime/port-status";
import { respawnTmuxWindow, startTmuxSession, stopTmuxWindow } from "../src/runtime/tmux";
import { nodeCommandRunner, type CommandRunner } from "../src/runtime/process";

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

describe("command runtime helpers", () => {
  it("checks whether Firebase emulator ports are listening", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        const port = args.find((arg) => arg.startsWith("-iTCP:"))?.split(":").at(-1);
        return port === "9099"
          ? { exitCode: 0, stdout: "123\n", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
    };

    const statuses = await getPortStatuses(runner, {
      auth: 9099,
      firestore: 8080
    });

    expect(statuses).toEqual([
      { name: "auth", port: 9099, listening: true, pids: ["123"] },
      { name: "firestore", port: 8080, listening: false, pids: [] }
    ]);
    expect(calls).toEqual(["lsof -nP -iTCP:9099 -sTCP:LISTEN -t", "lsof -nP -iTCP:8080 -sTCP:LISTEN -t"]);
  });

  it("builds mobile test commands from the repo root", () => {
    expect(buildMobileTestCommand("/repo")).toEqual({
      command: "pnpm",
      args: ["--dir", "/repo/apps/mobile", "test"]
    });
    expect(buildMobileDeviceSmokeCommand("/repo")).toEqual({
      command: "pnpm",
      args: ["--dir", "/repo/apps/mobile", "run", "test:e2e:device:smoke"]
    });
  });

  it("reports required command availability for doctor", async () => {
    const runner: CommandRunner = {
      async run(_command, args) {
        return args.at(-1) === "tmux"
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: `/usr/bin/${args.at(-1)}\n`, stderr: "" };
      }
    };

    const result = await checkRequiredCommands(runner, ["git", "pnpm", "tmux"]);

    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([
      { name: "git", found: true, path: "/usr/bin/git" },
      { name: "pnpm", found: true, path: "/usr/bin/pnpm" },
      { name: "tmux", found: false }
    ]);
  });

  it("finds only this worktree's desktop dev processes for restart cleanup", () => {
    const repoRoot = "/repo/task-abc";
    const psOutput = [
      `101 node /repo/task-abc/apps/desktop/node_modules/.bin/../vite/bin/vite.js`,
      `102 node /repo/task-abc/apps/desktop/node_modules/.bin/../@tauri-apps/cli/tauri.js dev --config /repo/task-abc/apps/desktop/src-tauri/tauri.conf.local.json`,
      `103 /repo/task-abc/.build/debug/kanna-desktop`,
      `104 /repo/task-abc/.build/debug/kanna-server`,
      `105 node /repo/other/apps/desktop/node_modules/.bin/../vite/bin/vite.js`,
    ].join("\n");

    expect(findWorkspaceDesktopDevProcesses(repoRoot, psOutput).map((process) => process.pid)).toEqual([101, 102, 103]);
  });

  it("kills matched desktop dev processes before a component restart", async () => {
    const killed: number[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        expect(command).toBe("ps");
        expect(args).toEqual(["-axo", "pid=,command="]);
        return {
          exitCode: 0,
          stdout: [
            `101 node /repo/task-abc/apps/desktop/node_modules/.bin/../vite/bin/vite.js`,
            `102 /repo/task-abc/.build/debug/kanna-desktop`,
          ].join("\n"),
          stderr: ""
        };
      }
    };

    const result = await killWorkspaceDesktopDevProcesses({
      repoRoot: "/repo/task-abc",
      runner,
      killProcess: (pid) => killed.push(pid)
    });

    expect(result.map((process) => process.pid)).toEqual([101, 102]);
    expect(killed).toEqual([101, 102]);
  });

  it("stops a single tmux window without killing the dev session", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nemulators\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(stopTmuxWindow(runner, { server: "kanna-task", session: "kanna-task" }, "emulators")).resolves.toBe(true);

    expect(calls).toEqual([
      "tmux -L kanna-task list-windows -t kanna-task -F #{window_name}",
      "tmux -L kanna-task send-keys -t kanna-task:emulators C-c",
      "tmux -L kanna-task kill-window -t kanna-task:emulators"
    ]);
  });

  it("respawns a single tmux window with the resolved window env", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, stdin: options?.stdin });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(
      respawnTmuxWindow(
        runner,
        { server: "kanna-task", session: "kanna-task" },
        {
          name: "desktop",
          cwd: "/repo/apps/desktop",
          command: "pnpm exec tauri dev",
          env: {
            KANNA_CLOUD_ENV: "staging",
            KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
          }
        }
      )
    ).resolves.toBe(true);

    expect(calls).toEqual([
      {
        command: "tmux",
        args: ["-L", "kanna-task", "list-windows", "-t", "kanna-task", "-F", "#{window_name}"],
        env: undefined
      },
      {
        command: "tmux",
        args: ["-L", "kanna-task", "set-option", "-t", "kanna-task", "remain-on-exit", "on"],
        env: undefined
      },
      {
        command: "tmux",
        args: [
          "-L",
          "kanna-task",
          "source-file",
          "-"
        ],
        env: {
          KANNA_CLOUD_ENV: "staging",
          KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
        },
        stdin:
          "respawn-window '-k' '-t' 'kanna-task:desktop' '-c' '/repo/apps/desktop' '-e' 'KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL=dev@example.com' 'pnpm exec tauri dev'\n"
      },
      {
        command: "tmux",
        args: ["-L", "kanna-task", "list-windows", "-t", "kanna-task", "-F", "#{window_name}"],
        env: undefined
      }
    ]);
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("dev@example.com");
  });

  it("adds missing windows when the tmux dev session is already running", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.includes("new-session")) {
          return { exitCode: 1, stdout: "", stderr: "duplicate session: kanna-task" };
        }
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await startTmuxSession(
      runner,
      { server: "kanna-task", session: "kanna-task" },
      [
        { name: "desktop", cwd: "/repo/apps/desktop", command: "desktop", env: {} },
        { name: "mobile", cwd: "/repo/apps/mobile", command: "mobile", env: {} },
        { name: "emulators", cwd: "/repo", command: "emulators", env: {} }
      ]
    );

    expect(calls).toEqual([
      "tmux -L kanna-task new-session -d -s kanna-task -n desktop -c /repo/apps/desktop desktop",
      "tmux -L kanna-task list-windows -t kanna-task -F #{window_name}",
      "tmux -L kanna-task set-option -t kanna-task remain-on-exit on",
      "tmux -L kanna-task new-window -t kanna-task -n mobile -c /repo/apps/mobile mobile",
      "tmux -L kanna-task new-window -t kanna-task -n emulators -c /repo emulators"
    ]);
  });

  it.skipIf(!tmuxAvailable)("injects desktop credentials into a real tmux window without exposing them in command text", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-kd-real-tmux-"));
    const outputPath = join(root, "desktop-env.json");
    const tmuxName = `kanna-test-${process.pid}-${Date.now()}`;
    const target = {
      server: tmuxName,
      session: tmuxName
    };
    const email = "dev@example.com";
    const password = "do-not-print";
    const command = [
      "node",
      "-e",
      JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ email: process.env.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL, password: process.env.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD })); setTimeout(() => {}, 10000);`
      )
    ].join(" ");

    try {
      await startTmuxSession(nodeCommandRunner, target, [
        {
          name: "desktop",
          cwd: root,
          command,
          env: {
            PATH: process.env.PATH,
            KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: email,
            KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: password
          }
        }
      ]);

      await expect(waitForFile(outputPath)).resolves.toBe(
        JSON.stringify({ email, password })
      );

      const windows = await nodeCommandRunner.run("tmux", [
        "-L",
        target.server,
        "list-windows",
        "-t",
        target.session,
        "-F",
        "#{window_name} #{pane_current_command}"
      ]);
      const pane = await nodeCommandRunner.run("tmux", [
        "-L",
        target.server,
        "capture-pane",
        "-t",
        `${target.session}:desktop`,
        "-p",
        "-S",
        "-50"
      ]);
      const visibleTmuxText = `${windows.stdout}\n${windows.stderr}\n${pane.stdout}\n${pane.stderr}`;

      expect(visibleTmuxText).not.toContain(email);
      expect(visibleTmuxText).not.toContain(password);
    } finally {
      await nodeCommandRunner.run("tmux", ["-L", target.server, "kill-session", "-t", target.session])
        .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      await rm(root, { recursive: true, force: true });
    }
  });
});
