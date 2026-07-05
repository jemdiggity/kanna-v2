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
    const status = await tauriInvoke(client, "mobile_server_status") as { state?: string; desktopId?: string };

    expect(status.state).toBe("running");
    expect(status.desktopId).toMatch(/^desktop-/);
  });

  it("recovers after kanna-server is killed mid-session", async () => {
    const port = await tauriInvoke(client, "read_env_var", { name: "KANNA_MOBILE_SERVER_PORT" }) as string || "48120";
    const before = await waitForServerPid(port);

    await execFileAsync("/bin/kill", ["-9", String(before)]);

    const after = await waitForServerPid(port, before);
    expect(after).not.toBe(before);

    const status = await waitForMobileServerStatus();
    expect(status.state).toBe("running");
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
