import { describe, expect, it } from "vitest";
import {
  cloudEnvironmentToKdEnvironment,
  resolveCloudRuntimeEnv,
  resolveKdEnvironment
} from "../src/runtime/environment";

describe("kd environment registry", () => {
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
});
