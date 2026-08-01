import { join } from "node:path";

export const KACHE_VERSION = "0.12.0";
export const KACHE_RELEASE_BASE_URL = "https://github.com/kunobi-ninja/kache/releases/download";

/**
 * Pinned per-architecture release assets. Kanna never discovers a cache binary
 * from PATH and never bootstraps one on a release critical path: the exact
 * archive and its SHA-256 are committed here so an unexpected upstream change
 * fails the checksum instead of silently entering the compiler.
 */
export interface KacheArtifact {
  target: string;
  asset: string;
  sha256: string;
}

export const KACHE_ARTIFACTS: Record<string, KacheArtifact> = {
  arm64: {
    target: "aarch64-apple-darwin",
    asset: "kache-aarch64-apple-darwin.tar.gz",
    sha256: "a425cfc46792e0c0eec45cde87000709ef8bab99c7980353bc9c7f3ab702503c"
  },
  x64: {
    target: "x86_64-apple-darwin",
    asset: "kache-x86_64-apple-darwin.tar.gz",
    sha256: "7e3f6f6e4eb67a68ee4891e1808e6c30e13cc460d8a074a76379019f393eeef1"
  }
};

/**
 * Upstream defaults to 50 GiB, which is too large once Kanna imports several
 * repositories and each gets its own store.
 */
export const KACHE_MAX_SIZE = "10GiB";

/**
 * Cargo wrapper and cache variables that must never survive into a release,
 * signing, packaging, or Bazel invocation.
 */
export const RUST_CACHE_ENVIRONMENT_KEYS = [
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_INCREMENTAL"
] as const;

export interface KachePaths {
  version: string;
  versionRoot: string;
  binary: string;
}

export function resolveKachePaths(homeDir: string): KachePaths {
  const versionRoot = join(homeDir, "Library", "Caches", "kanna", "tools", "kache", KACHE_VERSION);
  return {
    version: KACHE_VERSION,
    versionRoot,
    binary: join(versionRoot, "bin", "kache")
  };
}

export function resolveKacheArtifact(arch: string): KacheArtifact | undefined {
  return KACHE_ARTIFACTS[arch];
}

export function resolveKacheDownloadUrl(artifact: KacheArtifact): string {
  return `${KACHE_RELEASE_BASE_URL}/v${KACHE_VERSION}/${artifact.asset}`;
}

/**
 * One content store per repository. A global store is theoretically safe when
 * keys are correct, but per-repository scope keeps attribution, capping, and
 * rollback simple, and stops one imported repository evicting another.
 */
export function resolveRustCacheStore(homeDir: string, repositoryId: string): string {
  return join(homeDir, "Library", "Caches", "kanna", "rust-kache", repositoryId);
}

export function parseRustCacheMode(value: string | undefined): {
  enabled: boolean;
  warning?: string;
} {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "on" || normalized === "kache") {
    return { enabled: true };
  }
  if (normalized === "off") return { enabled: false };
  return {
    enabled: false,
    warning: `Unknown KANNA_RUST_CACHE value ${JSON.stringify(value)}; cache disabled.`
  };
}

export type RustCacheEligibility =
  | { enabled: true }
  | {
      enabled: false;
      category: "disabled" | "invalid-mode" | "unsupported-platform" | "disabled-in-ci";
      warning?: string;
    };

export function resolveRustCacheEligibility(input: {
  mode: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
  ci: string | undefined;
}): RustCacheEligibility {
  const mode = parseRustCacheMode(input.mode);
  if (!mode.enabled) {
    return mode.warning
      ? { enabled: false, category: "invalid-mode", warning: mode.warning }
      : { enabled: false, category: "disabled" };
  }
  if (input.platform !== "darwin" || !resolveKacheArtifact(input.arch)) {
    return { enabled: false, category: "unsupported-platform" };
  }
  if (input.ci?.trim()) {
    return { enabled: false, category: "disabled-in-ci" };
  }
  return { enabled: true };
}

export interface RustCacheEnvironmentInput {
  binary: string;
  store: string;
}

/**
 * Kache compiles hermetically: it strips `-C incremental` from every invocation
 * it handles, so Cargo is told the same thing rather than being left to record
 * incremental fingerprints that rustc never honours.
 *
 * `KACHE_VERIFY_RESTORES=always` is a deliberate rollout safeguard, not a
 * steady-state requirement. During adoption a `./kd test rust` run linked a
 * `kanna-runtime-defaults` rlib that predated the commit moving `session_id`
 * into that crate; it did not reproduce from a cold tree and the mechanism was
 * never identified. A silently wrong restore is the one failure this cache must
 * never have, so restores are hash-verified — and mismatches quarantined —
 * until there is evidence to relax it.
 */
export function buildRustCacheEnvironment(input: RustCacheEnvironmentInput): Record<string, string> {
  return {
    RUSTC_WRAPPER: input.binary,
    CARGO_INCREMENTAL: "0",
    KACHE_CACHE_DIR: input.store,
    KACHE_LOCAL_ONLY: "1",
    KACHE_CACHE_EXECUTABLES: "0",
    KACHE_VERIFY_RESTORES: "always",
    KACHE_MAX_SIZE
  };
}

/**
 * Removes every Kanna-managed compiler cache variable, plus any `KACHE_*`
 * inherited from the caller's shell, so a release build cannot be steered by an
 * ambient wrapper.
 */
export function stripRustCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.startsWith("KACHE_") &&
        !(RUST_CACHE_ENVIRONMENT_KEYS as readonly string[]).includes(key)
    )
  );
}
