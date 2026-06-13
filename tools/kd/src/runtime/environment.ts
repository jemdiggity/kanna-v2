export type KdEnvironmentName = "dev" | "staging" | "prod";
export type CloudEnvironmentName = "staging" | "production";

export interface KdEnvironmentIdentity {
  name: KdEnvironmentName;
  firebaseProjectId: string;
  iosBundleId: string;
  relayUrl: string;
  relayDomain?: string;
  gceVmName?: string;
  artifactRegistryImage?: string;
  /**
   * Reserved static external IP resource name in GCP. Explicit per env so it
   * matches the actual reservation (prod `kanna-relay-ip`, staging
   * `relay-staging-ip`) rather than being derived from the VM name.
   */
  staticIpName?: string;
}

const environmentRegistry: Record<KdEnvironmentName, KdEnvironmentIdentity> = {
  dev: {
    name: "dev",
    firebaseProjectId: "kanna-local",
    iosBundleId: "build.kanna.app.dev",
    relayUrl: "ws://127.0.0.1:9080"
  },
  staging: {
    name: "staging",
    firebaseProjectId: "kanna-staging",
    iosBundleId: "build.kanna.app.staging",
    relayUrl: "wss://relay-staging.kanna.build",
    relayDomain: "relay-staging.kanna.build",
    gceVmName: "kanna-relay-staging",
    artifactRegistryImage: "us-central1-docker.pkg.dev/kanna-staging/kanna-relay/relay:latest",
    staticIpName: "relay-staging-ip"
  },
  prod: {
    name: "prod",
    firebaseProjectId: "kanna-build",
    iosBundleId: "build.kanna.app",
    relayUrl: "wss://relay.kanna.build",
    relayDomain: "relay.kanna.build",
    gceVmName: "kanna-relay-vm",
    artifactRegistryImage: "us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest",
    staticIpName: "kanna-relay-ip"
  }
};

export function resolveKdEnvironment(name: KdEnvironmentName): KdEnvironmentIdentity {
  return environmentRegistry[name];
}

export function cloudEnvironmentToKdEnvironment(environment: CloudEnvironmentName): KdEnvironmentName {
  return environment === "production" ? "prod" : "staging";
}

export function resolveCloudRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cloudEnv = env.KANNA_CLOUD_ENV?.trim();
  if (cloudEnv !== "staging" && cloudEnv !== "production" && cloudEnv !== "prod") {
    return { ...env };
  }

  const identity = resolveKdEnvironment(cloudEnv === "staging" ? "staging" : "prod");
  return {
    ...env,
    KANNA_FIREBASE_PROJECT_ID: env.KANNA_FIREBASE_PROJECT_ID ?? identity.firebaseProjectId,
    KANNA_RELAY_URL: env.KANNA_RELAY_URL ?? identity.relayUrl
  };
}
