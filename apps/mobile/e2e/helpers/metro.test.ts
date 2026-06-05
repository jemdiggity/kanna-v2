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
          commandLine: "node expo start",
          cwd: "/tmp/kanna/apps/mobile"
        },
        {
          projectRoot: "/tmp/kanna/apps/mobile"
        }
      )
    ).toBe(true);
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
      "1430"
    ]);
  });
});
