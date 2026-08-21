import { describe, expect, it, vi } from "vitest";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";

describe("resolveDesktopFirebaseConfig", () => {
  it("resolves the local portal from the workspace port", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async (name) => (name === "KANNA_WEB_PORTAL_PORT" ? "15173" : ""),
      dev: true,
    });

    expect(config.portalBaseUrl).toBe("http://127.0.0.1:15173");
  });

  it.each([
    ["staging", "https://kanna-staging-account.web.app"],
    ["production", "https://kanna-build-account.web.app"],
  ])("resolves the %s account portal", async (cloudEnv, expectedUrl) => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async (name) => (name === "KANNA_CLOUD_ENV" ? cloudEnv : ""),
      dev: true,
    });

    expect(config.portalBaseUrl).toBe(expectedUrl);
  });

  it("allows an explicit portal base URL override", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async (name) => ({
        KANNA_CLOUD_ENV: "staging",
        KANNA_PORTAL_BASE_URL: "https://portal.example.test/",
      })[name] ?? "",
      dev: true,
    });

    expect(config.portalBaseUrl).toBe("https://portal.example.test");
  });

  it("uses the workspace-provided auth emulator port", async () => {
    const readEnv = vi.fn(async (name: string) => {
      if (name === "KANNA_FIREBASE_AUTH_PORT") return "19100";
      return "";
    });

    const config = await resolveDesktopFirebaseConfig({ readEnv, dev: true });

    expect(readEnv).toHaveBeenCalledWith("KANNA_FIREBASE_AUTH_PORT");
    expect(config.authEmulator).toEqual({
      host: "127.0.0.1",
      port: 19100,
      url: "http://127.0.0.1:19100",
    });
  });

  it("does not configure the auth emulator when the workspace port is invalid", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async () => "not-a-port",
      dev: true,
    });

    expect(config.authEmulator).toBeNull();
    expect(config.firestoreEmulator).toBeNull();
    expect(config.functionsEndpoint).toBeNull();
  });

  it("provides local Firebase app config in dev", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async () => "",
      dev: true,
    });

    expect(config.app).toEqual({
      apiKey: "kanna-local",
      authDomain: "kanna-local.firebaseapp.com",
      projectId: "kanna-local",
      appId: "kanna-desktop-local",
    });
  });

  it("provides production Firebase app config outside dev", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async () => "",
      dev: false,
    });

    expect(config.app).toEqual({
      apiKey: "AIzaSyCi-PNR-oVOXjEKGJvDOF6wM-1J3Fd3U4k",
      authDomain: "kanna-build.firebaseapp.com",
      projectId: "kanna-build",
      storageBucket: "kanna-build.firebasestorage.app",
      messagingSenderId: "402613185450",
      appId: "1:402613185450:web:252b2c98d1ef13bed859d3",
      measurementId: "G-091WQZN4SS",
    });
  });

  it("uses the staging Firebase app profile when KANNA_CLOUD_ENV is staging", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async (name) => (name === "KANNA_CLOUD_ENV" ? "staging" : ""),
      dev: false,
    });

    expect(config.app).toEqual({
      apiKey: "AIzaSyCWjrhJDZobI1LUwL70ACSZg_GewcYnn3Q",
      authDomain: "kanna-staging.firebaseapp.com",
      projectId: "kanna-staging",
      storageBucket: "kanna-staging.firebasestorage.app",
      messagingSenderId: "1073113006696",
      appId: "1:1073113006696:web:3bca4e7586f5587e1c71dd",
      measurementId: "G-BZNH6TMDCK",
    });
  });

  it("ignores leaked emulator ports when cloud env is staging", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: true,
      readEnv: async (name) =>
        ({
          KANNA_CLOUD_ENV: "staging",
          KANNA_FIREBASE_AUTH_PORT: "9396",
          KANNA_FIREBASE_FIRESTORE_PORT: "8391",
          KANNA_FIREBASE_PROJECT_ID: "kanna-staging",
        })[name] ?? "",
    });

    expect(config.authEmulator).toBeNull();
    expect(config.firestoreEmulator).toBeNull();
    expect(config.app?.projectId).toBe("kanna-staging");
  });

  it("ignores leaked emulator ports when cloud env is production", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: true,
      readEnv: async (name) =>
        ({
          KANNA_CLOUD_ENV: "production",
          KANNA_FIREBASE_AUTH_PORT: "9100",
        })[name] ?? "",
    });

    expect(config.authEmulator).toBeNull();
    expect(config.app).toMatchObject({
      projectId: "kanna-build",
      authDomain: "kanna-build.firebaseapp.com",
    });
  });

  it("lets explicit runtime app config override the cloud-env defaults", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: false,
      readEnv: async (name) =>
        ({
          KANNA_CLOUD_ENV: "staging",
          KANNA_FIREBASE_API_KEY: "runtime-key",
          KANNA_FIREBASE_PROJECT_ID: "runtime-project",
          KANNA_FIREBASE_APP_ID: "runtime-app-id",
        })[name] ?? "",
    });

    expect(config.authEmulator).toBeNull();
    expect(config.app).toMatchObject({
      apiKey: "runtime-key",
      projectId: "runtime-project",
      appId: "runtime-app-id",
    });
  });

  it("does not configure a task snapshot function outside dev", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async () => "",
      dev: false,
    });

    expect(config.functionsEndpoint).toBeNull();
  });

  it("uses the workspace-provided firestore port", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async (name) => {
        if (name === "KANNA_FIREBASE_FIRESTORE_PORT") return "18081";
        return "";
      },
      dev: true,
    });

    expect(config.firestoreEmulator).toEqual({
      host: "127.0.0.1",
      port: 18081,
      url: "http://127.0.0.1:18081",
    });
    expect(config.functionsEndpoint).toBeNull();
  });

  it("uses runtime Firebase app config overrides when provided under a remote cloud env", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: false,
      readEnv: async (name) => ({
        KANNA_CLOUD_ENV: "staging",
        KANNA_FIREBASE_API_KEY: "runtime-key",
        KANNA_FIREBASE_AUTH_DOMAIN: "runtime.firebaseapp.com",
        KANNA_FIREBASE_PROJECT_ID: "runtime-project",
        KANNA_FIREBASE_APP_ID: "runtime-app-id",
        KANNA_CLOUD_FUNCTIONS_ENDPOINT: "https://runtime.example/createPairingCode",
      })[name] ?? "",
    });

    expect(config.app).toMatchObject({
      apiKey: "runtime-key",
      authDomain: "runtime.firebaseapp.com",
      projectId: "runtime-project",
      appId: "runtime-app-id",
    });
    expect(config.functionsEndpoint).toBeNull();
  });

  it("keeps explicit runtime function endpoints available in local tests", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: true,
      readEnv: async (name) => ({
        KANNA_FIREBASE_FUNCTIONS_PORT: "15002",
        KANNA_CLOUD_FUNCTIONS_ENDPOINT: "https://runtime.example/createPairingCode",
      })[name] ?? "",
    });

    expect(config.functionsEndpoint).toBe("https://runtime.example/createPairingCode");
  });

  it.each(["production", "staging", " Production "])(
    "ignores emulator pointers when KANNA_CLOUD_ENV is %s",
    async (cloudEnv) => {
      const config = await resolveDesktopFirebaseConfig({
        dev: true,
        readEnv: async (name) => ({
          KANNA_CLOUD_ENV: cloudEnv,
          KANNA_FIREBASE_AUTH_PORT: "9099",
          KANNA_FIREBASE_FIRESTORE_PORT: "8080",
          KANNA_CLOUD_FUNCTIONS_ENDPOINT: "http://127.0.0.1:5001/legacy",
        })[name] ?? "",
      });

      expect(config.authEmulator).toBeNull();
      expect(config.firestoreEmulator).toBeNull();
      expect(config.functionsEndpoint).toBeNull();
    },
  );

  it("falls back to the production app config in dev when KANNA_CLOUD_ENV is production", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: true,
      readEnv: async (name) => (name === "KANNA_CLOUD_ENV" ? "production" : ""),
    });

    expect(config.app).toMatchObject({ projectId: "kanna-build" });
  });

  it("prefers runtime app config overrides under a remote cloud env", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: true,
      readEnv: async (name) => ({
        KANNA_CLOUD_ENV: "staging",
        KANNA_FIREBASE_API_KEY: "staging-key",
        KANNA_FIREBASE_PROJECT_ID: "kanna-staging",
        KANNA_FIREBASE_APP_ID: "staging-app-id",
      })[name] ?? "",
    });

    expect(config.app).toMatchObject({ projectId: "kanna-staging" });
  });

  it("still configures emulators when KANNA_CLOUD_ENV is unset or local", async () => {
    const config = await resolveDesktopFirebaseConfig({
      dev: true,
      readEnv: async (name) => ({
        KANNA_CLOUD_ENV: "local",
        KANNA_FIREBASE_AUTH_PORT: "19100",
      })[name] ?? "",
    });

    expect(config.authEmulator).toMatchObject({ port: 19100 });
  });
});
