export type KdEnvironmentName = "dev" | "staging" | "prod";
export type CloudEnvironmentName = "staging" | "production";
export type ClientBuildIdentity = "dev" | "staging" | "production";
export type DesktopOwnerEnvironment = "worktree" | "staging" | "production";
export type CloudTarget = "emulators" | "staging" | "production";

export interface KdEnvironmentProfile {
  clientBuild: ClientBuildIdentity;
  desktopOwner: DesktopOwnerEnvironment;
  cloud: CloudTarget;
}

export interface ResolveEnvironmentProfileInput {
  command: "dev" | "mobile";
  build?: string;
  owner?: string;
  cloud?: string;
  staging?: boolean;
  production?: boolean;
}

export interface KdEnvironmentIdentity {
  name: KdEnvironmentName;
  firebaseProjectId: string;
  iosBundleId: string;
  relayUrl: string;
  otaBucket?: string;
  otaChannel?: "staging" | "production";
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
    otaBucket: "kanna-staging.firebasestorage.app",
    otaChannel: "staging",
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
    otaBucket: "kanna-build.firebasestorage.app",
    otaChannel: "production",
    relayDomain: "relay.kanna.build",
    gceVmName: "kanna-relay-vm",
    artifactRegistryImage: "us-central1-docker.pkg.dev/kanna-build/kanna-relay/relay:latest",
    staticIpName: "kanna-relay-ip"
  }
};

function parseAxis<T extends string>(
  flag: string,
  value: string | undefined,
  values: readonly T[]
): T | undefined {
  if (value === undefined) return undefined;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`${flag} must be one of ${values.join(", ")}; got ${JSON.stringify(value)}.`);
}

function formatProfile(profile: KdEnvironmentProfile): string {
  return `build=${profile.clientBuild}, owner=${profile.desktopOwner}, cloud=${profile.cloud}`;
}

export function formatEnvironmentProfile(profile: KdEnvironmentProfile): string {
  return formatProfile(profile);
}

export function resolveEnvironmentProfile(
  input: ResolveEnvironmentProfileInput
): KdEnvironmentProfile {
  if (input.staging && input.production) {
    throw new Error("Only one compatibility environment flag may be used.");
  }
  const hasExplicitAxes =
    input.build !== undefined || input.owner !== undefined || input.cloud !== undefined;
  if (hasExplicitAxes && (input.staging || input.production)) {
    throw new Error("Do not combine --staging or --production with --build, --owner, or --cloud.");
  }

  if (input.production) {
    return { clientBuild: "production", desktopOwner: "production", cloud: "production" };
  }
  if (input.staging && input.command === "mobile") {
    return { clientBuild: "staging", desktopOwner: "staging", cloud: "staging" };
  }

  const clientBuild =
    parseAxis("--build", input.build, ["dev", "staging", "production"] as const) ?? "dev";
  const desktopOwner =
    parseAxis("--owner", input.owner, ["worktree", "staging", "production"] as const) ??
    (clientBuild === "staging"
      ? "staging"
      : clientBuild === "production"
        ? "production"
        : "worktree");
  const cloud =
    parseAxis("--cloud", input.cloud, ["emulators", "staging", "production"] as const) ??
    (input.staging || desktopOwner === "staging" || clientBuild === "staging"
      ? "staging"
      : desktopOwner === "production" || clientBuild === "production"
        ? "production"
        : "emulators");
  const profile = { clientBuild, desktopOwner, cloud } satisfies KdEnvironmentProfile;

  if (input.command === "dev") {
    if (clientBuild !== "dev" || desktopOwner !== "worktree" || cloud === "production") {
      throw new Error(
        `Unsupported desktop development profile (${formatProfile(profile)}). ` +
        "Desktop development supports build=dev, owner=worktree, cloud=emulators|staging."
      );
    }
    return profile;
  }

  const supported =
    (clientBuild === "dev" && desktopOwner === "worktree" && cloud === "emulators") ||
    (clientBuild === "dev" && desktopOwner === "staging" && cloud === "staging") ||
    (clientBuild === "staging" && desktopOwner === "staging" && cloud === "staging") ||
    (clientBuild === "production" && desktopOwner === "production" && cloud === "production");
  if (!supported) {
    throw new Error(
      `Unsupported mobile profile (${formatProfile(profile)}). Supported profiles are ` +
      "dev/worktree/emulators, dev/staging/staging, staging/staging/staging, and guarded production/production/production."
    );
  }
  if (clientBuild === "production" && !input.production) {
    throw new Error(
      "Production mobile targeting remains guarded; use the existing --production flag instead of explicit production axes."
    );
  }
  return profile;
}

export function applyEnvironmentProfile(
  env: NodeJS.ProcessEnv,
  profile: KdEnvironmentProfile
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = {
    ...env,
    KANNA_CLIENT_BUILD_ENV: profile.clientBuild,
    KANNA_DESKTOP_OWNER_ENV: profile.desktopOwner,
    KANNA_APP_ENV: profile.clientBuild === "production" ? "prod" : profile.clientBuild,
    EXPO_PUBLIC_KANNA_CLOUD_ENV: profile.cloud === "emulators" ? "local" : profile.cloud
  };
  for (const key of [
    "KANNA_FIREBASE_API_KEY",
    "KANNA_FIREBASE_AUTH_DOMAIN",
    "KANNA_FIREBASE_APP_ID",
    "KANNA_FIREBASE_STORAGE_BUCKET",
    "KANNA_FIREBASE_MESSAGING_SENDER_ID",
    "KANNA_FIREBASE_MEASUREMENT_ID",
    "EXPO_PUBLIC_FIREBASE_API_KEY",
    "EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN",
    "EXPO_PUBLIC_FIREBASE_APP_ID",
    "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
    "EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    "EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID"
  ]) {
    delete resolved[key];
  }
  if (profile.cloud === "emulators") {
    delete resolved.KANNA_CLOUD_ENV;
    delete resolved.KANNA_FIREBASE_PROJECT_ID;
    delete resolved.KANNA_RELAY_URL;
    delete resolved.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
    delete resolved.EXPO_PUBLIC_KANNA_RELAY_URL;
    return resolved;
  }

  delete resolved.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  delete resolved.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT;
  delete resolved.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST;
  delete resolved.EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT;

  resolved.KANNA_CLOUD_ENV = profile.cloud;
  const identity = resolveKdEnvironment(profile.cloud === "staging" ? "staging" : "prod");
  resolved.KANNA_FIREBASE_PROJECT_ID = identity.firebaseProjectId;
  resolved.KANNA_RELAY_URL = identity.relayUrl;
  resolved.EXPO_PUBLIC_KANNA_RELAY_URL = identity.relayUrl;
  resolved.EXPO_PUBLIC_FIREBASE_PROJECT_ID = identity.firebaseProjectId;
  return resolveCloudRuntimeEnv(resolved);
}

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
  const resolved: NodeJS.ProcessEnv = {
    ...env,
    KANNA_FIREBASE_PROJECT_ID: env.KANNA_FIREBASE_PROJECT_ID ?? identity.firebaseProjectId,
    KANNA_RELAY_URL: env.KANNA_RELAY_URL ?? identity.relayUrl
  };

  // Firebase emulators are a local-development concept. A process pointed at a
  // real cloud environment must not inherit emulator host/port env vars from
  // the workspace, or clients will try to reach a local emulator that isn't
  // running — Firebase Auth surfaces this as auth/network-request-failed.
  delete resolved.KANNA_FIREBASE_AUTH_PORT;
  delete resolved.KANNA_FIREBASE_FIRESTORE_PORT;
  delete resolved.FIREBASE_AUTH_EMULATOR_HOST;
  delete resolved.FIRESTORE_EMULATOR_HOST;

  return resolved;
}
