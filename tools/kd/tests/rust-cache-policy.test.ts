import { describe, expect, it } from "vitest";
import {
  KACHE_ARTIFACTS,
  KACHE_MAX_SIZE,
  KACHE_VERSION,
  buildRustCacheEnvironment,
  parseRustCacheMode,
  resolveKacheArtifact,
  resolveKacheDownloadUrl,
  resolveKachePaths,
  resolveRustCacheEligibility,
  resolveRustCacheStore,
  stripRustCacheEnvironment
} from "../src/runtime/rust-cache-policy";

describe("kache tool manifest", () => {
  it("pins one verified macOS release asset per supported architecture", () => {
    expect(Object.keys(KACHE_ARTIFACTS).sort()).toEqual(["arm64", "x64"]);
    for (const [arch, artifact] of Object.entries(KACHE_ARTIFACTS)) {
      expect(artifact.asset).toBe(`kache-${artifact.target}.tar.gz`);
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(resolveKacheArtifact(arch)).toBe(artifact);
    }
  });

  it("builds download URLs from the pinned version only", () => {
    const artifact = KACHE_ARTIFACTS.arm64!;
    expect(resolveKacheDownloadUrl(artifact)).toBe(
      `https://github.com/kunobi-ninja/kache/releases/download/v${KACHE_VERSION}/${artifact.asset}`
    );
  });

  it("installs into a Kanna-owned per-version tooling root", () => {
    const paths = resolveKachePaths("/home/kanna");
    expect(paths.versionRoot).toBe(
      `/home/kanna/Library/Caches/kanna/tools/kache/${KACHE_VERSION}`
    );
    expect(paths.binary).toBe(`${paths.versionRoot}/bin/kache`);
  });

  it("scopes the content store per repository", () => {
    expect(resolveRustCacheStore("/home/kanna", "abc123")).toBe(
      "/home/kanna/Library/Caches/kanna/rust-kache/abc123"
    );
  });

  it("has no unsupported architecture", () => {
    expect(resolveKacheArtifact("arm")).toBeUndefined();
  });
});

describe("rust cache mode", () => {
  it("defaults to enabled and accepts the explicit backend name", () => {
    expect(parseRustCacheMode(undefined)).toEqual({ enabled: true });
    expect(parseRustCacheMode("on")).toEqual({ enabled: true });
    expect(parseRustCacheMode(" Kache ")).toEqual({ enabled: true });
  });

  it("disables on opt-out", () => {
    expect(parseRustCacheMode("off")).toEqual({ enabled: false });
  });

  it("disables with a warning on an unknown value", () => {
    // "kanache" was the retired donor-warming backend; it must fail visibly
    // rather than silently enabling a cache that no longer exists.
    const parsed = parseRustCacheMode("kanache");
    expect(parsed.enabled).toBe(false);
    expect(parsed.warning).toContain("kanache");
  });
});

describe("rust cache eligibility", () => {
  const base = { mode: undefined, platform: "darwin" as NodeJS.Platform, arch: "arm64", ci: undefined };

  it("enables on a supported macOS host outside CI", () => {
    expect(resolveRustCacheEligibility(base)).toEqual({ enabled: true });
  });

  it("disables on an unsupported platform or architecture", () => {
    expect(resolveRustCacheEligibility({ ...base, platform: "linux" })).toEqual({
      enabled: false,
      category: "unsupported-platform"
    });
    expect(resolveRustCacheEligibility({ ...base, arch: "arm" })).toEqual({
      enabled: false,
      category: "unsupported-platform"
    });
  });

  it("disables in CI so release-shaped builds never depend on a cache", () => {
    expect(resolveRustCacheEligibility({ ...base, ci: "true" })).toEqual({
      enabled: false,
      category: "disabled-in-ci"
    });
    expect(resolveRustCacheEligibility({ ...base, ci: "  " })).toEqual({ enabled: true });
  });

  it("reports an invalid mode ahead of platform support", () => {
    const eligibility = resolveRustCacheEligibility({ ...base, mode: "maybe", platform: "linux" });
    expect(eligibility).toMatchObject({ enabled: false, category: "invalid-mode" });
  });
});

describe("rust cache environment", () => {
  it("configures a local-only, capped, executable-free store and disables incremental", () => {
    expect(buildRustCacheEnvironment({ binary: "/tools/kache", store: "/store" })).toEqual({
      RUSTC_WRAPPER: "/tools/kache",
      CARGO_INCREMENTAL: "0",
      KACHE_CACHE_DIR: "/store",
      KACHE_LOCAL_ONLY: "1",
      KACHE_CACHE_EXECUTABLES: "0",
      KACHE_VERIFY_RESTORES: "always",
      KACHE_MAX_SIZE: KACHE_MAX_SIZE
    });
  });

  it("strips every Kanna-managed and ambient cache variable for release builds", () => {
    const stripped = stripRustCacheEnvironment({
      PATH: "/usr/bin",
      RUSTC_WRAPPER: "/tools/kache",
      RUSTC_WORKSPACE_WRAPPER: "/hostile/sccache",
      CARGO_INCREMENTAL: "0",
      KACHE_CACHE_DIR: "/store",
      KACHE_S3_BUCKET: "someone-elses-bucket",
      KANNA_BUILD_BRANCH: "main"
    });
    expect(stripped).toEqual({ PATH: "/usr/bin", KANNA_BUILD_BRANCH: "main" });
  });
});
