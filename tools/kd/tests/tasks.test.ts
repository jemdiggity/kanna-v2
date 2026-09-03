import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeDevDownWithContext,
  executeDevUpWithContext,
  executeDevRestartWithContext,
  executeDevStatus,
  executeMobileDeviceDoctorWithContext,
  executeMobileDeviceRunWithContext,
  executeMobileDeviceUninstallWithContext,
  executeProductionMobileUpWithContext,
  listStagingRelayActiveDesktopIds
} from "../src/tasks/registry";
import type { CommandRunner } from "../src/runtime/process";

async function writeStagingDesktopAuth(home: string): Promise<void> {
  const dir = join(home, ".kanna", "developer", "staging");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "desktop-auth.toml"),
    '[desktop_auth]\nemail = "dev@example.com"\npassword = "do-not-print"\n'
  );
}

describe("task executors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("authenticates staging relay active-desktop lookup with the Firebase id token", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-relay-active-"));
    const home = await mkdtemp(join(tmpdir(), "kanna-kd-relay-home-"));
    await mkdir(join(repoRoot, "apps", "mobile", "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "apps", "mobile", "src", "mobileEnvironments.json"),
      JSON.stringify({ staging: { firebase: { apiKey: "staging-api-key" } } })
    );
    await writeStagingDesktopAuth(home);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ idToken: "firebase-id-token" })
      }))
    );

    const sentFrames: unknown[] = [];
    let openedUrl: string | undefined;
    class FakeWebSocket {
      onopen: (() => void) | null = null;
      onmessage: ((event: { data?: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(url: string) {
        openedUrl = url;
        queueMicrotask(() => this.onopen?.());
      }

      send(data: string): void {
        const frame = JSON.parse(data) as { type?: string; id?: string };
        sentFrames.push(frame);
        if (frame.type === "auth") {
          queueMicrotask(() => {
            this.onmessage?.({ data: JSON.stringify({ type: "auth_ok" }) });
          });
        }
        if (frame.type === "invoke" && frame.id === "kd-active-desktops") {
          queueMicrotask(() => {
            this.onmessage?.({
              data: JSON.stringify({
                type: "response",
                id: "kd-active-desktops",
                data: { desktopIds: ["desktop-installed-staging", "desktop-worktree-staging"] }
              })
            });
          });
        }
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const result = await listStagingRelayActiveDesktopIds({
      repoRoot,
      env: { HOME: home },
      relayUrl: "wss://relay-staging.kanna.build"
    });

    expect(openedUrl).toBe("wss://relay-staging.kanna.build");
    expect(sentFrames[0]).toEqual({ type: "auth", id_token: "firebase-id-token" });
    expect(sentFrames[0]).not.toHaveProperty("device_token");
    expect(sentFrames[1]).toEqual({
      type: "invoke",
      id: "kd-active-desktops",
      command: "list_active_desktops",
      args: {}
    });
    expect(result).toEqual(new Set(["desktop-installed-staging", "desktop-worktree-staging"]));
  });

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
      inventoryCleanup: { cleaned: [], failed: [] },
      daemonCleanup: {}
    });
    expect(killed).toEqual([]);
    expect(calls).toEqual([
      "tmux -L kanna-task-abc has-session -t kanna-task-abc"
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
      message: expect.stringContaining("Started mobile against production desktop desktop-ea554bc4 (0.0.53)."),
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

  it("starts only mobile against the installed staging desktop", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-staging-"));
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, stdin: options?.stdin });
        if (command === "curl") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ desktopId: "desktop-installed-staging", version: "0.2.0" }),
            stderr: ""
          };
        }
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\n", stderr: "" };
        }
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
      message: expect.stringContaining("Started mobile against the installed staging owner."),
      data: {
        relayUrl: "wss://relay-staging.kanna.build",
        windows: ["mobile"]
      }
    });
    expect(calls[1]).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["new-session", "-n", "mobile", "-c", `${repoRoot}/apps/mobile`])
    });
    const commandText = calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n");
    expect(commandText).toContain("KANNA_APP_ENV='staging'");
    expect(commandText).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-staging'");
    expect(commandText).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay-staging.kanna.build'");
    expect(commandText).not.toContain("apps/desktop");
    expect(commandText).not.toContain("pnpm run build:sidecars");
    expect(commandText).not.toContain("http://127.0.0.1:48120/v1/status");
  });

  it("does not inject staging desktop credentials for staging mobile up", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-staging-creds-"));
    const home = await mkdtemp(join(tmpdir(), "kanna-kd-staging-creds-home-"));
    await writeStagingDesktopAuth(home);
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, stdin: options?.stdin });
        if (command === "curl") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ desktopId: "desktop-installed-staging", version: "0.2.0" }),
            stderr: ""
          };
        }
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await executeProductionMobileUpWithContext(
      { production: false, staging: true, withCredentials: true },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8084 },
          env: {
            HOME: home,
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084",
            EXPO_PUBLIC_FIREBASE_API_KEY: "staging-api-key",
            EXPO_PUBLIC_FIREBASE_APP_ID: "staging-app-id"
          }
        }
      }
    );

    const desktopCalls = calls.filter((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL);
    const commandText = calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n");

    expect(desktopCalls).toHaveLength(0);
    expect(commandText).not.toContain("apps/desktop");
    expect(commandText).not.toContain("dev@example.com");
    expect(commandText).not.toContain("do-not-print");
  });

  it("starts dev desktop against staging cloud with opt-in desktop credentials", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-dev-up-staging-creds-"));
    const home = await mkdtemp(join(tmpdir(), "kanna-kd-dev-up-staging-creds-home-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(
      join(repoRoot, "firebase.json"),
      JSON.stringify({ functions: { source: "services/firebase-functions" }, emulators: {} })
    );
    await writeStagingDesktopAuth(home);
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, stdin: options?.stdin });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeDevUpWithContext(
      {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        cloud: "staging",
        withCredentials: true
      },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {
            KANNA_DEV_PORT: 1421,
            KANNA_MOBILE_PORT: 8084,
            KANNA_FIREBASE_AUTH_PORT: 9100,
            KANNA_FIREBASE_FIRESTORE_PORT: 9101,
            KANNA_FIREBASE_FUNCTIONS_PORT: 9102,
            KANNA_FIREBASE_UI_PORT: 9103
          },
          env: {
            HOME: home,
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084",
            KANNA_FIREBASE_AUTH_PORT: "9100",
            KANNA_FIREBASE_FIRESTORE_PORT: "9101",
            KANNA_FIREBASE_FUNCTIONS_PORT: "9102",
            KANNA_FIREBASE_UI_PORT: "9103"
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      message: expect.stringContaining("Started tmux session 'kanna-task-abc'."),
      data: {
        profile: {
          clientBuild: "dev",
          desktopOwner: "worktree",
          cloud: "staging"
        },
        windows: ["desktop"]
      }
    });
    const desktopCalls = calls.filter((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL);
    expect(desktopCalls.length).toBeGreaterThan(0);
    expect(desktopCalls.every((call) => call.env?.KANNA_CLOUD_ENV === "staging")).toBe(true);
    expect(desktopCalls.every((call) => call.env?.KANNA_FIREBASE_PROJECT_ID === "kanna-staging")).toBe(true);
    expect(desktopCalls.every((call) => call.env?.KANNA_RELAY_URL === "wss://relay-staging.kanna.build")).toBe(true);
    expect(desktopCalls.every((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL === "dev@example.com")).toBe(true);
    expect(desktopCalls.every((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD === "do-not-print")).toBe(true);
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("do-not-print");
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("dev@example.com");
  });

  it("reconciles a running worktree session when the desktop cloud profile changes", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-dev-profile-switch-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(
      join(repoRoot, "firebase.json"),
      JSON.stringify({ functions: { source: "services/firebase-functions" }, emulators: {} })
    );
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let sessionExists = false;
    let reconcileKey: string | undefined;
    let panePid = 100;
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        if (args.includes("new-session")) {
          if (sessionExists) {
            return { exitCode: 1, stdout: "", stderr: "duplicate session: kanna-task-abc" };
          }
          sessionExists = true;
          panePid += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("show-options")) {
          return reconcileKey
            ? { exitCode: 0, stdout: `${reconcileKey}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "unknown option" };
        }
        if (args.includes("set-option") && args.includes("@kanna_reconcile_key")) {
          reconcileKey = args.at(-1);
        }
        if (args.includes("has-session")) {
          return { exitCode: sessionExists ? 0 : 1, stdout: "", stderr: "" };
        }
        if (args.includes("list-windows")) {
          return { exitCode: sessionExists ? 0 : 1, stdout: sessionExists ? "desktop\n" : "", stderr: "" };
        }
        if (args.includes("kill-session")) {
          sessionExists = false;
          reconcileKey = undefined;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const executor = {
      runner,
      context: {
        repoRoot,
        tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
        ports: {
          KANNA_DEV_PORT: 1421,
          KANNA_MOBILE_PORT: 8084,
          KANNA_FIREBASE_AUTH_PORT: 9100,
          KANNA_FIREBASE_FIRESTORE_PORT: 9101,
          KANNA_FIREBASE_FUNCTIONS_PORT: 9102,
          KANNA_FIREBASE_UI_PORT: 9103
        },
        env: {
          KANNA_DEV_PORT: "1421",
          KANNA_MOBILE_PORT: "8084",
          KANNA_FIREBASE_AUTH_PORT: "9100",
          KANNA_FIREBASE_FIRESTORE_PORT: "9101",
          KANNA_FIREBASE_FUNCTIONS_PORT: "9102",
          KANNA_FIREBASE_UI_PORT: "9103"
        }
      }
    };
    const baseInput = {
      mobile: false,
      emulators: false,
      seed: false,
      attach: false,
      deleteDb: false,
      killDaemon: false,
      staging: false
    };

    await executeDevUpWithContext(baseInput, executor);
    const firstPid = panePid;
    await executeDevUpWithContext(baseInput, executor);
    expect(panePid).toBe(firstPid);

    await executeDevUpWithContext({ ...baseInput, cloud: "staging" }, executor);
    expect(panePid).toBeGreaterThan(firstPid);
    expect(calls.some((call) => call.args.includes("kill-session"))).toBe(true);
    const stagingStart = calls.filter((call) => call.args.includes("new-session") && call.env?.KANNA_CLOUD_ENV === "staging");
    expect(stagingStart).toHaveLength(2);
    expect(reconcileKey).toBe("dev:build=dev, owner=worktree, cloud=staging");
  });

  it("replaces a worktree Metro plan before starting installed-owner mobile", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-mobile-owner-switch-"));
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let sessionExists = true;
    let reconcileKey = "dev:build=dev, owner=worktree, cloud=emulators";
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        if (command === "curl") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ desktopId: "desktop-installed-staging", version: "0.2.0" }),
            stderr: ""
          };
        }
        if (args.includes("new-session")) {
          if (sessionExists) {
            return { exitCode: 1, stdout: "", stderr: "duplicate session: kanna-task-abc" };
          }
          sessionExists = true;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args.includes("show-options")) {
          return { exitCode: 0, stdout: `${reconcileKey}\n`, stderr: "" };
        }
        if (args.includes("set-option") && args.includes("@kanna_reconcile_key")) {
          reconcileKey = args.at(-1) ?? reconcileKey;
        }
        if (args.includes("has-session")) {
          return { exitCode: sessionExists ? 0 : 1, stdout: "", stderr: "" };
        }
        if (args.includes("list-windows")) {
          return {
            exitCode: sessionExists ? 0 : 1,
            stdout: sessionExists ? "mobile\nemulators\nrelay\ndesktop\n" : "",
            stderr: ""
          };
        }
        if (args.includes("kill-session")) {
          sessionExists = false;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await executeProductionMobileUpWithContext(
      { production: false, staging: false, build: "dev", owner: "staging" },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_MOBILE_PORT: 8084 },
          env: { KANNA_MOBILE_PORT: "8084" }
        }
      }
    );

    expect(calls.some((call) => call.args.includes("kill-session"))).toBe(true);
    const stagingStarts = calls.filter(
      (call) => call.args.includes("new-session") && call.env?.KANNA_DESKTOP_OWNER_ENV === "staging"
    );
    expect(stagingStarts).toHaveLength(2);
    expect(stagingStarts.at(-1)?.args).toEqual(
      expect.arrayContaining(["-n", "mobile", "-c", `${repoRoot}/apps/mobile`])
    );
    expect(reconcileKey).toBe("mobile:build=dev, owner=staging, cloud=staging");
    expect(calls.filter((call) => call.args.includes("new-window"))).toHaveLength(0);
  });

  it("starts dev desktop with emulator seed credentials when opt-in credentials are requested", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-dev-up-creds-"));
    const home = await mkdtemp(join(tmpdir(), "kanna-kd-dev-up-creds-home-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(
      join(repoRoot, "firebase.json"),
      JSON.stringify({ functions: { source: "services/firebase-functions" }, emulators: {} })
    );
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; stdin?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, stdin: options?.stdin });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeDevUpWithContext(
      {
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        withCredentials: true
      },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {
            KANNA_DEV_PORT: 1421,
            KANNA_MOBILE_PORT: 8084,
            KANNA_FIREBASE_AUTH_PORT: 9100,
            KANNA_FIREBASE_FIRESTORE_PORT: 9101,
            KANNA_FIREBASE_FUNCTIONS_PORT: 9102,
            KANNA_FIREBASE_UI_PORT: 9103
          },
          env: {
            HOME: home,
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084",
            KANNA_FIREBASE_AUTH_PORT: "9100",
            KANNA_FIREBASE_FIRESTORE_PORT: "9101",
            KANNA_FIREBASE_FUNCTIONS_PORT: "9102",
            KANNA_FIREBASE_UI_PORT: "9103"
          }
        }
      }
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        windows: ["emulators", "relay", "desktop"]
      }
    });
    const desktopCalls = calls.filter((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL);
    expect(desktopCalls.length).toBeGreaterThan(0);
    expect(desktopCalls.every((call) => call.env?.KANNA_CLOUD_ENV)).toBe(false);
    expect(desktopCalls.every((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL === "upvote.sieve.7t@icloud.com")).toBe(true);
    expect(desktopCalls.every((call) => call.env?.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD === "password123")).toBe(true);
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("password123");
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("upvote.sieve.7t@icloud.com");
  });

  it("restarts only the desktop tmux window against staging cloud env", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-restart-staging-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeDevRestartWithContext(
      {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        production: false
      },
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
      message: "Restarted desktop tmux window.",
      data: {
        component: "desktop",
        environment: "staging"
      }
    });
    const respawnCall = calls.find((call) => call.args.includes("respawn-window"));
    expect(calls.filter((call) => call.command === "tmux").map((call) => call.args[2])).toEqual([
      "list-windows",
      "set-option",
      "respawn-window",
      "list-windows"
    ]);
    expect(respawnCall).toMatchObject({
      command: "tmux",
      args: expect.arrayContaining(["respawn-window", "-t", "kanna-task-abc:desktop", "-c", `${repoRoot}/apps/desktop`])
    });
    expect(respawnCall?.env?.KANNA_CLOUD_ENV).toBe("staging");
    expect(respawnCall?.env?.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-staging");
    expect(respawnCall?.env?.KANNA_RELAY_URL).toBe("wss://relay-staging.kanna.build");
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain("mobile");
  });

  it("injects staging desktop credentials on staging desktop restart", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-restart-staging-creds-"));
    const home = await mkdtemp(join(tmpdir(), "kanna-kd-restart-staging-creds-home-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeStagingDesktopAuth(home);
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await executeDevRestartWithContext(
      {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: true,
        production: false,
        withCredentials: true
      },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8084 },
          env: {
            HOME: home,
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084"
          }
        }
      }
    );

    const respawnCall = calls.find((call) => call.args.includes("source-file"));
    expect(respawnCall?.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL).toBe("dev@example.com");
    expect(respawnCall?.env?.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD).toBe("do-not-print");
    expect(respawnCall?.args.join(" ")).not.toContain("do-not-print");
    expect(respawnCall?.args.join(" ")).not.toContain("dev@example.com");
  });

  it("injects dev emulator desktop credentials on dev desktop restart", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-restart-dev-creds-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await executeDevRestartWithContext(
      {
        component: "desktop",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false,
        withCredentials: true
      },
      {
        runner,
        context: {
          repoRoot,
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8084 },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "8084"
          }
        }
      }
    );

    const respawnCall = calls.find((call) => call.args.includes("source-file"));
    expect(respawnCall?.env?.KANNA_CLOUD_ENV).toBeUndefined();
    expect(respawnCall?.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL).toBe("upvote.sieve.7t@icloud.com");
    expect(respawnCall?.env?.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD).toBe("password123");
    expect(respawnCall?.args.join(" ")).not.toContain("password123");
    expect(respawnCall?.args.join(" ")).not.toContain("upvote.sieve.7t@icloud.com");
  });

  it("restarts only the mobile tmux window without respawning desktop", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env });
        if (args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\nemulators\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeDevRestartWithContext(
      {
        component: "mobile",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false
      },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: { KANNA_DEV_PORT: 1421, KANNA_MOBILE_PORT: 8084 },
          env: { KANNA_DEV_PORT: "1421", KANNA_MOBILE_PORT: "8084" }
        }
      }
    );

    expect(result.ok).toBe(true);
    const respawnCall = calls.find((call) => call.args.includes("respawn-window"));
    expect(calls.map((call) => call.args[2])).toEqual(["list-windows", "set-option", "respawn-window", "list-windows"]);
    expect(respawnCall?.args).toEqual(
      expect.arrayContaining(["respawn-window", "-t", "kanna-task-abc:mobile", "-c", "/repo/apps/mobile"])
    );
    expect(respawnCall?.args.join(" ")).toContain("pnpm run dev -- --port 8084 --dev-client");
    expect(respawnCall?.args.join(" ")).not.toContain("apps/desktop");
  });

  it("reports backend component restart as unsupported until it has a clean pane boundary", async () => {
    const runner: CommandRunner = {
      async run() {
        throw new Error("backend restart should not run tmux commands");
      }
    };

    const result = await executeDevRestartWithContext(
      {
        component: "backend",
        mobile: false,
        emulators: false,
        seed: false,
        attach: false,
        deleteDb: false,
        killDaemon: false,
        staging: false,
        production: false
      },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {},
          env: {}
        }
      }
    );

    expect(result).toEqual({
      ok: false,
      message: "Component restart for backend is not supported yet. Backend processes are owned by the desktop window; restart desktop instead.",
      data: { component: "backend" }
    });
  });

  it("uninstalls only the confirmed staging bundle and verifies its removal", async () => {
    const events: string[] = [];
    let appInspections = 0;
    const runner: CommandRunner = {
      async run(command, args) {
        events.push(`run:${command} ${args.join(" ")}`);
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
        if (args.includes("info") && args.includes("apps")) {
          appInspections += 1;
          return {
            exitCode: 0,
            stdout:
              appInspections === 1
                ? "Kanna build.kanna.app\nKanna Staging build.kanna.app.staging\n"
                : "Kanna build.kanna.app\n",
            stderr: ""
          };
        }
        if (args.includes("uninstall")) {
          return { exitCode: 0, stdout: "App uninstalled.\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      }
    };

    const result = await executeMobileDeviceUninstallWithContext(
      {
        device: true,
        production: false,
        staging: true,
        confirmBundle: "build.kanna.app.staging",
        confirmProduction: false
      },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task-abc", session: "kanna-task-abc" },
          ports: {},
          env: { KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C" }
        }
      },
      { writeOutput: (message) => events.push(`output:${message}`) }
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        bundleId: "build.kanna.app.staging",
        present: true,
        removed: true
      }
    });
    expect(result.message).toContain("was present and removed");
    const outputIndex = events.findIndex((event) => event.startsWith("output:"));
    const uninstallIndex = events.findIndex((event) => event.includes("device uninstall app"));
    expect(events[outputIndex]).toContain("Target device: Jerome's iPhone 15 (00008130-001015CA1091401C)");
    expect(events[outputIndex]).toContain("Target bundle: build.kanna.app.staging");
    expect(outputIndex).toBeGreaterThan(-1);
    expect(outputIndex).toBeLessThan(uninstallIndex);
    expect(events.filter((event) => event.includes("device uninstall app"))).toEqual([
      "run:xcrun devicectl device uninstall app --device 00008130-001015CA1091401C build.kanna.app.staging"
    ]);
    expect(events.some((event) => event.includes("device uninstall app") && event.includes("build.kanna.app "))).toBe(false);
  });

  it("reports when the confirmed staging bundle is not present without mutating the device", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.join(" ") === "xcdevice list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                available: true,
                identifier: "device-1",
                name: "Test iPhone",
                platform: "com.apple.platform.iphoneos",
                simulator: false
              }
            ]),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "Kanna build.kanna.app\n", stderr: "" };
      }
    };

    const result = await executeMobileDeviceUninstallWithContext(
      {
        device: true,
        production: false,
        staging: true,
        confirmBundle: "build.kanna.app.staging",
        confirmProduction: false
      },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "test", session: "test" },
          ports: {},
          env: {}
        }
      },
      { writeOutput: () => undefined }
    );

    expect(result).toMatchObject({ ok: true, data: { present: false, removed: false } });
    expect(result.message).toContain("was not present");
    expect(calls.some((call) => call.includes("uninstall"))).toBe(false);
  });

  it("rejects wrong confirmation, wrong environment, and unconfirmed production before device access", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
    };
    const executor = {
      runner,
      context: {
        repoRoot: "/repo",
        tmux: { server: "test", session: "test" },
        ports: {},
        env: {}
      }
    };

    await expect(
      executeMobileDeviceUninstallWithContext(
        {
          device: true,
          production: false,
          staging: true,
          confirmBundle: "build.kanna.app",
          confirmProduction: false
        },
        executor
      )
    ).rejects.toThrow("expected --confirm-bundle build.kanna.app.staging");
    await expect(
      executeMobileDeviceUninstallWithContext(
        {
          device: true,
          production: false,
          staging: false,
          confirmBundle: "build.kanna.app.staging",
          confirmProduction: false
        },
        executor
      )
    ).rejects.toThrow("requires exactly one of --staging or --production");
    await expect(
      executeMobileDeviceUninstallWithContext(
        {
          device: true,
          production: true,
          staging: false,
          confirmBundle: "build.kanna.app",
          confirmProduction: false
        },
        executor
      )
    ).rejects.toThrow("refuses production without the separate --confirm-production flag");
    expect(calls).toEqual([]);
  });

  it("refuses ambiguous physical-device selection for mobile uninstall", async () => {
    const runner: CommandRunner = {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              available: true,
              identifier: "device-1",
              name: "First iPhone",
              platform: "com.apple.platform.iphoneos",
              simulator: false
            },
            {
              available: true,
              identifier: "device-2",
              name: "Second iPhone",
              platform: "com.apple.platform.iphoneos",
              simulator: false
            }
          ]),
          stderr: ""
        };
      }
    };

    await expect(
      executeMobileDeviceUninstallWithContext(
        {
          device: true,
          production: false,
          staging: true,
          confirmBundle: "build.kanna.app.staging",
          confirmProduction: false
        },
        {
          runner,
          context: {
            repoRoot: "/repo",
            tmux: { server: "test", session: "test" },
            ports: {},
            env: {}
          }
        }
      )
    ).rejects.toThrow("Multiple attached iPhone devices were found");
  });

  it("reports a device uninstall command failure without claiming removal", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        if (args.join(" ") === "xcdevice list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                available: true,
                identifier: "device-1",
                name: "Test iPhone",
                platform: "com.apple.platform.iphoneos",
                simulator: false
              }
            ]),
            stderr: ""
          };
        }
        if (args.includes("info")) {
          return { exitCode: 0, stdout: "Kanna Staging build.kanna.app.staging\n", stderr: "" };
        }
        return { exitCode: 17, stdout: "", stderr: "CoreDevice refused the command" };
      }
    };

    const result = await executeMobileDeviceUninstallWithContext(
      {
        device: true,
        production: false,
        staging: true,
        confirmBundle: "build.kanna.app.staging",
        confirmProduction: false
      },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "test", session: "test" },
          ports: {},
          env: {}
        }
      },
      { writeOutput: () => undefined }
    );

    expect(result).toMatchObject({ ok: false, data: { present: true, removed: false } });
    expect(result.message).toContain("Failed to uninstall build.kanna.app.staging");
    expect(result.message).toContain("Exit code: 17");
    expect(result.message).toContain("CoreDevice refused the command");
    expect(calls.filter((call) => call.includes("info apps"))).toHaveLength(1);
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
    expect(
      calls.some(
        (call) =>
          call.command === "xcrun" &&
          call.args.includes("process") &&
          call.args.includes("launch") &&
          call.args.includes("build.kanna.app.dev")
      )
    ).toBe(false);
  });

  it("boots a simulator and reuses the worktree server stack before installing the dev client", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-simulator-run-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(
      join(repoRoot, "firebase.json"),
      JSON.stringify({ functions: { source: "services/firebase-functions" }, emulators: {} })
    );
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        calls.push({ command, args, env: options?.env, cwd: options?.cwd });
        if (command === "xcrun" && args.join(" ") === "simctl list devices available --json") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              devices: {
                "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
                  {
                    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
                    isAvailable: true,
                    name: "iPhone 17 Pro",
                    state: "Shutdown",
                    udid: "simulator-udid"
                  }
                ]
              }
            }),
            stderr: ""
          };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
        }
        if (command === "tmux" && args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const result = await executeMobileDeviceRunWithContext(
      { device: false, simulator: true, production: false, staging: false },
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
            KANNA_RELAY_PORT: "9081"
          }
        }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Launched Kanna mobile on iPhone 17 Pro simulator.");
    expect(calls.slice(0, 4)).toMatchObject([
      {
        command: "xcrun",
        args: ["simctl", "list", "devices", "available", "--json"]
      },
      { command: "xcrun", args: ["simctl", "boot", "simulator-udid"] },
      { command: "xcrun", args: ["simctl", "bootstatus", "simulator-udid", "-b"] },
      {
        command: "open",
        args: ["-a", "Simulator", "--args", "-CurrentDeviceUDID", "simulator-udid"]
      }
    ]);
    const tmuxStartIndex = calls.findIndex(
      (call) => call.command === "tmux" && call.args.includes("new-session")
    );
    const prebuildIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args.includes("prebuild")
    );
    const installIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args[2] === "ios"
    );
    expect(calls[tmuxStartIndex]?.args).toEqual(expect.arrayContaining(["-n", "emulators"]));
    expect(prebuildIndex).toBeGreaterThan(tmuxStartIndex);
    expect(installIndex).toBeGreaterThan(prebuildIndex);
    expect(calls[installIndex]).toMatchObject({
      command: "pnpm",
      args: [
        "--dir",
        `${repoRoot}/apps/mobile`,
        "ios",
        "--device",
        "simulator-udid",
        "--port",
        "1430"
      ],
      env: expect.objectContaining({
        KANNA_APP_ENV: "dev",
        REACT_NATIVE_PACKAGER_HOSTNAME: "127.0.0.1"
      })
    });
  });

  it("rejects an incoherent mobile profile before inspecting devices or starting processes", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push(`${command} ${args.join(" ")}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    await expect(executeMobileDeviceRunWithContext(
      {
        device: true,
        build: "staging",
        owner: "worktree",
        cloud: "staging"
      },
      {
        runner,
        context: {
          repoRoot: "/repo",
          tmux: { server: "kanna-task", session: "kanna-task" },
          ports: {},
          env: {}
        }
      }
    )).rejects.toThrow("Unsupported mobile profile");
    expect(calls).toEqual([]);
  });

  it("recovers when Expo reports a transient post-launch Metro failure and Metro becomes reachable", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-run-transient-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    await writeFile(
      join(repoRoot, "firebase.json"),
      JSON.stringify({ functions: { source: "services/firebase-functions" }, emulators: {} })
    );
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
    let metroStatusAttempts = 0;
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
          metroStatusAttempts += 1;
          return metroStatusAttempts < 2
            ? { exitCode: 7, stdout: "", stderr: "Failed to connect" }
            : { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
        }
        if (command === "xcrun" && args.includes("devicectl") && args.includes("info")) {
          return { exitCode: 0, stdout: "build.kanna.app.dev\n", stderr: "" };
        }
        if (command === "xcrun" && args.includes("process") && args.includes("launch")) {
          return { exitCode: 0, stdout: "Launched application\n", stderr: "" };
        }
        if (command === "tmux" && args.includes("list-windows")) {
          return { exitCode: 0, stdout: "desktop\nmobile\n", stderr: "" };
        }
        if (command === "pnpm" && args[2] === "ios") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "FAIL metro-lan: Metro is not reachable at http://172.16.0.193:1430/status"
          };
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
            KANNA_FIREBASE_UI_PORT: 9103
          },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "1430",
            KANNA_MOBILE_SERVER_PORT: "48120",
            KANNA_FIREBASE_AUTH_PORT: "9100",
            KANNA_FIREBASE_FIRESTORE_PORT: "9101",
            KANNA_FIREBASE_FUNCTIONS_PORT: "9102",
            KANNA_FIREBASE_UI_PORT: "9103",
            KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
          }
        }
      },
      {
        resolveLanAddress: () => "172.16.0.193",
        metroReadiness: { attempts: 2, delayMs: 0 }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Launched Kanna mobile on Jerome's iPhone 15.");
    expect(result.message).toContain("Recovered by relaunching build.kanna.app.dev after Metro became reachable.");
    expect(result.message).not.toContain("FAIL metro-lan");
    const installIndex = calls.findIndex((call) => call.command === "pnpm" && call.args[2] === "ios");
    const relaunchIndex = calls.findIndex(
      (call) => call.command === "xcrun" && call.args.includes("process") && call.args.includes("launch")
    );
    expect(relaunchIndex).toBeGreaterThan(installIndex);
    expect(calls[relaunchIndex]).toMatchObject({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "process",
        "launch",
        "--terminate-existing",
        "--device",
        "00008130-001015CA1091401C",
        "--payload-url",
        "exp+kanna-mobile://expo-development-client/?url=http%3A%2F%2F172.16.0.193%3A1430",
        "build.kanna.app.dev"
      ]
    });
  });

  it("fails clearly when Metro never becomes reachable for a physical-device launch", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-run-persistent-"));
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
          return { exitCode: 7, stdout: "", stderr: "Failed to connect" };
        }
        if (command === "xcrun" && args.includes("devicectl") && args.includes("info")) {
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
            KANNA_FIREBASE_UI_PORT: 9103
          },
          env: {
            KANNA_DEV_PORT: "1421",
            KANNA_MOBILE_PORT: "1430",
            KANNA_MOBILE_SERVER_PORT: "48120",
            KANNA_FIREBASE_AUTH_PORT: "9100",
            KANNA_FIREBASE_FIRESTORE_PORT: "9101",
            KANNA_FIREBASE_FUNCTIONS_PORT: "9102",
            KANNA_FIREBASE_UI_PORT: "9103",
            KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
          }
        }
      },
      {
        resolveLanAddress: () => "172.16.0.193",
        metroReadiness: { attempts: 2, delayMs: 0 }
      }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Metro is not reachable at http://172.16.0.193:1430/status after 2 attempts.");
    expect(result.message).toContain("Local Network");
    expect(calls.some((call) => call.command === "pnpm" && call.args[2] === "ios")).toBe(false);
    expect(
      calls.some((call) => call.command === "xcrun" && call.args.includes("process") && call.args.includes("launch"))
    ).toBe(false);
  });

  it("runs the dev mobile identity against the installed staging owner and staging cloud", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-staging-"));
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
          return { exitCode: 0, stdout: "build.kanna.app.dev\n", stderr: "" };
        }
        if (command === "gh") {
          return { exitCode: 0, stdout: '{"version":"0.2.0-staging.1"}\n', stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const result = await executeMobileDeviceRunWithContext(
      {
        device: true,
        production: false,
        staging: false,
        build: "dev",
        owner: "staging"
      },
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
      {
        resolveLanAddress: () => "172.16.0.193",
        readInstalledStagingDesktopStatus: async () => ({ desktopId: "desktop-installed-staging" }),
        listStagingRelayActiveDesktopIds: async () => new Set(["desktop-installed-staging"])
      }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      bundleId: "build.kanna.app.dev",
      profile: {
        clientBuild: "dev",
        desktopOwner: "staging",
        cloud: "staging"
      },
      windows: ["mobile"]
    });
    expect(result.message).toContain("Profile: build=dev, owner=staging, cloud=staging.");
    expect(result.message).toContain("Desktop owner endpoint: http://127.0.0.1:48121/v1/status");
    expect(result.message).toContain("Device endpoint: wss://relay-staging.kanna.build");
    expect(calls.some((call) => call.command === "tmux" && call.args.includes("kill-session"))).toBe(false);
    expect(calls.some((call) =>
      call.command === "tmux" &&
      call.args.includes("kill-window") &&
      call.args.some((arg) => arg.endsWith(":mobile"))
    )).toBe(true);
    const tmuxDesktopIndex = calls.findIndex(
      (call) => call.command === "tmux" && call.args.includes("new-session") && call.args.includes("desktop")
    );
    const tmuxMobileIndex = calls.findIndex(
      (call) =>
        call.command === "tmux" &&
        (call.args.includes("new-session") || call.args.includes("new-window")) &&
        call.args.includes("mobile")
    );
    const prebuildIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args.includes("prebuild")
    );
    const installIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args[2] === "ios"
    );
    expect(tmuxDesktopIndex).toBe(-1);
    expect(tmuxMobileIndex).toBeGreaterThan(-1);
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("KANNA_APP_ENV='dev'");
    expect(calls[tmuxMobileIndex]?.env?.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL).toBeUndefined();
    expect(calls[tmuxMobileIndex]?.env?.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD).toBeUndefined();
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-staging'");
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay-staging.kanna.build'");
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("REACT_NATIVE_PACKAGER_HOSTNAME='172.16.0.193'");
    expect(calls[tmuxMobileIndex]?.args.join(" ")).toContain("while true; do");
    expect(calls[prebuildIndex]?.env?.KANNA_APP_ENV).toBe("dev");
    expect(calls[prebuildIndex]?.env?.KANNA_APP_VERSION).toBeUndefined();
    expect(calls[installIndex]?.env?.KANNA_APP_ENV).toBe("dev");
    expect(calls[installIndex]?.env?.KANNA_APP_VERSION).toBeUndefined();
    expect(calls[installIndex]?.env?.REACT_NATIVE_PACKAGER_HOSTNAME).toBe("172.16.0.193");
    expect(calls.some((call) => call.command === "gh")).toBe(false);
  });

  it.each([
    {
      name: "defaults a staging Release install to the mobile-owned marketing version",
      explicitVersion: undefined
    },
    {
      name: "preserves an explicit staging Release install marketing-version override",
      explicitVersion: "9.8.7"
    }
  ])("$name", async ({ explicitVersion }) => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-staging-install-"));
    await mkdir(join(repoRoot, "apps", "mobile", "ios", "KannaStaging.xcworkspace"), {
      recursive: true
    });
    await mkdir(
      join(
        repoRoot,
        ".build",
        "mobile",
        "ios-device-staging",
        "Build",
        "Products",
        "Release-iphoneos",
        "KannaStaging.app"
      ),
      { recursive: true }
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
        if (command === "curl" && args.at(-1) === "http://127.0.0.1:48121/v1/status") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ desktopId: "desktop-installed-staging" }),
            stderr: ""
          };
        }
        if (command === "curl") {
          return { exitCode: 1, stdout: "", stderr: "install mode should not check Metro" };
        }
        if (command === "tmux") {
          return { exitCode: 1, stdout: "", stderr: "install mode should not start tmux" };
        }
        if (command === "gh") {
          return { exitCode: 0, stdout: '{"version":"0.2.0-staging.1"}\n', stderr: "" };
        }
        return { exitCode: 0, stdout: "Installed Kanna Staging\n", stderr: "" };
      }
    };

    const result = await executeMobileDeviceRunWithContext(
      { device: true, production: false, staging: true, install: true },
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
            KANNA_APP_ENV: "dev",
            ...(explicitVersion ? { KANNA_APP_VERSION: explicitVersion } : {}),
            KANNA_IOS_PHYSICAL_DEVICE_NAME: "Jerome's iPhone 15"
          }
        }
      },
      {
        listStagingRelayActiveDesktopIds: async () => new Set(["desktop-installed-staging"])
      }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Installed and launched Kanna mobile on Jerome's iPhone 15.");
    expect(result.message).toContain("Bundle ID: build.kanna.app.staging");
    expect(result.message).toContain("Environment: staging");
    expect(result.message).toContain("Metro is not required");
    expect(result.data).toMatchObject({
      bundleId: "build.kanna.app.staging",
      environment: "staging",
      device: {
        name: "Jerome's iPhone 15",
        udid: "00008130-001015CA1091401C"
      },
      appPath: join(
        repoRoot,
        ".build",
        "mobile",
        "ios-device-staging",
        "Build",
        "Products",
        "Release-iphoneos",
        "KannaStaging.app"
      )
    });
    expect(calls.some((call) => call.command === "tmux")).toBe(false);
    expect(calls.some((call) => call.command === "curl" && call.args.at(-1) === "http://127.0.0.1:48121/v1/status")).toBe(true);
    expect(calls.some((call) => call.command === "curl" && call.args.at(-1)?.includes(":1430/status"))).toBe(false);
    expect(calls.some((call) => call.command === "gh")).toBe(false);
    const prebuildIndex = calls.findIndex(
      (call) => call.command === "pnpm" && call.args.includes("prebuild")
    );
    const buildIndex = calls.findIndex((call) => call.command === "xcodebuild");
    const installIndex = calls.findIndex(
      (call) => call.command === "xcrun" && call.args.includes("install")
    );
    const launchIndex = calls.findIndex(
      (call) => call.command === "xcrun" && call.args.includes("launch")
    );
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
    expect(calls[prebuildIndex]?.env?.KANNA_APP_ENV).toBe("staging");
    expect(calls[prebuildIndex]?.env?.KANNA_APP_VERSION).toBe(explicitVersion);
    expect(calls[buildIndex]).toMatchObject({
      command: "xcodebuild",
      args: [
        "-workspace",
        join(repoRoot, "apps", "mobile", "ios", "KannaStaging.xcworkspace"),
        "-scheme",
        "KannaStaging",
        "-configuration",
        "Release",
        "-destination",
        "id=00008130-001015CA1091401C",
        "-derivedDataPath",
        join(repoRoot, ".build", "mobile", "ios-device-staging"),
        "-allowProvisioningUpdates",
        "-allowProvisioningDeviceRegistration",
        "build"
      ],
      cwd: repoRoot
    });
    expect(calls[buildIndex]?.env?.KANNA_APP_ENV).toBe("staging");
    expect(calls[buildIndex]?.env?.KANNA_APP_VERSION).toBe(explicitVersion);
    expect(calls[buildIndex]?.env?.REACT_NATIVE_PACKAGER_HOSTNAME).toBeUndefined();
    expect(calls[buildIndex]?.env?.RCT_METRO_PORT).toBeUndefined();
    expect(calls[installIndex]).toMatchObject({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        "00008130-001015CA1091401C",
        join(
          repoRoot,
          ".build",
          "mobile",
          "ios-device-staging",
          "Build",
          "Products",
          "Release-iphoneos",
          "KannaStaging.app"
        )
      ]
    });
    expect(calls[launchIndex]).toMatchObject({
      command: "xcrun",
      args: [
        "devicectl",
        "device",
        "process",
        "launch",
        "--terminate-existing",
        "--device",
        "00008130-001015CA1091401C",
        "build.kanna.app.staging"
      ]
    });
    expect(launchIndex).toBeGreaterThan(installIndex);
    expect(installIndex).toBeGreaterThan(buildIndex);
  });

  it("blocks staging physical-device launch when the installed staging desktop is absent from the relay", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kanna-kd-device-staging-offline-"));
    await mkdir(join(repoRoot, "apps", "desktop", "src-tauri"), { recursive: true });
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
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
        if (command === "curl" && args.at(-1) === "http://127.0.0.1:48121/v1/status") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              desktopId: "desktop-installed-staging",
              version: "0.1.0",
              relayUrl: "wss://relay-staging.kanna.build"
            }),
            stderr: ""
          };
        }
        if (command === "curl") {
          return { exitCode: 0, stdout: "packager-status:running\n", stderr: "" };
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
      {
        resolveLanAddress: () => "172.16.0.193",
        listStagingRelayActiveDesktopIds: async () => new Set(["desktop-worktree-staging"])
      }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Installed staging desktop desktop-installed-staging is not active in staging relay.");
    expect(calls.some((call) => call.command === "pnpm" && call.args.includes("prebuild"))).toBe(false);
    expect(calls.some((call) => call.command === "pnpm" && call.args[2] === "ios")).toBe(false);
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
