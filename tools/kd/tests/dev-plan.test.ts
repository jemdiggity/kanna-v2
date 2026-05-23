import { describe, expect, it } from "vitest";
import { buildDevPlan } from "../src/runtime/dev-plan";

describe("buildDevPlan", () => {
  it("starts desktop only by default", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120"
      },
      mobile: false,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows.map((window) => window.name)).toEqual(["desktop"]);
    expect(plan.windows[0]?.cwd).toBe("/repo/apps/desktop");
    expect(plan.windows[0]?.command).toContain("pnpm run build:sidecars");
  });

  it("starts emulators before desktop and mobile when requested", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_RELAY_PORT: "9081",
        KANNA_MOBILE_PORT: "8082"
      },
      mobile: true,
      emulators: true,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://192.168.1.5:48120"
    });

    expect(plan.windows.map((window) => window.name)).toEqual(["emulators", "relay", "desktop", "mobile"]);
    expect(plan.windows[0]?.command).toContain("pnpm --dir services/firebase-functions build");
    expect(plan.windows[0]?.command).toContain("firebase emulators:start");
    expect(plan.windows[1]?.cwd).toBe("/repo/services/relay");
    expect(plan.windows[1]?.env.PORT).toBe("9081");
    expect(plan.windows[1]?.env.SKIP_AUTH).toBe("true");
    expect(plan.windows[1]?.command).toContain("PORT=9081 SKIP_AUTH=true pnpm run dev");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_KANNA_SERVER_URL=http://192.168.1.5:48120");
    expect(plan.windows[3]?.command).toContain("RCT_METRO_PORT=8082");
    expect(plan.windows[3]?.command).toContain("unset NO_COLOR;");
  });
});
