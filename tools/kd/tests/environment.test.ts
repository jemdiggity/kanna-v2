import { describe, expect, it } from "vitest";
import {
  applyEnvironmentProfile,
  cloudEnvironmentToKdEnvironment,
  resolveEnvironmentProfile,
  resolveCloudRuntimeEnv,
  resolveKdEnvironment
} from "../src/runtime/environment";

describe("kd environment registry", () => {
  it("resolves the supported development profiles across three explicit axes", () => {
    expect(resolveEnvironmentProfile({ command: "dev", cloud: "staging" })).toEqual({
      clientBuild: "dev",
      desktopOwner: "worktree",
      cloud: "staging"
    });
    expect(resolveEnvironmentProfile({ command: "mobile", build: "dev", owner: "staging" })).toEqual({
      clientBuild: "dev",
      desktopOwner: "staging",
      cloud: "staging"
    });
    expect(resolveEnvironmentProfile({ command: "mobile", staging: true })).toEqual({
      clientBuild: "staging",
      desktopOwner: "staging",
      cloud: "staging"
    });
  });

  it("rejects incoherent profiles and keeps production behind its compatibility guard", () => {
    expect(() => resolveEnvironmentProfile({
      command: "mobile",
      build: "staging",
      owner: "worktree",
      cloud: "staging"
    })).toThrow("Unsupported mobile profile");
    expect(() => resolveEnvironmentProfile({
      command: "mobile",
      build: "production",
      owner: "production",
      cloud: "production"
    })).toThrow("Production mobile targeting remains guarded");
    expect(() => resolveEnvironmentProfile({
      command: "dev",
      build: "dev",
      owner: "staging",
      cloud: "staging"
    })).toThrow("Desktop development supports build=dev, owner=worktree");
  });

  it("applies staging cloud settings without changing the dev client identity", () => {
    const env = applyEnvironmentProfile(
      {
        EXPO_PUBLIC_FIREBASE_APP_ID: "inherited-production-app",
        EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1"
      },
      {
        clientBuild: "dev",
        desktopOwner: "staging",
        cloud: "staging"
      }
    );
    expect(env).toMatchObject({
      KANNA_APP_ENV: "dev",
      KANNA_DESKTOP_OWNER_ENV: "staging",
      KANNA_CLOUD_ENV: "staging",
      EXPO_PUBLIC_KANNA_CLOUD_ENV: "staging",
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: "kanna-staging",
      EXPO_PUBLIC_KANNA_RELAY_URL: "wss://relay-staging.kanna.build"
    });
    expect(env.EXPO_PUBLIC_FIREBASE_APP_ID).toBeUndefined();
    expect(env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
  });

  it("keeps confirmed dev, staging, and production identities in one registry", () => {
    expect(resolveKdEnvironment("dev")).toMatchObject({
      name: "dev",
      firebaseProjectId: "kanna-local",
      iosBundleId: "build.kanna.app.dev",
      relayUrl: "ws://127.0.0.1:9080"
    });
    expect(resolveKdEnvironment("staging")).toMatchObject({
      name: "staging",
      firebaseProjectId: "kanna-staging",
      iosBundleId: "build.kanna.app.staging",
      relayDomain: "relay-staging.kanna.build",
      relayUrl: "wss://relay-staging.kanna.build",
      gceVmName: "kanna-relay-staging",
      artifactRegistryImage: "us-central1-docker.pkg.dev/kanna-staging/kanna-relay/relay:latest"
    });
    expect(resolveKdEnvironment("prod")).toMatchObject({
      name: "prod",
      firebaseProjectId: "kanna-build",
      iosBundleId: "build.kanna.app",
      relayDomain: "relay.kanna.build",
      relayUrl: "wss://relay.kanna.build",
      gceVmName: "kanna-relay-vm",
      artifactRegistryImage: "us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest"
    });
  });

  it("maps existing cloud command environment names onto the registry names", () => {
    expect(cloudEnvironmentToKdEnvironment("staging")).toBe("staging");
    expect(cloudEnvironmentToKdEnvironment("production")).toBe("prod");
  });

  it("exports staging desktop and server cloud environment defaults from KANNA_CLOUD_ENV", () => {
    expect(resolveCloudRuntimeEnv({ KANNA_CLOUD_ENV: "staging" })).toMatchObject({
      KANNA_FIREBASE_PROJECT_ID: "kanna-staging",
      KANNA_RELAY_URL: "wss://relay-staging.kanna.build"
    });
  });

  it("strips local Firebase emulator host/port env vars in cloud environments", () => {
    const resolved = resolveCloudRuntimeEnv({
      KANNA_CLOUD_ENV: "staging",
      KANNA_FIREBASE_AUTH_PORT: "9396",
      KANNA_FIREBASE_FIRESTORE_PORT: "8391",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9396",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8391"
    });

    expect(resolved.KANNA_FIREBASE_AUTH_PORT).toBeUndefined();
    expect(resolved.KANNA_FIREBASE_FIRESTORE_PORT).toBeUndefined();
    expect(resolved.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
    expect(resolved.FIRESTORE_EMULATOR_HOST).toBeUndefined();
  });

  it("preserves Firebase emulator env vars when not in a cloud environment", () => {
    const resolved = resolveCloudRuntimeEnv({
      KANNA_FIREBASE_AUTH_PORT: "9100",
      KANNA_FIREBASE_FIRESTORE_PORT: "8081"
    });

    expect(resolved.KANNA_FIREBASE_AUTH_PORT).toBe("9100");
    expect(resolved.KANNA_FIREBASE_FIRESTORE_PORT).toBe("8081");
  });
});
