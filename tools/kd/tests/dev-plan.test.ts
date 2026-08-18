import { describe, expect, it } from "vitest";
import { buildDevPlan, buildProductionMobilePlan } from "../src/runtime/dev-plan";

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

  it("prefixes desktop command with E2E agent override environment", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_E2E_REAL_AGENT_PROVIDER: "opencode",
        KANNA_E2E_REAL_AGENT_MODEL: "opencode/big-pickle",
      },
      mobile: false,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows[0]?.command).toContain("KANNA_E2E_REAL_AGENT_PROVIDER='opencode'");
    expect(plan.windows[0]?.command).toContain("KANNA_E2E_REAL_AGENT_MODEL='opencode/big-pickle'");
    expect(plan.windows[0]?.command).toContain("pnpm run build:sidecars");
  });

  it("shell-quotes desktop E2E environment values with shell metacharacters", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_E2E_AGENT_CLI_VERSION_CLAUDE: "2.1.118 (Claude Code)\n",
      },
      mobile: false,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows[0]?.command).toContain(
      "KANNA_E2E_AGENT_CLI_VERSION_CLAUDE='2.1.118 (Claude Code)\n'",
    );
    expect(plan.windows[0]?.command).toContain("pnpm run build:sidecars");
  });

  it("shell-quotes E2E agent override environment values", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_E2E_AGENT_CLI_VERSION_CLAUDE: "2.1.118 (Claude Code)\n",
        KANNA_E2E_AGENT_CLI_VERSION_COPILOT: "GitHub Copilot CLI 1.0.32.\nRun 'copilot update' to check for updates.\n",
      },
      mobile: false,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows[0]?.command).toContain("KANNA_E2E_AGENT_CLI_VERSION_CLAUDE='2.1.118 (Claude Code)");
    expect(plan.windows[0]?.command).toContain(`KANNA_E2E_AGENT_CLI_VERSION_COPILOT='GitHub Copilot CLI 1.0.32.
Run '\\''copilot update'\\'' to check for updates.
'`);
  });

  it("starts emulators before desktop and mobile when requested", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_FIREBASE_AUTH_PORT: "9100",
        KANNA_FIREBASE_FIRESTORE_PORT: "9101",
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
    expect(plan.windows[0]?.command).toContain("--import '/repo/services/firebase/emulator-seed'");
    expect(plan.windows[1]?.cwd).toBe("/repo/services/relay");
    expect(plan.windows[1]?.env.PORT).toBe("9081");
    expect(plan.windows[1]?.env.FIREBASE_PROJECT_ID).toBe("kanna-local");
    expect(plan.windows[1]?.env.FIREBASE_AUTH_EMULATOR_HOST).toBe("127.0.0.1:9100");
    expect(plan.windows[1]?.env.FIRESTORE_EMULATOR_HOST).toBe("127.0.0.1:9101");
    expect(plan.windows[1]?.command).toContain(
      "PORT='9081' FIREBASE_PROJECT_ID='kanna-local' FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9100' FIRESTORE_EMULATOR_HOST='127.0.0.1:9101' pnpm run dev"
    );
    expect(plan.windows[3]?.command).not.toContain("EXPO_PUBLIC_KANNA_SERVER_URL");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='ws://192.168.1.5:9081'");
    expect(plan.windows[3]?.command).toContain("RCT_METRO_PORT='8082'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_API_KEY='kanna-local'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-local'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_APP_ID='kanna-mobile-local'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST='192.168.1.5'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT='9100'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST='192.168.1.5'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT='9101'");
    expect(plan.windows[3]?.command).toContain("unset NO_COLOR;");
    expect(plan.windows[3]?.command).toContain("pnpm run dev -- --port 8082 --dev-client");
  });

  it("keeps desktop auto sign-in secrets on the desktop env only", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_CLOUD_ENV: "staging",
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_MOBILE_PORT: "8082"
      },
      desktopSecretEnv: {
        KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL: "dev@example.com",
        KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD: "do-not-print"
      },
      mobile: true,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows.map((window) => window.name)).toEqual(["desktop", "mobile"]);
    // Without this the mobile window starts Metro with KANNA_APP_ENV unset and
    // Expo config resolution throws.
    expect(plan.windows[1]?.command).toContain("KANNA_APP_ENV='dev'");
    expect(plan.windows[0]?.env.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL).toBe("dev@example.com");
    expect(plan.windows[0]?.env.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD).toBe("do-not-print");
    expect(plan.windows[1]?.env.KANNA_DESKTOP_AUTO_SIGN_IN_EMAIL).toBeUndefined();
    expect(plan.windows[1]?.env.KANNA_DESKTOP_AUTO_SIGN_IN_PASSWORD).toBeUndefined();
    expect(plan.windows.map((window) => window.command).join("\n")).not.toContain("do-not-print");
    expect(plan.windows.map((window) => window.command).join("\n")).not.toContain("dev@example.com");
  });

  it("keeps the mobile Metro window alive for physical-device sessions", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_MOBILE_PORT: "8082",
        KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
      },
      mobile: true,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120",
      resolveLanAddress: () => "172.16.0.193"
    });

    expect(plan.windows[1]?.command).toContain("REACT_NATIVE_PACKAGER_HOSTNAME='172.16.0.193'");
    expect(plan.windows[1]?.command).toContain("while true; do");
    expect(plan.windows[1]?.command).toContain("pnpm run dev -- --port 8082 --dev-client");
    expect(plan.windows[1]?.command).toContain("sleep 2");
  });

  it("uses the Mac LAN host for physical-device mobile dev endpoints", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_FIREBASE_AUTH_PORT: "9100",
        KANNA_FIREBASE_FIRESTORE_PORT: "9101",
        KANNA_RELAY_PORT: "9081",
        KANNA_MOBILE_PORT: "8082",
        KANNA_IOS_DEVICE_UDID: "00008130-001015CA1091401C"
      },
      mobile: true,
      emulators: true,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120",
      resolveLanAddress: () => "172.16.0.193"
    });

    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_KANNA_SERVER_URL='http://172.16.0.193:48120'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='ws://172.16.0.193:9081'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST='172.16.0.193'");
    expect(plan.windows[3]?.command).toContain("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST='172.16.0.193'");
  });

  it("does not point mobile auth at local emulators unless emulators are running", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_FIREBASE_AUTH_PORT: "9100",
        KANNA_RELAY_PORT: "9081",
        KANNA_MOBILE_PORT: "8082"
      },
      mobile: true,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://192.168.1.5:48120"
    });

    expect(plan.windows.map((window) => window.name)).toEqual(["desktop", "mobile"]);
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_KANNA_RELAY_URL");
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_API_KEY=kanna-local");
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST");
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT");
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST");
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT");
  });

  it("allows an explicit production relay override without enabling emulators", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_FIREBASE_AUTH_PORT: "9100",
        KANNA_RELAY_PORT: "9081",
        KANNA_MOBILE_PORT: "8082",
        EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay.example"
      },
      mobile: true,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://192.168.1.5:48120"
    });

    expect(plan.windows[1]?.command).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay.example'");
    expect(plan.windows[1]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST");
  });

  it("starts only mobile against the production desktop server", () => {
    const plan = buildProductionMobilePlan({
      repoRoot: "/repo",
      env: {
        KANNA_MOBILE_PORT: "8083",
        EXPO_PUBLIC_FIREBASE_PROJECT_ID: "kanna-prod",
        EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay.prod.example"
      },
      environment: "production"
    });

    expect(plan.windows.map((window) => window.name)).toEqual(["mobile"]);
    expect(plan.windows[0]?.cwd).toBe("/repo/apps/mobile");
    // Expo config resolution refuses to guess, so the window must name an
    // environment. "production" is kd's spelling of "prod"; app.config.ts and
    // mobile-device.ts both accept it as an alias.
    expect(plan.windows[0]?.command).toContain("KANNA_APP_ENV='production'");
    expect(plan.windows[0]?.command).not.toContain("EXPO_PUBLIC_KANNA_SERVER_URL");
    expect(plan.windows[0]?.command).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay.prod.example'");
    expect(plan.windows[0]?.command).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-prod'");
    expect(plan.windows[0]?.command).toContain("RCT_METRO_PORT='8083'");
    expect(plan.windows[0]?.command).toContain("pnpm run dev -- --port 8083 --dev-client");
    expect(plan.windows[0]?.command).not.toContain("EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST");
  });

  it("sets staging mobile cloud env from the kd registry", () => {
    const plan = buildProductionMobilePlan({
      repoRoot: "/repo",
      env: {
        KANNA_MOBILE_PORT: "8084",
        EXPO_PUBLIC_FIREBASE_API_KEY: "staging-api-key",
        EXPO_PUBLIC_FIREBASE_APP_ID: "staging-app-id"
      },
      environment: "staging"
    });

    expect(plan.windows[0]?.command).toContain("KANNA_APP_ENV='staging'");
    expect(plan.windows[0]?.command).toContain("EXPO_PUBLIC_KANNA_RELAY_URL='wss://relay-staging.kanna.build'");
    expect(plan.windows[0]?.command).toContain("EXPO_PUBLIC_FIREBASE_PROJECT_ID='kanna-staging'");
    expect(plan.windows[0]?.command).toContain("EXPO_PUBLIC_FIREBASE_API_KEY='staging-api-key'");
    expect(plan.windows[0]?.command).toContain("RCT_METRO_PORT='8084'");
  });

  it("passes a staging KANNA_APP_ENV through to the dev-up mobile window", () => {
    // The registry's staging branch sets this on the env it hands the plan.
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_APP_ENV: "staging",
        KANNA_MOBILE_SERVER_PORT: "48120",
        KANNA_MOBILE_PORT: "8082"
      },
      mobile: true,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows[1]?.command).toContain("KANNA_APP_ENV='staging'");
    expect(plan.windows[1]?.command).not.toContain("KANNA_APP_ENV='dev'");
  });

  it("exports staging desktop relay settings when KANNA_CLOUD_ENV is staging", () => {
    const plan = buildDevPlan({
      repoRoot: "/repo",
      env: {
        KANNA_CLOUD_ENV: "staging",
        KANNA_DEV_PORT: "1421",
        KANNA_DB_PATH: "/tmp/kanna.db",
        KANNA_MOBILE_SERVER_PORT: "48120"
      },
      mobile: false,
      emulators: false,
      firebaseConfigPath: "/repo/.firebase-8080.kanna.json",
      mobileServerUrl: "http://127.0.0.1:48120"
    });

    expect(plan.windows[0]?.env.KANNA_FIREBASE_PROJECT_ID).toBe("kanna-staging");
    expect(plan.windows[0]?.env.KANNA_RELAY_URL).toBe("wss://relay-staging.kanna.build");
  });
});
