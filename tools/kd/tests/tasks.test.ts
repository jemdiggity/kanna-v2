import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeDevDownWithContext,
  executeDevStatus,
  executeMobileDeviceDoctorWithContext,
  executeMobileDeviceRunWithContext,
  executeProductionMobileUpWithContext
} from "../src/tasks/registry";
import type { CommandRunner } from "../src/runtime/process";

describe("task executors", () => {
  it("reports no running tmux session as ok status", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        expect(command).toBe("tmux");
        expect(args).toEqual(["-L", "kanna-task-abc", "has-session", "-t", "kanna-task-abc"]);
        return { exitCode: 1, stdout: "", stderr: "no server running" };
      }
    };

    const result = await executeDevStatus({
      runner,
      context: {
        repoRoot: "/repo/.kanna-worktrees/task-abc",
        tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
        ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8082 },
        env: {}
      }
    });

    expect(result).toEqual({
      ok: true,
      message: "Kanna dev session is not running.",
      data: {
        running: false,
        session: "kanna-task-abc",
        server: "kanna-task-abc"
      }
    });
  });

  it("runs workspace daemon cleanup when dev down asks to kill daemons", async () => {
    const calls: string[] = [];
    const killed: number[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no server running" };
        }
        if (command === "ps") {
          return { exitCode: 0, stdout: " 123 /repo/.build/debug/kanna-daemon\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeDevDownWithContext(
      { killDaemon: true },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {},
          env: { KANNA_DAEMON_DIR: "/repo/.kanna-daemon" }
        }
      },
      { killProcess: (pid) => killed.push(pid) }
    );

    expect(result.data).toEqual({
      stopped: false,
      daemonCleanup: {
        orphanedKilled: [{ pid: 123, command: "/repo/.build/debug/kanna-daemon" }]
      }
    });
    expect(killed).toEqual([123]);
    expect(calls).toEqual([
      "tmux -L kanna-task-abc has-session -t kanna-task-abc",
      "ps -axo pid=,command="
    ]);
  });

  it("verifies the production desktop server before starting the mobile window", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "curl") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              desktopId: "desktop-ea554bc4",
              version: "0.0.53",
              relay_url: "wss://kanna-relay.example",
              state: "running"
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeProductionMobileUpWithContext(
      { production: true, staging: false },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_MOBILE_PORT: 8083 },
          env: {
            KANNA_MOBILE_PORT: "8083",
            EXPO_PUBLIC_KANNA_RELAY_URL: "wss://kanna-relay.example"
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      message: "Started mobile against production desktop desktop-ea554bc4 (0.0.53).",
      data: {
        desktopId: "desktop-ea554bc4",
        version: "0.0.53",
        windows: ["mobile"]
      }
    });
    expect(calls[0]).toBe("curl --fail --silent --show-error http://127.0.0.1:48120/v1/status");
    expect(calls[1]).toContain("test -f ");
    expect(calls[1]).toContain("Library/Application Support/build.kanna/Kanna/server.toml");
    expect(calls[2]).toContain("tmux -L kanna-task-abc new-session");
    expect(calls[2]).not.toContain("EXPO_PUBLIC_KANNA_SERVER_URL");
    expect(calls.join("\n")).not.toContain("apps/desktop");
  });

  it("starts the worktree desktop and mobile against staging cloud env without requiring production desktop status", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-staging-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeProductionMobileUpWithContext(
      { production: false, staging: true },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8084 },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084",
            EXPO_PUBLIC_FIREBASE_API_KEY: "staging-api-key",
            EXPO_PUBLIC_FIREBASE_APP_ID: "staging-app-id"
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      message: "Started mobile against staging cloud environment.",
      data: {
        relayUrl: "wss://relay-staging.kanna.build",
        windows: ["desktop", "mobile"]
      }
    });
    expect(calls[0]).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["new-session", "-n", "desktop", "-c", `${repoRoot}/apps/desktop`])
    });
    expect(calls[0]?.env?.KANNA_CLOUD_ENV).toBe("staging");
    expect(calls[0]?.env?.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-staging");
    expect(calls[0]?.env?.KANNA_RELAY_URL).toBe("wss://relay-staging.kanna.build");
    expect(calls[2]).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["new-window", "-n", "mobile", "-c", `${repoRoot}/apps/mobile`])
    });
    expect(calls[2]?.args.join(" ")).toContain("KANNA_APP_ENV='staging'");
    expect(calls[2]?.args.join(" ")).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-staging'");
    expect(calls[2]?.args.join(" ")).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay-staging.kanna.build'");
    expect(calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n")).not.toContain("curl --fail");
  });

  it("starts dev mobile with emulators before building and launching on a physical device", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-run-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(
      join(repoRoot, "firebase.json"),
      JSON.stringify({ functions: { source: "services/firebase-functions" }, emulators: {} })
    );
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, cwd: options?.cwd });
        if (command === "xcrun" && args.join(" ") === "xcdevice list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                available: true,
                identifier: "00008130-001015CA1091401C",
                name: "Jerome's iPhone 15",
                operatingSystemVersion: "17.5 (21F79)",
                platform: "com.apple.platform.iphoneos",
                simulator: false
              }
            ]),
            stderr: ""
          };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
        }
        if (command === "xcrun" && args.includes("devicectl")) {
          return { exitCode: 0, stdout: "build.kanna.app.dev\n", stderr: "" };
        }
        if (command === "tmux" && args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeMobileDeviceRunWithContext(
      { device: true, production: false, staging: false },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {
            KANNA_DEV_PORT: 1421,
            KANNA_MOBILE_PORT: 1430,
            KANNA_FIREBASE_AUTH_PORT: 9100,
            KANNA_FIREBASE_FIRESTORE_PORT: 9101,
            KANNA_FIREBASE_FUNCTIONS_PORT: 9102,
            KANNA_FIREBASE_UI_PORT: 9103,
            KANNA_RELAY_PORT: 9081
          },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "1430",
            KANNA_MOBILE_SERVER_PORT: "48120",
            KANNA_FIREBASE_AUTH_PORT: "9100",
            KANNA_FIREBASE_FIRESTORE_PORT: "9101",
            KANNA_FIREBASE_FUNCTIONS_PORT: "9102",
            KANNA_FIREBASE_UI_PORT: "9103",
            KANNA_RELAY_PORT: "9081",
            KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
          }
        }
      },
      { resolveLanAddress: () => "172.16.0.193" }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Launched Kanna mobile on Jerome's iPhone 15.");
    expect(result.message).toContain("Metro: http://172.16.0.193:1430");
    const tmuxStartIndex = calls.findIndex(
      (call) => call.command === "tmux" && call.args.includes("new-session")
    );
    const tmuxKillMobileIndex = calls.findIndex(
      (call) => call.command === "tmux" && call.args.includes("kill-window") && call.args.includes("kanna-task-abc:mobile")
    );
    const installIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args[2] === "ios"
    );
    const prebuildIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args.includes("prebuild")
    );
    expect(calls[tmuxStartIndex]).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["new-session", "-n", "emulators"])
    });
    expect(tmuxStartIndex).toBeGreaterThan(-1);
    expect(tmuxKillMobileIndex).toBeGreaterThan(-1);
    expect(tmuxKillMobileIndex).toBeLessThan(tmuxStartIndex);
    expect(prebuildIndex).toBeGreaterThan(tmuxStartIndex);
    expect(installIndex).toBeGreaterThan(tmuxStartIndex);
    expect(installIndex).toBeGreaterThan(prebuildIndex);
    expect(calls.some((call) => call.command === "curl" && call.args.at(-1) === "http://172.16.0.193:1430/status")).toBe(true);
    expect(calls[prebuildIndex]).toMatchObject({
      command: "pnpm",
      args: [
        "--dir",
        `${repoRoot}/apps/mobile`,
        "exec",
        "expo",
        "prebuild",
        "--platform",
        "ios"
      ],
      cwd: repoRoot
    });
    expect(calls[prebuildIndex]?.env?.KANNA_APP_ENV).toBe("dev");
    expect(calls[prebuildIndex]?.env?.KANNA_BUNDLE_ID).toBeUndefined();
    expect(calls[prebuildIndex]?.env?.KANNA_DISPLAY_NAME).toBeUndefined();
    expect(calls[installIndex]).toMatchObject({
      command: "pnpm",
      args: [
        "--dir",
        `${repoRoot}/apps/mobile`,
        "ios",
        "--device",
        "00008130-001015CA1091401C",
        "--port",
        "1430"
      ],
      cwd: repoRoot
    });
    expect(calls[installIndex]?.env?.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("172.16.0.193");
  });

  it("starts staging mobile, prebuilds the staging bundle, and launches it on a physical device", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-staging-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, cwd: options?.cwd });
        if (command === "xcrun" && args.join(" ") === "xcdevice list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                available: true,
                identifier: "00008130-001015CA1091401C",
                name: "Jerome's iPhone 15",
                operatingSystemVersion: "17.5 (21F79)",
                platform: "com.apple.platform.iphoneos",
                simulator: false
              }
            ]),
            stderr: ""
          };
        }
        if (command === "tmux" && args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
        }
        if (command === "xcrun" && args.includes("devicectl")) {
          return { exitCode: 0, stdout: "build.kanna.app.staging\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeMobileDeviceRunWithContext(
      { device: true, production: false, staging: true },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {
            KANNA_DEV_PORT: 1421,
            KANNA_MOBILE_PORT: 1430
          },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "1430",
            KANNA_MOBILE_SERVER_PORT: "48120",
            KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
          }
        }
      },
      { resolveLanAddress: () => "172.16.0.193" }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      bundleId: "build.kanna.app.staging",
      windows: ["desktop", "mobile"]
    });
    expect(calls.some((call) => call.command === "tmux" && call.args.includes("kill-session"))).toBe(true);
    const tmuxDesktopIndex = calls.findIndex(
      (call) => call.command === "tmux" && call.args.includes("new-session") && call.args.includes("desktop")
    );
    const tmuxMobileIndex = calls.findIndex(
      (call) => call.command === "tmux" && call.args.includes("new-window") && call.args.includes("mobile")
    );
    const prebuildIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args.includes("prebuild")
    );
    const installIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args[2] === "ios"
    );
    expect(tmuxDesktopIndex).toBeGreaterThan(-1);
    expect(tmuxMobileIndex).toBeGreaterThan(tmuxDesktopIndex);
    expect(calls[tmuxDesktopIndex]?.env?.KANNA_CLOUD_ENV).toBe("staging");
    expect(calls[tmuxDesktopIndex]?.env?.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-staging");
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("KANNA_APP_ENV='staging'");
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-staging'");
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay-staging.kanna.build'");
    expect(calls[prebuildIndex]?.env?.KANNA_APP_ENV).toBe("staging");
    expect(calls[installIndex]?.env?.KANNA_APP_ENV).toBe("staging");
    expect(calls[installIndex]?.env?.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("172.16.0.193");
  });

  it("runs physical-device mobile doctor checks without building or launching the app", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "xcrun" && args.join(" ") === "xcdevice list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                available: true,
                identifier: "00008130-001015CA1091401C",
                name: "Jerome's iPhone 15",
                operatingSystemVersion: "17.5 (21F79)",
                platform: "com.apple.platform.iphoneos",
                simulator: false
              }
            ]),
            stderr: ""
          };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
        }
        if (command === "xcrun" && args.includes("devicectl")) {
          return { exitCode: 0, stdout: "build.kanna.app.dev\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeMobileDeviceDoctorWithContext(
      { device: true },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_MOBILE_PORT: 1430 },
          env: {
            KANNA_MOBILE_PORT: "1430",
            KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
          }
        }
      },
      { resolveLanAddress: () => "172.16.0.193" }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Metro is reachable at http://172.16.0.193:1430/status.");
    expect(result.message).toContain("Local Network");
    expect(calls).not.toContain("pnpm --dir /repo/apps/mobile ios");
  });
});
