import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeKdIdentity,
  createKdInstallationLease,
  ensureKdInstallation,
  formatKdCacheEvent,
  kdDependencyProjection,
  pruneKdInstallations,
  resolveKdCacheRoot,
  validateKdInstallation,
  writeKdManifest
} from "../bin/kd-cache.mjs";

const fixtureRoots = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRepoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "kd-cache-identity-"));
  fixtureRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "tools/kd/src"), { recursive: true });
  writeFileSync(join(repoRoot, "tools/kd/src/cli.ts"), "export const value = 1;\n");
  writeFileSync(join(repoRoot, "tools/kd/package.json"), '{"name":"@kanna/kd"}\n');
  writeFileSync(join(repoRoot, "tools/kd/tsconfig.json"), "{}\n");
  writeFileSync(join(repoRoot, "tools/kd/tsup.config.ts"), "export default {};\n");
  writeFileSync(join(repoRoot, "pnpm-workspace.yaml"), "packages: ['tools/*']\n");
  return repoRoot;
}

function createLockfile() {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true },
    importers: {
      "tools/kd": {
        dependencies: {
          zod: { version: "4.4.3" }
        },
        devDependencies: {
          tsup: { version: "8.5.1(esbuild@0.27.4)" },
          vitest: { version: "4.1.4" }
        }
      },
      "apps/desktop": {
        dependencies: {
          vue: { version: "3.5.32" }
        }
      }
    },
    packages: {
      "zod@4.4.3": { resolution: { integrity: "zod-integrity" } },
      "tsup@8.5.1": { resolution: { integrity: "tsup-integrity" } },
      "esbuild@0.27.4": { resolution: { integrity: "esbuild-integrity" } },
      "wrap-ansi@7.0.0": { resolution: { integrity: "wrap-ansi-integrity" } }
    },
    snapshots: {
      "zod@4.4.3": {},
      "tsup@8.5.1(esbuild@0.27.4)": {
        dependencies: {
          esbuild: "0.27.4",
          "wrap-ansi-cjs": "npm:wrap-ansi@7.0.0"
        }
      },
      "esbuild@0.27.4": {},
      "wrap-ansi@7.0.0": {}
    }
  };
}

const runtime = {
  nodeMajor: "24",
  platform: "darwin",
  arch: "arm64"
};

async function successfulFakeBuild({ outputDir, identity }) {
  mkdirSync(join(outputDir, "bin"), { recursive: true });
  writeFileSync(join(outputDir, "bin/kd.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(outputDir, "bin/kd-mcp.js"), "#!/usr/bin/env node\n");
  writeKdManifest(outputDir, identity, runtime);
}

function createCachedInstallation(cacheRoot, identity, bytes, usedAtMs) {
  const entryRoot = join(cacheRoot, identity);
  mkdirSync(join(entryRoot, "bin"), { recursive: true });
  writeFileSync(join(entryRoot, "bin/kd.js"), "x".repeat(bytes));
  writeFileSync(join(entryRoot, "bin/kd-mcp.js"), "#!/usr/bin/env node\n");
  writeKdManifest(entryRoot, identity, runtime);
  const usedPath = join(cacheRoot, `.${identity}.used`);
  writeFileSync(usedPath, `${usedAtMs}\n`);
  const usedAt = new Date(usedAtMs);
  utimesSync(usedPath, usedAt, usedAt);
  return entryRoot;
}

describe("kd installation identity", () => {
  it("projects only kd runtime dependencies and the tsup build graph", () => {
    const projection = kdDependencyProjection(createLockfile());

    expect(projection.roots).toEqual([
      "tsup@8.5.1(esbuild@0.27.4)",
      "zod@4.4.3"
    ]);
    expect(Object.keys(projection.snapshots)).toEqual([
      "esbuild@0.27.4",
      "tsup@8.5.1(esbuild@0.27.4)",
      "wrap-ansi@7.0.0",
      "zod@4.4.3"
    ]);
    expect(JSON.stringify(projection)).not.toContain("vitest");
    expect(JSON.stringify(projection)).not.toContain("vue");
  });

  it("changes for dirty kd bytes but not unrelated lockfile importers", async () => {
    const repoRoot = createRepoFixture();
    const lockfile = createLockfile();
    const input = { repoRoot, lockfile, runtime };
    const initial = await computeKdIdentity(input);

    lockfile.importers["apps/desktop"].dependencies.vue.version = "3.6.0";
    expect(await computeKdIdentity(input)).toBe(initial);

    writeFileSync(
      join(repoRoot, "tools/kd/src/cli.ts"),
      "export const value = 2;\n"
    );
    expect(await computeKdIdentity(input)).not.toBe(initial);
  });

  it("changes when a resolved kd dependency changes", async () => {
    const repoRoot = createRepoFixture();
    const lockfile = createLockfile();
    const initial = await computeKdIdentity({ repoRoot, lockfile, runtime });

    lockfile.packages["zod@4.4.3"].resolution.integrity = "new-integrity";

    expect(await computeKdIdentity({ repoRoot, lockfile, runtime })).not.toBe(
      initial
    );
  });

  it("changes when kd build configuration changes", async () => {
    const repoRoot = createRepoFixture();
    const lockfile = createLockfile();
    const initial = await computeKdIdentity({ repoRoot, lockfile, runtime });

    writeFileSync(
      join(repoRoot, "tools/kd/tsup.config.ts"),
      "export default { minify: true };\n"
    );

    expect(await computeKdIdentity({ repoRoot, lockfile, runtime })).not.toBe(
      initial
    );
  });

  it("uses the Kanna tool cache convention", () => {
    expect(
      resolveKdCacheRoot({
        platform: "darwin",
        home: "/Users/tester",
        env: {}
      })
    ).toBe("/Users/tester/Library/Caches/kanna/tools/kd");
    expect(
      resolveKdCacheRoot({
        platform: "linux",
        home: "/home/tester",
        env: { XDG_CACHE_HOME: "/cache" }
      })
    ).toBe("/cache/kanna/tools/kd");
    expect(
      resolveKdCacheRoot({
        platform: "darwin",
        home: "/Users/tester",
        env: { KANNA_KD_CACHE_ROOT: "/tmp/kd cache" }
      })
    ).toBe("/tmp/kd cache");
  });
});

describe("kd installation publication", () => {
  it("publishes one immutable entry for concurrent installers", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    let builds = 0;
    const events = [];
    const build = async (input) => {
      builds += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
      await successfulFakeBuild(input);
    };
    const input = {
      cacheRoot,
      identity: "abc123",
      entrypoint: "kd",
      runtime,
      build,
      onCacheEvent: (event) => events.push(event)
    };

    const [left, right] = await Promise.all([
      ensureKdInstallation(input),
      ensureKdInstallation(input)
    ]);

    expect(left).toBe(right);
    expect(builds).toBe(1);
    expect(
      validateKdInstallation(join(cacheRoot, "abc123"), "abc123", runtime)
    ).toBe(true);
    expect(events.filter((event) => event.type === "wait")).toHaveLength(1);
  });

  it("does not publish a failed build and retries on the next call", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const input = {
      cacheRoot,
      identity: "failed",
      entrypoint: "kd",
      runtime
    };

    await expect(
      ensureKdInstallation({
        ...input,
        build: async () => {
          throw new Error("synthetic build failure");
        }
      })
    ).rejects.toThrow("synthetic build failure");
    expect(existsSync(join(cacheRoot, "failed"))).toBe(false);

    const resolved = await ensureKdInstallation({
      ...input,
      build: successfulFakeBuild
    });

    expect(resolved).toBe(join(cacheRoot, "failed/bin/kd.js"));
  });

  it("repairs an invalid final entry under the installation lock", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const entryRoot = join(cacheRoot, "corrupt");
    mkdirSync(entryRoot, { recursive: true });
    writeFileSync(join(entryRoot, "manifest.json"), "{broken");

    const resolved = await ensureKdInstallation({
      cacheRoot,
      identity: "corrupt",
      entrypoint: "kd",
      runtime,
      build: successfulFakeBuild
    });

    expect(resolved).toBe(join(entryRoot, "bin/kd.js"));
    expect(JSON.parse(readFileSync(join(entryRoot, "manifest.json"), "utf8")))
      .toMatchObject({ identity: "corrupt" });
  });

  it("rebuilds a valid-manifest installation with a missing entrypoint", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const entryRoot = join(cacheRoot, "missing-entrypoint");
    await successfulFakeBuild({
      outputDir: entryRoot,
      identity: "missing-entrypoint"
    });
    unlinkSync(join(entryRoot, "bin/kd.js"));
    let builds = 0;

    const resolved = await ensureKdInstallation({
      cacheRoot,
      identity: "missing-entrypoint",
      entrypoint: "kd",
      runtime,
      build: async (input) => {
        builds += 1;
        await successfulFakeBuild(input);
      }
    });

    expect(resolved).toBe(join(entryRoot, "bin/kd.js"));
    expect(builds).toBe(1);
    expect(validateKdInstallation(entryRoot, "missing-entrypoint", runtime))
      .toBe(true);
  });

  it("reports cache miss and corrupt-entry recovery with full context", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const entryRoot = join(cacheRoot, "corrupt-events");
    mkdirSync(entryRoot, { recursive: true });
    writeFileSync(join(entryRoot, "manifest.json"), "{broken");
    const events = [];

    await ensureKdInstallation({
      cacheRoot,
      identity: "corrupt-events",
      entrypoint: "kd",
      runtime,
      build: successfulFakeBuild,
      onCacheEvent: (event) => events.push(formatKdCacheEvent(event))
    });

    expect(events).toEqual([
      `Installing kd: identity=corrupt-events cache=${entryRoot} phase=install`,
      `Recovering corrupt kd installation: identity=corrupt-events cache=${entryRoot} phase=recovery`
    ]);
  });

  it("recovers a lock whose recorded owner is dead", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const lockRoot = join(cacheRoot, ".dead.lock");
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(
      join(lockRoot, "owner.json"),
      JSON.stringify({ pid: 40404, token: "dead-owner", startedAt: 1 })
    );

    const events = [];
    const resolved = await ensureKdInstallation({
      cacheRoot,
      identity: "dead",
      entrypoint: "kd",
      runtime,
      build: successfulFakeBuild,
      isProcessAlive: () => false,
      onCacheEvent: (event) => events.push(formatKdCacheEvent(event))
    });

    expect(resolved).toBe(join(cacheRoot, "dead/bin/kd.js"));
    expect(existsSync(lockRoot)).toBe(false);
    expect(events).toContain(
      `Recovering stale kd lock: identity=dead cache=${lockRoot} phase=lock-recovery`
    );
  });

  it("recovers an ownerless lock after it remains unchanged for one poll", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const lockRoot = join(cacheRoot, ".ownerless.lock");
    mkdirSync(lockRoot, { recursive: true });

    const resolved = await ensureKdInstallation({
      cacheRoot,
      identity: "ownerless",
      entrypoint: "kd",
      runtime,
      build: successfulFakeBuild,
      waitTimeoutMs: 100,
      pollIntervalMs: 1
    });

    expect(resolved).toBe(join(cacheRoot, "ownerless/bin/kd.js"));
    expect(existsSync(lockRoot)).toBe(false);
  });

  it("recovers a malformed lock after it remains unchanged for one poll", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const lockRoot = join(cacheRoot, ".malformed.lock");
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(join(lockRoot, "owner.json"), "{not-json");

    const resolved = await ensureKdInstallation({
      cacheRoot,
      identity: "malformed",
      entrypoint: "kd",
      runtime,
      build: successfulFakeBuild,
      waitTimeoutMs: 100,
      pollIntervalMs: 1
    });

    expect(resolved).toBe(join(cacheRoot, "malformed/bin/kd.js"));
    expect(existsSync(lockRoot)).toBe(false);
  });

  it("cleans the private candidate when owner publication fails", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");

    await expect(
      ensureKdInstallation({
        cacheRoot,
        identity: "publish-failure",
        entrypoint: "kd",
        runtime,
        build: successfulFakeBuild,
        writeLockOwner: () => {
          throw new Error("synthetic owner write failure");
        }
      })
    ).rejects.toThrow("synthetic owner write failure");

    expect(
      readdirSync(cacheRoot).filter((name) =>
        name.startsWith(".publish-failure.lock")
      )
    ).toEqual([]);
  });

  it("never removes a lock whose recorded owner is alive", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const lockRoot = join(cacheRoot, ".live.lock");
    mkdirSync(lockRoot, { recursive: true });
    writeFileSync(
      join(lockRoot, "owner.json"),
      JSON.stringify({ pid: 50505, token: "live-owner", startedAt: Date.now() })
    );

    const events = [];
    await expect(
      ensureKdInstallation({
        cacheRoot,
        identity: "live",
        entrypoint: "kd",
        runtime,
        build: successfulFakeBuild,
        isProcessAlive: () => true,
        waitTimeoutMs: 5,
        pollIntervalMs: 1,
        onCacheEvent: (event) => events.push(formatKdCacheEvent(event))
      })
    ).rejects.toThrow(
      `kd installation failed: identity=live cache=${join(
        cacheRoot,
        "live"
      )} phase=lock: Timed out waiting for kd installation live`
    );

    expect(existsSync(lockRoot)).toBe(true);
    expect(events).toContain(
      `Waiting for kd installation: identity=live cache=${join(
        cacheRoot,
        "live"
      )} phase=lock`
    );
    expect(events.at(-1)).toContain(
      `kd installation failed: identity=live cache=${join(
        cacheRoot,
        "live"
      )} phase=lock: Timed out waiting for kd installation live`
    );
  });

  it("reports build failures with cache path, full identity, and phase", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    const identity = "full-build-failure-identity";
    const entryRoot = join(cacheRoot, identity);
    const events = [];

    await expect(
      ensureKdInstallation({
        cacheRoot,
        identity,
        entrypoint: "kd",
        runtime,
        build: async () => {
          throw new Error("synthetic command failure");
        },
        onCacheEvent: (event) => events.push(formatKdCacheEvent(event))
      })
    ).rejects.toThrow(
      `kd installation failed: identity=${identity} cache=${entryRoot} phase=build: synthetic command failure`
    );
    expect(events.at(-1)).toBe(
      `kd installation failed: identity=${identity} cache=${entryRoot} phase=build: synthetic command failure`
    );
  });
});

describe("kd installation reclamation", () => {
  it("prunes expired entries and then enforces oldest-first count and byte limits", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    createCachedInstallation(cacheRoot, "expired", 16, now - 31 * 24 * 60 * 60 * 1000);
    createCachedInstallation(cacheRoot, "oldest", 32, now - 3_000);
    createCachedInstallation(cacheRoot, "middle", 32, now - 2_000);
    createCachedInstallation(cacheRoot, "current", 32, now - 1_000);

    const result = pruneKdInstallations({
      cacheRoot,
      currentIdentity: "current",
      now,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxEntries: 2,
      maxBytes: 10_000,
      isProcessAlive: () => false,
    });

    expect(result.removedIdentities).toEqual(["expired", "oldest"]);
    expect(readdirSync(cacheRoot).filter((name) => !name.startsWith(".")))
      .toEqual(["current", "middle"]);

    const middleBytes = statSync(join(cacheRoot, "middle/bin/kd.js")).size;
    const currentBytes = statSync(join(cacheRoot, "current/bin/kd.js")).size;
    pruneKdInstallations({
      cacheRoot,
      currentIdentity: "current",
      now,
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxEntries: 10,
      maxBytes: middleBytes + currentBytes,
      isProcessAlive: () => false,
    });
    expect(existsSync(join(cacheRoot, "middle"))).toBe(false);
    expect(existsSync(join(cacheRoot, "current"))).toBe(true);
  });

  it("fences live leases, installation locks, and the current identity", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    for (const identity of ["leased", "installing", "current", "deletable"]) {
      createCachedInstallation(cacheRoot, identity, 16, now - 60_000);
    }
    createKdInstallationLease({
      cacheRoot,
      identity: "leased",
      pid: 101,
      now,
    });
    writeFileSync(
      join(cacheRoot, ".installing.lock"),
      `${JSON.stringify({ pid: 202, token: "installing", startedAt: now })}\n`,
    );

    const result = pruneKdInstallations({
      cacheRoot,
      currentIdentity: "current",
      now,
      maxAgeMs: 1,
      maxEntries: 0,
      maxBytes: 0,
      isProcessAlive: (pid) => pid === 101 || pid === 202,
    });

    expect(result.removedIdentities).toEqual(["deletable"]);
    expect(existsSync(join(cacheRoot, "leased"))).toBe(true);
    expect(existsSync(join(cacheRoot, "installing"))).toBe(true);
    expect(existsSync(join(cacheRoot, "current"))).toBe(true);
  });

  it("cleans stale leases and allows their installation to be reclaimed", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    createCachedInstallation(cacheRoot, "stale", 16, now - 60_000);
    const leasePath = createKdInstallationLease({
      cacheRoot,
      identity: "stale",
      pid: 303,
      now,
    });

    const result = pruneKdInstallations({
      cacheRoot,
      currentIdentity: "other",
      now,
      maxAgeMs: 1,
      maxEntries: 0,
      maxBytes: 0,
      isProcessAlive: () => false,
    });

    expect(result.removedIdentities).toEqual(["stale"]);
    expect(existsSync(leasePath)).toBe(false);
    expect(existsSync(join(cacheRoot, "stale"))).toBe(false);
  });
});

describe("kd installation resolver", () => {
  it("builds one standalone bundle and returns silent cache hits", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const cacheRoot = mkdtempSync(join(tmpdir(), "kd-resolver-cache-"));
    fixtureRoots.push(cacheRoot);
    const resolver = join(repoRoot, "tools/kd/bin/kd-resolver.mjs");
    const env = {
      ...process.env,
      KANNA_KD_CACHE_ROOT: cacheRoot
    };

    const first = spawnSync(process.execPath, [resolver, "kd"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 180_000
    });

    expect(first.status).toBe(0);
    expect(first.stderr).toContain("Installing kd:");
    const entrypoint = first.stdout.trim();
    expect(entrypoint.startsWith(`${cacheRoot}/`)).toBe(true);
    expect(entrypoint.endsWith("/bin/kd.js")).toBe(true);

    const standalone = spawnSync(process.execPath, [entrypoint, "--help"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_PATH: ""
      },
      encoding: "utf8",
      timeout: 30_000
    });
    expect(standalone.status).toBe(0);
    expect(standalone.stdout).toContain("Usage: kd <command>");

    const second = spawnSync(process.execPath, [resolver, "kd"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 30_000
    });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(entrypoint);
    expect(second.stderr).toBe("");
  }, 240_000);
});
