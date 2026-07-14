import { describe, expect, it } from "vitest";
import {
  buildExpoStartCommand,
  extractEnvVarFromCommandLine,
  shouldReuseExpoServer
} from "./metro";

describe("mobile Metro helpers", () => {
  it("extracts Expo public env vars from a ps command line", () => {
    expect(
      extractEnvVarFromCommandLine(
        "node expo EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED=1 KANNA_MOBILE_PORT=8081"
      )
    ).toMatchObject({
      EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED: "1",
      KANNA_MOBILE_PORT: "8081"
    });
  });

  it("reuses an Expo server from the same project root", () => {
    expect(
      shouldReuseExpoServer(
        {
          commandLine: "node expo start EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED=1",
          cwd: "/tmp/kanna/apps/mobile"
        },
        {
          projectRoot: "/tmp/kanna/apps/mobile",
          env: { EXPO_PUBLIC_KANNA_ENABLE_E2E_TRUST_SEED: "1" }
        }
      )
    ).toBe(true);
  });

  it("does not reuse an Expo server with mismatched expected env vars", () => {
    expect(
      shouldReuseExpoServer(
        {
          commandLine: "node expo start EXPO_PUBLIC_KANNA_FORCE_CLOUD=0",
          cwd: "/tmp/kanna/apps/mobile"
        },
        {
          projectRoot: "/tmp/kanna/apps/mobile",
          env: { EXPO_PUBLIC_KANNA_FORCE_CLOUD: "1" }
        }
      )
    ).toBe(false);
  });

  it("reuses a kd-managed dev-client Metro even when ps does not expose inline env vars", () => {
    expect(
      shouldReuseExpoServer(
        {
          commandLine: "node expo start --port 1430 --dev-client",
          cwd: "/tmp/kanna/apps/mobile"
        },
        {
          projectRoot: "/tmp/kanna/apps/mobile",
          env: { KANNA_APP_ENV: "dev" }
        }
      )
    ).toBe(true);
  });

  it("does not reuse a dev-client Metro with unverified env in exact-environment mode", () => {
    expect(
      shouldReuseExpoServer(
        {
          commandLine: "node expo start --port 1430 --dev-client EXPO_PUBLIC_KANNA_FORCE_CLOUD=1",
          cwd: "/tmp/kanna/apps/mobile"
        },
        {
          projectRoot: "/tmp/kanna/apps/mobile",
          env: { EXPO_PUBLIC_KANNA_FORCE_CLOUD: "0" },
          requireExactEnvironment: true
        }
      )
    ).toBe(false);
  });

  it("does not reuse an Expo server from another project root", () => {
    expect(
      shouldReuseExpoServer(
        {
          commandLine: "node expo start",
          cwd: "/tmp/other/apps/mobile"
        },
        {
          projectRoot: "/tmp/kanna/apps/mobile"
        }
      )
    ).toBe(false);
  });

  it("builds a non-interactive Expo start command for the selected port", () => {
    expect(buildExpoStartCommand(1430)).toEqual([
      "pnpm",
      "exec",
      "expo",
      "start",
      "--port",
      "1430",
      "--dev-client"
    ]);
  });

  it("clears Metro's transform cache when runtime environment values must be exact", () => {
    expect(buildExpoStartCommand(1430, { clearCache: true })).toEqual([
      "pnpm",
      "exec",
      "expo",
      "start",
      "--port",
      "1430",
      "--dev-client",
      "--clear"
    ]);
  });
});
