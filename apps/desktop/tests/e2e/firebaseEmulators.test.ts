import { describe, expect, it } from "vitest";
import {
  buildFirebaseCommandEnv,
  buildFirebaseEmulatorCommand,
  buildFirebaseEmulatorConfig,
} from "../../../../tools/kd/src/runtime/firebase";

describe("firebase emulator runner helpers", () => {
  it("builds a direct Firebase command from the generated config path", () => {
    // The seed import is not optional: cloud real suites sign in against the
    // emulator accounts exported to services/firebase/emulator-seed.
    expect(buildFirebaseEmulatorCommand("/repo/.firebase-18080.kanna.json")).toEqual({
      command: "pnpm",
      args: [
        "exec",
        "firebase",
        "emulators:start",
        "--project",
        "kanna-local",
        "--config",
        "/repo/.firebase-18080.kanna.json",
        "--import",
        "/repo/services/firebase/emulator-seed",
      ],
    });
  });

  it("builds a Firebase emulator config from allocated ports", () => {
    expect(
      buildFirebaseEmulatorConfig({
        KANNA_FIREBASE_AUTH_PORT: 19099,
        KANNA_FIREBASE_FIRESTORE_PORT: 18080,
        KANNA_FIREBASE_FUNCTIONS_PORT: 15001,
        KANNA_FIREBASE_UI_PORT: 14000,
      }),
    ).toEqual({
      firestore: {
        rules: "firestore.rules",
      },
      functions: {
        source: "services/firebase-functions",
        runtime: "nodejs24",
      },
      emulators: {
        auth: { host: "0.0.0.0", port: 19099 },
        firestore: { host: "0.0.0.0", port: 18080 },
        functions: { host: "0.0.0.0", port: 15001 },
        ui: { enabled: true, host: "0.0.0.0", port: 14000 },
      },
    });
  });

  it("prepends available Java bins before the inherited PATH", () => {
    expect(
      buildFirebaseCommandEnv(
        "/repo",
        { PATH: "/usr/bin:/bin" },
        ["/opt/homebrew/opt/openjdk/bin"],
      ).PATH,
    ).toBe("/opt/homebrew/opt/openjdk/bin:/usr/bin:/bin");
  });
});
