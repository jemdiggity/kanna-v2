import { describe, expect, it } from "vitest";
import { parseMobileFirebaseConfig } from "./config";

describe("parseMobileFirebaseConfig", () => {
  it("reads Firebase app config from Expo public env", () => {
    const config = parseMobileFirebaseConfig({
      EXPO_PUBLIC_FIREBASE_API_KEY: "api-key",
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: "kanna-local.firebaseapp.com",
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: "kanna-local",
      EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: "kanna-local.appspot.com",
      EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "sender-1",
      EXPO_PUBLIC_FIREBASE_APP_ID: "app-1",
      EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID: "measure-1"
    });

    expect(config).toEqual({
      app: {
        apiKey: "api-key",
        authDomain: "kanna-local.firebaseapp.com",
        projectId: "kanna-local",
        storageBucket: "kanna-local.appspot.com",
        messagingSenderId: "sender-1",
        appId: "app-1",
        measurementId: "measure-1"
      },
      authEmulator: null
    });
  });

  it("uses the production Firebase app config when no Expo public env is present", () => {
    const config = parseMobileFirebaseConfig({});

    expect(config.app).toEqual({
      apiKey: "AIzaSyCi-PNR-oVOXjEKGJvDOF6wM-1J3Fd3U4k",
      authDomain: "kanna-build.firebaseapp.com",
      projectId: "kanna-build",
      storageBucket: "kanna-build.firebasestorage.app",
      messagingSenderId: "402613185450",
      appId: "1:402613185450:web:252b2c98d1ef13bed859d3",
      measurementId: "G-091WQZN4SS"
    });
  });

  it("uses the staging Firebase app profile when EXPO_PUBLIC_KANNA_CLOUD_ENV is staging", () => {
    const config = parseMobileFirebaseConfig({
      EXPO_PUBLIC_KANNA_CLOUD_ENV: "staging"
    });

    expect(config.app).toEqual({
      apiKey: "AIzaSyCWjrhJDZobI1LUwL70ACSZg_GewcYnn3Q",
      authDomain: "kanna-staging.firebaseapp.com",
      projectId: "kanna-staging",
      storageBucket: "kanna-staging.firebasestorage.app",
      messagingSenderId: "1073113006696",
      appId: "1:1073113006696:web:3bca4e7586f5587e1c71dd",
      measurementId: "G-BZNH6TMDCK"
    });
  });

  it("uses explicit Expo Firebase env over the staging profile", () => {
    const config = parseMobileFirebaseConfig({
      EXPO_PUBLIC_KANNA_CLOUD_ENV: "staging",
      EXPO_PUBLIC_FIREBASE_API_KEY: "override-key",
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: "override.firebaseapp.com",
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: "override-project",
      EXPO_PUBLIC_FIREBASE_APP_ID: "override-app"
    });

    expect(config.app).toMatchObject({
      apiKey: "override-key",
      authDomain: "override.firebaseapp.com",
      projectId: "override-project",
      appId: "override-app"
    });
  });

  it("parses an auth emulator URL from host and port env vars", () => {
    const config = parseMobileFirebaseConfig({
      EXPO_PUBLIC_FIREBASE_API_KEY: "api-key",
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: "kanna-local.firebaseapp.com",
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: "kanna-local",
      EXPO_PUBLIC_FIREBASE_APP_ID: "app-1",
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1",
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: "9099"
    });

    expect(config.authEmulator).toEqual({
      host: "127.0.0.1",
      port: 9099,
      url: "http://127.0.0.1:9099"
    });
  });

  it("ignores an invalid auth emulator port", () => {
    const config = parseMobileFirebaseConfig({
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1",
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: "invalid"
    });

    expect(config.authEmulator).toBeNull();
  });

  it("keeps emulator app config local when emulator env vars are present", () => {
    const config = parseMobileFirebaseConfig({
      EXPO_PUBLIC_FIREBASE_API_KEY: "kanna-local",
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: "kanna-local.firebaseapp.com",
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: "kanna-local",
      EXPO_PUBLIC_FIREBASE_APP_ID: "kanna-mobile-local",
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1",
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: "9099"
    });

    expect(config.app).toEqual({
      apiKey: "kanna-local",
      authDomain: "kanna-local.firebaseapp.com",
      projectId: "kanna-local",
      appId: "kanna-mobile-local"
    });
  });
});
