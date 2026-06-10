import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tauriInvoke } from "../helpers/vue";
import { WebDriverClient, type WindowRect } from "../helpers/webdriver";

interface PersistedWindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  prev_x: number;
  prev_y: number;
  maximized: boolean;
  visible: boolean;
  decorated: boolean;
  fullscreen: boolean;
}

const repoRoot = resolve(process.cwd(), "../..");
const worktreeName = basename(repoRoot).replaceAll(".", "_");
const windowStateFilename = ".window-state.json";

function e2eTmuxSession(): string | undefined {
  const daemonDir = process.env.KANNA_DAEMON_DIR;
  if (!daemonDir) return process.env.KANNA_TMUX_SESSION;
  return process.env.KANNA_TMUX_SESSION ?? `kanna-e2e-${worktreeName}-${basename(daemonDir)}`;
}

async function runKd(args: string[]): Promise<void> {
  const child = spawn("./kd", args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(e2eTmuxSession() ? { KANNA_TMUX_SESSION: e2eTmuxSession() } : {}),
    },
    stdio: "inherit",
  });
  await new Promise<void>((resolveCommand, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      reject(new Error(`./kd ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

async function waitForWebDriver(client: WebDriverClient, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(`${client.getBaseUrl()}/status`).catch(() => null);
    if (status?.ok) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for WebDriver at ${client.getBaseUrl()}`);
}

function persistedWindowState(width: number, height: number): { main: PersistedWindowState } {
  return {
    main: {
      width,
      height,
      x: 120,
      y: 90,
      prev_x: 120,
      prev_y: 90,
      maximized: false,
      visible: true,
      decorated: true,
      fullscreen: false,
    },
  };
}

async function writeWindowState(path: string, width: number, height: number): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify(persistedWindowState(width, height), null, 2)}\n`,
    "utf8",
  );
}

async function stopAppAndLaunchWithState(
  client: WebDriverClient,
  windowStatePath: string,
  width: number,
  height: number,
): Promise<WindowRect> {
  await client.deleteSession();
  await runKd(["dev", "down"]);
  await writeWindowState(windowStatePath, width, height);
  await runKd(["dev", "up"]);
  await waitForWebDriver(client);
  await client.createSession();
  return client.getWindowRect();
}

async function waitForWindowRect(
  client: WebDriverClient,
  predicate: (rect: WindowRect) => boolean,
  timeoutMs = 5_000,
): Promise<WindowRect> {
  const deadline = Date.now() + timeoutMs;
  let latest: WindowRect | null = null;
  while (Date.now() < deadline) {
    latest = await client.getWindowRect();
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for window rect; latest=${JSON.stringify(latest)}`);
}

describe("native window state restore", () => {
  const client = new WebDriverClient();
  let windowStatePath: string | null = null;
  let backupPath: string | null = null;

  beforeAll(async () => {
    await client.createSession();
    const appDataDir = await tauriInvoke(client, "get_app_data_dir");
    if (typeof appDataDir !== "string") {
      throw new Error(`Unexpected app data dir: ${JSON.stringify(appDataDir)}`);
    }
    await mkdir(appDataDir, { recursive: true });
    windowStatePath = join(appDataDir, windowStateFilename);
    backupPath = join(appDataDir, `${windowStateFilename}.e2e-backup-${process.pid}`);
    await copyFile(windowStatePath, backupPath).catch(() => undefined);
  });

  afterAll(async () => {
    await client.deleteSession().catch(() => undefined);
    await runKd(["dev", "down"]).catch(() => undefined);

    if (windowStatePath && backupPath) {
      const backup = await readFile(backupPath, "utf8").catch(() => null);
      if (backup === null) {
        await rm(windowStatePath, { force: true }).catch(() => undefined);
      } else {
        await writeFile(windowStatePath, backup, "utf8").catch(() => undefined);
        await rm(backupPath, { force: true }).catch(() => undefined);
      }
    }

    await runKd(["dev", "up"]).catch(() => undefined);
  });

  it("resets undersized restored main windows while preserving valid saved sizes", async () => {
    if (!windowStatePath) throw new Error("window state path was not initialized");

    await stopAppAndLaunchWithState(client, windowStatePath, 640, 480);
    const undersizedRect = await waitForWindowRect(
      client,
      (rect) => rect.width >= 1000 && rect.height >= 700,
    );
    expect(undersizedRect.width).toBeGreaterThanOrEqual(1000);
    expect(undersizedRect.height).toBeGreaterThanOrEqual(700);

    await stopAppAndLaunchWithState(client, windowStatePath, 980, 720);
    const validRect = await waitForWindowRect(
      client,
      (rect) =>
        rect.width >= 900 &&
        rect.height >= 650 &&
        rect.width < 1150 &&
        rect.height < 780,
    );
    expect(validRect.width).toBeGreaterThanOrEqual(900);
    expect(validRect.height).toBeGreaterThanOrEqual(650);
    expect(validRect.width).toBeLessThan(1150);
    expect(validRect.height).toBeLessThan(780);
  });
});
