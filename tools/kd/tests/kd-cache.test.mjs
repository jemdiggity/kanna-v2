import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeKdIdentity,
  kdDependencyProjection,
  resolveKdCacheRoot
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
      "esbuild@0.27.4": { resolution: { integrity: "esbuild-integrity" } }
    },
    snapshots: {
      "zod@4.4.3": {},
      "tsup@8.5.1(esbuild@0.27.4)": {
        dependencies: {
          esbuild: "0.27.4"
        }
      },
      "esbuild@0.27.4": {}
    }
  };
}

const runtime = {
  nodeMajor: "24",
  platform: "darwin",
  arch: "arm64"
};

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
