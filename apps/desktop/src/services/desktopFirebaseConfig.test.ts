import { describe, expect, it, vi } from "vitest";
import { resolveDesktopFirebaseConfig } from "./desktopFirebaseConfig";

describe("resolveDesktopFirebaseConfig", () => {
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

  it("uses the production task snapshot function outside dev", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async () => "",
      dev: false,
    });

    expect(config.functionsEndpoint).toBe(
      "https://upserttasksnapshot-eyxfartmea-uc.a.run.app",
    );
  });

  it("uses workspace-provided firestore and functions ports", async () => {
    const config = await resolveDesktopFirebaseConfig({
      readEnv: async (name) => {
        if (name === "KANNA_FIREBASE_FIRESTORE_PORT") return "18081";
        if (name === "KANNA_FIREBASE_FUNCTIONS_PORT") return "15002";
        return "";
      },
      dev: true,
    });

    expect(config.firestoreEmulator).toEqual({
      host: "127.0.0.1",
      port: 18081,
      url: "http://127.0.0.1:18081",
    });
    expect(config.functionsEndpoint).toBe(
      "http://127.0.0.1:15002/kanna-local/us-central1/upsertTaskSnapshot",
    );
  });
});
