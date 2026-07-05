import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebDriverClient } from "../helpers/webdriver";
import { tauriInvoke } from "../helpers/vue";

const execFileAsync = promisify(execFile);

describe("kanna-server supervision", () => {
  const client = new WebDriverClient();

  beforeAll(async () => {
    await client.createSession();
  });

  afterAll(async () => {
    await client.deleteSession();
  });

  it("starts before the UI is ready for first interaction", async () => {
    const migrationRows = await client.executeAsync<unknown>(
      `const cb = arguments[arguments.length - 1];
       const ctx = window.__KANNA_E2E__?.setupState;
       const db = ctx?.db?.value || ctx?.db;
       db.select("SELECT id FROM schema_migrations ORDER BY id LIMIT 1")
         .then((rows) => cb(rows))
         .catch((error) => cb({ __error: error.message || String(error) }));`,
    );
    expect(migrationRows).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]));

    const status = await tauriInvoke(client, "mobile_server_status") as { state?: string; desktopId?: string };

    expect(status.state).toBe("running");
    expect(status.desktopId).toMatch(/^desktop-/);
  });

  it("recovers after kanna-server is killed mid-session", async () => {
    const port = await tauriInvoke(client, "read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" }) as string || "48120";
    const initialStreamStatus = await requestStatusThroughSharedStreamClient();
    expect(initialStreamStatus.desktopId).toMatch(/^desktop-/);

    const before = await waitForServerPid(port);

    await execFileAsync("/bin/kill", ["-9", String(before)]);

    const after = await waitForServerPid(port, before);
    expect(after).not.toBe(before);

    const status = await waitForMobileServerStatus();
    expect(status.state).toBe("running");

    const recoveredStreamStatus = await waitForSharedStreamStatus();
    expect(recoveredStreamStatus.desktopId).toBe(initialStreamStatus.desktopId);
  });

  async function waitForMobileServerStatus(): Promise<{ state?: string }> {
    const deadline = Date.now() + 15_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const status = await tauriInvoke(client, "mobile_server_status");
      last = status;
      if (status && typeof status === "object" && (status as { state?: string }).state === "running") {
        return status as { state?: string };
      }
      await sleep(250);
    }
    throw new Error(`timed out waiting for recovered server status; last=${JSON.stringify(last)}`);
  }

  async function waitForSharedStreamStatus(): Promise<{ desktopId?: string }> {
    const deadline = Date.now() + 15_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const status = await requestStatusThroughSharedStreamClient().catch((error) => {
        last = error instanceof Error ? error.message : String(error);
        return null;
      });
      if (status?.desktopId) return status;
      await sleep(250);
    }
    throw new Error(`timed out waiting for recovered shared stream request; last=${JSON.stringify(last)}`);
  }

  async function requestStatusThroughSharedStreamClient(): Promise<{ desktopId?: string }> {
    const result = await client.executeAsync<unknown>(
      `const cb = arguments[arguments.length - 1];
       import("/src/composables/desktopStreamClient.ts")
         .then(async ({ getSharedStreamClient }) => {
           const streamClient = await getSharedStreamClient();
           return await streamClient.request("GET", "/v1/status");
         })
         .then((response) => cb(response))
         .catch((error) => cb({ __error: error.message || String(error) }));`,
    );
    if (result && typeof result === "object" && "__error" in result) {
      throw new Error(String((result as { __error: unknown }).__error));
    }
    const response = result as { status?: number; body?: { desktopId?: string } };
    expect(response.status).toBe(200);
    return response.body ?? {};
  }
});

async function waitForServerPid(port: string, previousPid?: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", [
      "-nP",
      "-ti",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
    ]).catch(() => ({ stdout: "" }));
    const pid = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((candidate) => Number.isInteger(candidate) && candidate > 0 && candidate !== previousPid);
    if (pid) return pid;
    await sleep(250);
  }
  throw new Error(`timed out waiting for kanna-server pid on port ${port}`);
}
