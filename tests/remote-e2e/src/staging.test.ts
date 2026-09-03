import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  remoteHarnessKannaCliPath,
  writeRemoteHarnessZshStartupFiles,
} from "./harness";
import {
  buffyStagingCredentialsFromEnv,
  stagingRemoteE2eSkipMessage,
  stagingServerEnvironment,
  stagingServerTomlLines
} from "./staging";

describe("staging remote E2E configuration", () => {
  it("skips cleanly when the staging device token or Buffy password is absent", () => {
    expect(buffyStagingCredentialsFromEnv({ NODE_ENV: "test" })).toEqual({
      ok: false,
      missing: ["KANNA_E2E_DEVICE_TOKEN", "KANNA_STAGING_TEST_PASSWORD"]
    });
    expect(stagingRemoteE2eSkipMessage(["KANNA_E2E_DEVICE_TOKEN"])).toBe(
      "SKIP staging remote-e2e: missing KANNA_E2E_DEVICE_TOKEN"
    );
  });

  it("uses staging cloud settings and a disposable desktop identity", () => {
    const env = stagingServerEnvironment({
      NODE_ENV: "test",
      KANNA_E2E_DEVICE_TOKEN: "staging-buffy-device-token",
      KANNA_STAGING_TEST_PASSWORD: "secret"
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected staging env");

    expect(env.credentials.deviceToken).toBe("staging-buffy-device-token");
    expect(env.credentials.password).toBe("secret");
    expect(env.relayUrl).toBe("wss://relay-staging.kanna.build");
    expect(env.firebaseProjectId).toBe("kanna-staging");
    expect(env.desktopId).toMatch(/^remote-e2e-staging-/);
  });

  it("writes a kanna-server config that points both relay and Firebase at staging", () => {
    const lines = stagingServerTomlLines({
      daemonDir: "/tmp/kanna-daemon",
      dbPath: "/tmp/kanna.sqlite3",
      desktopId: "remote-e2e-staging-test",
      deviceToken: "staging-buffy-device-token",
      kannaCliPath: "/tmp/repo/.build/debug/kanna-cli",
      lanPort: 48129,
      pairingStorePath: "/tmp/pairings.json",
      transferPort: 48130
    });

    expect(lines).toContain('relay_url = "wss://relay-staging.kanna.build"');
    expect(lines).toContain('device_token = "staging-buffy-device-token"');
    expect(lines).toContain('firebase_project_id = "kanna-staging"');
    expect(lines).toContain('kanna_cli_path = "/tmp/repo/.build/debug/kanna-cli"');
    expect(lines).toContain('desktop_id = "remote-e2e-staging-test"');
    expect(lines).toContain('version = "0.0.69-staging.1"');
    expect(lines).toContain('environment = "staging"');
    expect(lines).toContain("transfer_port = 48130");
    expect(lines.some((line) => line.startsWith("server_version = "))).toBe(false);
    expect(lines).not.toContain("firebase_auth_emulator_url");
    expect(lines).not.toContain("firebase_firestore_emulator_host");
  });

  it("uses the harness-built kanna-cli sidecar for remote task creation", () => {
    expect(remoteHarnessKannaCliPath("/tmp/repo")).toMatch(/\/tmp\/repo\/\.build\/debug\/kanna-cli(?:\.exe)?$/);
  });

  it("provides zsh startup files so Linux CI does not block on zsh-newuser-install", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-remote-e2e-zsh-"));
    try {
      await writeRemoteHarnessZshStartupFiles(root);

      const zshEnv = await readFile(join(root, ".zshenv"), "utf8");
      expect(zshEnv).toContain("Remote E2E");
      expect(zshEnv).toContain("skip_global_compinit=1");
      expect(zshEnv).toContain("unsetopt GLOBAL_RCS");
      await expect(readFile(join(root, ".zprofile"), "utf8")).resolves.toContain("Remote E2E");
      await expect(readFile(join(root, ".zshrc"), "utf8")).resolves.toContain("Remote E2E");
      await expect(readFile(join(root, ".zlogin"), "utf8")).resolves.toContain("Remote E2E");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
