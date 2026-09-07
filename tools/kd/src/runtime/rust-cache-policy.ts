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
 * Every compiler-wrapper and cache control kd owns.
 *
 * Cargo reads the wrapper from four places, and `RUSTC_WORKSPACE_WRAPPER` is
 * *nested* inside `RUSTC_WRAPPER` rather than overridden by it, so setting only
 * `RUSTC_WRAPPER` still lets an inherited workspace wrapper run. The
 * `CARGO_BUILD_*` forms are the environment spelling of `build.rustc-wrapper`
 * and `build.rustc-workspace-wrapper` and bind just as strongly.
 *
 * These are scrubbed before every resolution and before every release
 * invocation, so a build's compiler wrapper is always exactly what kd decided
 * and never a leftover from an outer shell or an earlier resolution.
 */
export const RUST_CACHE_ENVIRONMENT_KEYS = [
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
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

/**
 * On unless a developer opts out. See `resolveRustCacheEligibility`.
 *
 * Unset and blank mean the default, which is on. An unrecognised value fails
 * closed to direct rustc with a warning rather than guessing an intent.
 */
export function parseRustCacheMode(value: string | undefined): {
  enabled: boolean;
  warning?: string;
} {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "on" || normalized === "kache") return { enabled: true };
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

/**
 * The cache is ON by default; `KANNA_RUST_CACHE=off` is the escape hatch.
 *
 * It is on because the measured trade was accepted, not because a correctness
 * question was resolved by argument: a cold private tree against a warm store
 * restores 96.5% of cacheable invocations and cuts sidecar build CPU by 56%,
 * and `.build/cargo-build` shrinks 41% per worktree, in exchange for a one-line
 * workspace edit rebuilding about 3.5x slower. A developer in a tight edit loop
 * exports `KANNA_RUST_CACHE=off` and gets Cargo incremental compilation back for
 * that shell.
 *
 * There is deliberately no "disabled by default" state any more. While the cache
 * was opt-in, that category distinguished "never asked for it" from "asked for
 * it to be off", because the first was the overwhelmingly common case and worth
 * naming in `kd rust-cache status`. With the default on, an unset variable
 * resolves to `enabled` and the only configured way to be off is an explicit
 * `off`, so the two collapse into `disabled`.
 *
 * Kache's per-invocation key is not the whole isolation boundary. Divergent
 * worktrees used to share the same repository store without a source-snapshot
 * salt, allowing concurrent index activity to restore an artifact selected for
 * another checkout. `applyRustCacheEnvironment` now adds that salt while
 * retaining one content-addressed store, and the cross-worktree publication and
 * restore paths are exercised against the real pinned binary in
 * `tests/rust-cache.integration.test.ts`.
 */
export function resolveRustCacheEligibility(input: {
  mode: string | undefined;
  platform: NodeJS.Platform;
  arch: string;
  ci: string | undefined;
}): RustCacheEligibility {
  const mode = parseRustCacheMode(input.mode);
  if (!mode.enabled) {
    if (mode.warning) return { enabled: false, category: "invalid-mode", warning: mode.warning };
    return { enabled: false, category: "disabled" };
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
  sourceIdentity: string;
}

/**
 * Kache compiles hermetically: it strips `-C incremental` from every invocation
 * it handles, so Cargo is told the same thing rather than being left to record
 * incremental fingerprints that rustc never honours.
 *
 * `KACHE_VERIFY_RESTORES=always` verifies that a restored blob matches the
 * digest recorded for the key kache selected. It does NOT verify that the
 * selected key corresponds to the current sources. Kanna's source-snapshot salt
 * supplies that outer boundary. This stays on as defence in depth against a corrupt
 * or truncated store entry, and must not be relaxed for speed: it is the only
 * thing standing between a damaged blob and the compiler's input.
 */
export function buildRustCacheEnvironment(input: RustCacheEnvironmentInput): Record<string, string> {
  return {
    RUSTC_WRAPPER: input.binary,
    CARGO_INCREMENTAL: "0",
    KACHE_CACHE_DIR: input.store,
    KACHE_KEY_SALT: `kanna-source-v1:${input.sourceIdentity}`,
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
