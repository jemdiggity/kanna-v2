import { spawn, spawnSync } from "node:child_process";
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
  initializeKdCacheRoot,
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
  initializeKdCacheRoot({ cacheRoot });
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

function cacheIdentity(label) {
  return Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64);
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

// A liveness wait on a spawned build's marker, not a latency budget: the
// failure it guards is a marker that never appears. The ceiling is generous
// because this box routinely runs several worktrees' suites at once, and a
// short one turned a slow-but-correct spawn into a failure.
async function waitForFile(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
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

  it("recovers after a compile process is killed and removes its partial cache", async () => {
    const fixtureRoot = createRepoFixture();
    const cacheRoot = join(fixtureRoot, "cache");
    const identity = "killed-compile";
    const buildLog = join(fixtureRoot, "builds.log");
    const buildStartedMarker = join(fixtureRoot, "build-started");
    const worker = resolve(
      import.meta.dirname,
      "fixtures/kd-cache-installer.mjs"
    );
    const workerArgs = [
      worker,
      cacheRoot,
      identity,
      "hang",
      buildLog,
      buildStartedMarker
    ];
    const killed = spawn(process.execPath, workerArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const killedResult = waitForChild(killed);

    await waitForFile(buildStartedMarker);
    killed.kill("SIGKILL");
    expect((await killedResult).signal).toBe("SIGKILL");
    expect(existsSync(join(cacheRoot, identity))).toBe(false);
    expect(
      readdirSync(cacheRoot).some((name) =>
        name.startsWith(`.${identity}.tmp-`)
      )
    ).toBe(true);

    const retry = spawnSync(
      process.execPath,
      [
        worker,
        cacheRoot,
        identity,
        "complete",
        buildLog,
        buildStartedMarker
      ],
      {
        encoding: "utf8",
        // Liveness only: the retry either recovers the stale lock or it does
        // not. Sized to survive a box running several suites, not to time it.
        timeout: 120_000
      }
    );

    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain("Recovering stale kd lock:");
    expect(retry.stdout.trim()).toBe(join(cacheRoot, identity, "bin/kd.js"));
    expect(validateKdInstallation(join(cacheRoot, identity), identity, runtime))
      .toBe(true);
    expect(
      readdirSync(cacheRoot).filter((name) =>
        name.startsWith(`.${identity}.tmp-`) ||
        name.startsWith(`.${identity}.corrupt-`)
      )
    ).toEqual([]);
    expect(readFileSync(buildLog, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("repairs an invalid final entry under the installation lock", async () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    initializeKdCacheRoot({ cacheRoot });
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
    initializeKdCacheRoot({ cacheRoot });
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
    initializeKdCacheRoot({ cacheRoot });
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
    initializeKdCacheRoot({ cacheRoot });
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
    initializeKdCacheRoot({ cacheRoot });
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
    initializeKdCacheRoot({ cacheRoot });
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
    initializeKdCacheRoot({ cacheRoot });
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
  it("retries an incomplete marker won by a concurrent initializer", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    let markerReadCount = 0;
    const markerRace = (path, _value, options) => {
      writeFileSync(path, "{", options);
      const error = new Error("marker already exists");
      error.code = "EEXIST";
      throw error;
    };
    const readMarker = (path, encoding) => {
      markerReadCount += 1;
      const value = readFileSync(path, encoding);
      if (markerReadCount === 1) {
        writeFileSync(
          path,
          `${JSON.stringify({ kind: "kanna-kd-cache", schema: 1 })}\n`
        );
      }
      return value;
    };

    expect(initializeKdCacheRoot({
      cacheRoot,
      writeMarker: markerRace,
      readMarker,
      waitForMarkerPublication: () => {},
    })).toBe(cacheRoot);
    expect(markerReadCount).toBe(2);
    expect(() => initializeKdCacheRoot({ cacheRoot })).not.toThrow();
  });

  it("rejects the filesystem root before inspecting or changing children", () => {
    expect(() => initializeKdCacheRoot({ cacheRoot: resolve("/") }))
      .toThrow(/unsafe kd cache root/i);
  });

  it("preserves unrelated and manifest-invalid child directories", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const ownedIdentity = "a".repeat(64);
    const invalidIdentity = "b".repeat(64);
    createCachedInstallation(cacheRoot, ownedIdentity, 16, now - 60_000);
    mkdirSync(join(cacheRoot, "unrelated-project"), { recursive: true });
    writeFileSync(join(cacheRoot, "unrelated-project/keep.txt"), "keep");
    mkdirSync(join(cacheRoot, invalidIdentity), { recursive: true });
    writeFileSync(join(cacheRoot, invalidIdentity, "manifest.json"), "{broken");

    const result = pruneKdInstallations({
      cacheRoot,
      currentIdentity: "c".repeat(64),
      now,
      maxAgeMs: 1,
      maxEntries: 0,
      maxBytes: 0,
      isProcessAlive: () => false,
    });

    expect(result.removedIdentities).toEqual([ownedIdentity]);
    expect(existsSync(join(cacheRoot, "unrelated-project/keep.txt"))).toBe(true);
    expect(existsSync(join(cacheRoot, invalidIdentity, "manifest.json"))).toBe(true);
  });

  it.each([
    ["home directory", "home"],
    ["temporary directory", "tempRoot"],
  ])("rejects a cache root equal to the injected %s", (_label, broadRootOption) => {
    const broadRoot = join(createRepoFixture(), "broad-root");
    mkdirSync(broadRoot, { recursive: true });
    const identity = "d".repeat(64);
    createCachedInstallation(broadRoot, identity, 16, Date.now() - 60_000);

    expect(() => pruneKdInstallations({
      cacheRoot: broadRoot,
      currentIdentity: "e".repeat(64),
      maxAgeMs: 1,
      maxEntries: 0,
      maxBytes: 0,
      isProcessAlive: () => false,
      [broadRootOption]: broadRoot,
    })).toThrow(/unsafe kd cache root/i);
    expect(existsSync(join(broadRoot, identity))).toBe(true);
  });

  it("rejects a non-empty unowned cache root before recursive deletion", () => {
    const cacheRoot = join(createRepoFixture(), "unowned-cache");
    mkdirSync(join(cacheRoot, "unrelated-project"), { recursive: true });
    writeFileSync(join(cacheRoot, "unrelated-project/keep.txt"), "keep");

    expect(() => pruneKdInstallations({
      cacheRoot,
      currentIdentity: "f".repeat(64),
      maxAgeMs: 1,
      maxEntries: 0,
      maxBytes: 0,
      isProcessAlive: () => false,
    })).toThrow(/not owned by kd/i);
    expect(existsSync(join(cacheRoot, "unrelated-project/keep.txt"))).toBe(true);
  });

  it("prunes expired entries and then enforces oldest-first count and byte limits", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const expired = cacheIdentity("expired");
    const oldest = cacheIdentity("oldest");
    const middle = cacheIdentity("middle");
    const current = cacheIdentity("current");
    createCachedInstallation(cacheRoot, expired, 16, now - 31 * 24 * 60 * 60 * 1000);
    createCachedInstallation(cacheRoot, oldest, 32, now - 3_000);
    createCachedInstallation(cacheRoot, middle, 32, now - 2_000);
    createCachedInstallation(cacheRoot, current, 32, now - 1_000);

    const result = pruneKdInstallations({
      cacheRoot,
      currentIdentity: current,
      now,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxEntries: 2,
      maxBytes: 10_000,
      isProcessAlive: () => false,
    });

    expect(result.removedIdentities).toEqual([expired, oldest]);
    expect(readdirSync(cacheRoot).filter((name) => !name.startsWith(".")))
      .toEqual([current, middle]);

    const middleBytes = statSync(join(cacheRoot, middle, "bin/kd.js")).size;
    const currentBytes = statSync(join(cacheRoot, current, "bin/kd.js")).size;
    pruneKdInstallations({
      cacheRoot,
      currentIdentity: current,
      now,
      maxAgeMs: Number.POSITIVE_INFINITY,
      maxEntries: 10,
      maxBytes: middleBytes + currentBytes,
      isProcessAlive: () => false,
    });
    expect(existsSync(join(cacheRoot, middle))).toBe(false);
    expect(existsSync(join(cacheRoot, current))).toBe(true);
  });

  it("fences live leases, installation locks, and the current identity", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const leased = cacheIdentity("leased");
    const installing = cacheIdentity("installing");
    const current = cacheIdentity("current");
    const deletable = cacheIdentity("deletable");
    for (const identity of [leased, installing, current, deletable]) {
      createCachedInstallation(cacheRoot, identity, 16, now - 60_000);
    }
    createKdInstallationLease({
      cacheRoot,
      identity: leased,
      pid: 101,
      now,
    });
    writeFileSync(
      join(cacheRoot, `.${installing}.lock`),
      `${JSON.stringify({ pid: 202, token: "installing", startedAt: now })}\n`,
    );

    const result = pruneKdInstallations({
      cacheRoot,
      currentIdentity: current,
      now,
      maxAgeMs: 1,
      maxEntries: 0,
      maxBytes: 0,
      isProcessAlive: (pid) => pid === 101 || pid === 202,
    });

    expect(result.removedIdentities).toEqual([deletable]);
    expect(existsSync(join(cacheRoot, leased))).toBe(true);
    expect(existsSync(join(cacheRoot, installing))).toBe(true);
    expect(existsSync(join(cacheRoot, current))).toBe(true);
  });

  it("cleans stale leases and allows their installation to be reclaimed", () => {
    const cacheRoot = join(createRepoFixture(), "cache");
    mkdirSync(cacheRoot, { recursive: true });
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const stale = cacheIdentity("stale");
    createCachedInstallation(cacheRoot, stale, 16, now - 60_000);
    const leasePath = createKdInstallationLease({
      cacheRoot,
      identity: stale,
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

    expect(result.removedIdentities).toEqual([stale]);
    expect(existsSync(leasePath)).toBe(false);
    expect(existsSync(join(cacheRoot, stale))).toBe(false);
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

    // A real cold install: pnpm install plus a tsup build. The assertions
    // are about what it produced, never how long it took.
    const first = spawnSync(process.execPath, [resolver, "kd"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 600_000
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
      timeout: 120_000
    });
    expect(standalone.status).toBe(0);
    expect(standalone.stdout).toContain("Usage: kd <command>");

    const second = spawnSync(process.execPath, [resolver, "kd"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 120_000
    });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(entrypoint);
    expect(second.stderr).toBe("");
  }, 780_000);
});
