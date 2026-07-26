# Content-addressed kd Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `kd` and `kd-mcp` once per relevant source/dependency identity and reuse the immutable installation across Kanna worktrees.

**Architecture:** Checked-in shell entrypoints call one unbuilt Node resolver, which hashes the current `tools/kd` inputs, validates an immutable cache entry, and atomically installs a self-contained tsup bundle on a miss. A per-hash directory lock serializes concurrent builders; the shell then `exec`s the resolved cached entrypoint so cwd, stdio, signals, and worktree-specific environment remain unchanged.

**Tech Stack:** Bash, Node.js ESM, pnpm lockfile v9 parsed with `yaml`, tsup, Vitest.

---

## File map

- Create `tools/kd/bin/kd-cache.mjs`: pure identity, cache-root, manifest-validation, lock, and atomic-install primitives usable before `kd` itself is built.
- Create `tools/kd/bin/kd-resolver.mjs`: command-line adapter that bootstraps dependencies, computes the current identity, installs on a miss, and prints one cached entrypoint path.
- Create `tools/kd/tests/kd-cache.test.mjs`: focused unit tests for identity projection, dirty inputs, cache validation, concurrency, stale locks, and failed publication.
- Modify `tools/kd/bin/kd`: remove worktree-local mtime/build behavior and `exec` the path returned by the shared resolver.
- Modify `tools/kd/bin/kd-mcp`: use the same resolver while preserving clean JSON-RPC stdout.
- Modify `tools/kd/tsup.config.ts`: bundle `kd` runtime packages so cache entries do not resolve dependencies through a producer worktree.
- Modify `tools/kd/package.json` and `pnpm-lock.yaml`: declare `yaml` for the unbuilt resolver.
- Modify `tools/kd/tests/cli.test.ts`: update the clean-repository launcher contract and prove `kd`/`kd-mcp` share the cache.
- Modify `AGENTS.md`: document content-addressed `kd` installation and invalidation behavior.

### Task 1: Deterministic kd input identity

**Files:**
- Create: `tools/kd/bin/kd-cache.mjs`
- Create: `tools/kd/tests/kd-cache.test.mjs`
- Modify: `tools/kd/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing dependency-projection and source-hash tests**

Create `tools/kd/tests/kd-cache.test.mjs` with isolated fixtures and assertions that unrelated importers do not affect the hash while `kd` runtime/build dependencies and dirty source bytes do:

```js
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeKdIdentity,
  kdDependencyProjection,
  resolveKdCacheRoot
} from "../bin/kd-cache.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kd-cache-identity-"));
  roots.push(root);
  mkdirSync(join(root, "tools/kd/src"), { recursive: true });
  writeFileSync(join(root, "tools/kd/src/cli.ts"), "export const value = 1;\n");
  for (const path of ["package.json", "tsconfig.json", "tsup.config.ts"]) {
    writeFileSync(join(root, "tools/kd", path), `${path}\n`);
  }
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: ['tools/*']\n");
  return root;
}

const lock = {
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true },
  importers: {
    "tools/kd": {
      dependencies: { zod: { version: "4.4.3" } },
      devDependencies: { tsup: { version: "8.5.1(esbuild@0.27.4)" }, vitest: { version: "4.1.4" } }
    },
    "apps/desktop": { dependencies: { vue: { version: "3.5.32" } } }
  },
  packages: {
    "zod@4.4.3": { resolution: { integrity: "zod-integrity" } },
    "tsup@8.5.1": { resolution: { integrity: "tsup-integrity" } },
    "esbuild@0.27.4": { resolution: { integrity: "esbuild-integrity" } }
  },
  snapshots: {
    "zod@4.4.3": {},
    "tsup@8.5.1(esbuild@0.27.4)": { dependencies: { esbuild: "0.27.4" } },
    "esbuild@0.27.4": {}
  }
};

it("projects only kd runtime dependencies and the tsup build graph", () => {
  const projection = kdDependencyProjection(lock);
  expect(projection.roots).toEqual(["tsup@8.5.1(esbuild@0.27.4)", "zod@4.4.3"]);
  expect(Object.keys(projection.snapshots)).toEqual([
    "esbuild@0.27.4",
    "tsup@8.5.1(esbuild@0.27.4)",
    "zod@4.4.3"
  ]);
  expect(JSON.stringify(projection)).not.toContain("vitest");
  expect(JSON.stringify(projection)).not.toContain("vue");
});

it("changes identity for dirty kd bytes but not unrelated lockfile importers", async () => {
  const repoRoot = fixture();
  const input = { repoRoot, lockfile: lock, runtime: { nodeMajor: "24", platform: "darwin", arch: "arm64" } };
  const initial = await computeKdIdentity(input);
  lock.importers["apps/desktop"].dependencies.vue.version = "3.6.0";
  expect(await computeKdIdentity(input)).toBe(initial);
  writeFileSync(join(repoRoot, "tools/kd/src/cli.ts"), "export const value = 2;\n");
  expect(await computeKdIdentity(input)).not.toBe(initial);
});

it("uses the Kanna tool cache convention", () => {
  expect(resolveKdCacheRoot({ platform: "darwin", home: "/Users/tester", env: {} }))
    .toBe("/Users/tester/Library/Caches/kanna/tools/kd");
  expect(resolveKdCacheRoot({ platform: "linux", home: "/home/tester", env: { XDG_CACHE_HOME: "/cache" } }))
    .toBe("/cache/kanna/tools/kd");
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: FAIL because `../bin/kd-cache.mjs` does not exist.

- [ ] **Step 3: Add the resolver's declared YAML dependency**

Add `"yaml": "^2.8.3"` to `tools/kd/package.json` dependencies, then run:

```bash
pnpm install
```

Expected: `tools/kd/node_modules/yaml` resolves and `pnpm-lock.yaml` records the dependency under the `tools/kd` importer.

- [ ] **Step 4: Implement identity and cache-root primitives**

Create `tools/kd/bin/kd-cache.mjs` using only Node built-ins at module load. Export:

```js
export const KD_CACHE_SCHEMA = 1;
export const KD_ENTRYPOINTS = Object.freeze({
  kd: "bin/kd.js",
  "kd-mcp": "bin/kd-mcp.js"
});

export function resolveKdCacheRoot({ platform, home, env }) {
  if (env.KANNA_KD_CACHE_ROOT?.trim()) return resolve(env.KANNA_KD_CACHE_ROOT);
  if (platform === "darwin") return join(home, "Library", "Caches", "kanna", "tools", "kd");
  if (env.XDG_CACHE_HOME?.trim()) return join(env.XDG_CACHE_HOME, "kanna", "tools", "kd");
  return join(home, ".cache", "kanna", "tools", "kd");
}
```

Implement `kdDependencyProjection(lockfile)` by starting from every
`tools/kd.dependencies` version plus only `tools/kd.devDependencies.tsup`,
walking `snapshots[key].dependencies` and `optionalDependencies`, sorting all
keys, and retaining the matching `packages` metadata. Resolve package metadata
for peer-suffixed snapshot keys with the exact key first and then the key
before the first `(`. Throw a descriptive error for a missing importer or
snapshot instead of silently producing a partial identity.

Implement `computeKdIdentity({ repoRoot, lockfile, runtime })` with SHA-256.
Hash `KD_CACHE_SCHEMA`, runtime fields, the canonical JSON dependency
projection, `pnpm-workspace.yaml`, the three `tools/kd` config/manifest files,
and every sorted regular file below `tools/kd/src`. Prefix every file's bytes
with its normalized repository-relative path and byte length. Reject symlinks
or non-regular directory entries.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: PASS for dependency projection, dirty source invalidation, unrelated-lock stability, and cache-root policy.

- [ ] **Step 6: Commit the identity layer**

```bash
git add tools/kd/bin/kd-cache.mjs tools/kd/tests/kd-cache.test.mjs tools/kd/package.json pnpm-lock.yaml
git commit -m "feat(kd): derive content-addressed install identity"
```

### Task 2: Atomic cache publication and build locking

**Files:**
- Modify: `tools/kd/bin/kd-cache.mjs`
- Modify: `tools/kd/tests/kd-cache.test.mjs`

- [ ] **Step 1: Add failing cache-validation and concurrency tests**

Extend `kd-cache.test.mjs` with a helper that injects a fake builder:

```js
const runtime = { nodeMajor: "24", platform: "darwin", arch: "arm64" };

async function successfulFakeBuild({ outputDir, identity }) {
  mkdirSync(join(outputDir, "bin"), { recursive: true });
  writeFileSync(join(outputDir, "bin/kd.js"), "#!/usr/bin/env node\n");
  writeFileSync(join(outputDir, "bin/kd-mcp.js"), "#!/usr/bin/env node\n");
  writeKdManifest(outputDir, identity, runtime);
}

it("publishes one immutable entry for concurrent installers", async () => {
  const root = fixture();
  const cacheRoot = join(root, "cache");
  let builds = 0;
  const build = async ({ outputDir, identity }) => {
    builds += 1;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
    mkdirSync(join(outputDir, "bin"), { recursive: true });
    writeFileSync(join(outputDir, "bin/kd.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(outputDir, "bin/kd-mcp.js"), "#!/usr/bin/env node\n");
    writeKdManifest(outputDir, identity, { nodeMajor: "24", platform: "darwin", arch: "arm64" });
  };
  const input = { cacheRoot, identity: "abc123", entrypoint: "kd", runtime, build };
  const [left, right] = await Promise.all([ensureKdInstallation(input), ensureKdInstallation(input)]);
  expect(left).toBe(right);
  expect(builds).toBe(1);
  expect(validateKdInstallation(join(cacheRoot, "abc123"), "abc123", runtime)).toBe(true);
});

it("does not publish a failed build and retries on the next call", async () => {
  const root = fixture();
  const cacheRoot = join(root, "cache");
  await expect(ensureKdInstallation({
    cacheRoot, identity: "failed", entrypoint: "kd", runtime,
    build: async () => { throw new Error("synthetic build failure"); }
  })).rejects.toThrow("synthetic build failure");
  expect(existsSync(join(cacheRoot, "failed"))).toBe(false);
  const resolved = await ensureKdInstallation({
    cacheRoot, identity: "failed", entrypoint: "kd", runtime,
    build: successfulFakeBuild
  });
  expect(resolved).toBe(join(cacheRoot, "failed/bin/kd.js"));
});
```

Also add separate tests proving a malformed manifest is repaired, a live lock
is not removed, and a lock whose owner PID is reported dead is recovered.

- [ ] **Step 2: Run the focused test and verify missing export failures**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: FAIL because `ensureKdInstallation`, `validateKdInstallation`, and
`writeKdManifest` are not exported.

- [ ] **Step 3: Implement manifest validation and atomic installation**

Add:

```js
export function writeKdManifest(outputDir, identity, runtime) {
  writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify({
    schema: KD_CACHE_SCHEMA,
    identity,
    runtime,
    entrypoints: KD_ENTRYPOINTS
  }, null, 2)}\n`);
}

export function validateKdInstallation(entryDir, identity, runtime) {
  try {
    const manifest = JSON.parse(readFileSync(join(entryDir, "manifest.json"), "utf8"));
    return manifest.schema === KD_CACHE_SCHEMA
      && manifest.identity === identity
      && JSON.stringify(manifest.runtime) === JSON.stringify(runtime)
      && Object.entries(KD_ENTRYPOINTS).every(([name, path]) =>
        manifest.entrypoints?.[name] === path && statSync(join(entryDir, path)).isFile());
  } catch {
    return false;
  }
}
```

Implement `ensureKdInstallation` with:

- atomic `mkdir(lockDir)`;
- `owner.json` containing PID and timestamp;
- a process-private `mkdtemp` directory below `cacheRoot`;
- `build({ outputDir, identity, runtime })`;
- validation before `rename(tempDir, finalDir)`;
- polling waiters capped at 180 seconds;
- stale recovery only when injected/default `isProcessAlive(owner.pid)` is false;
- a second validation after acquiring the lock;
- rename-aside repair for corrupt final entries; and
- `finally` cleanup limited to the caller's own temporary and lock paths.

Use injected `sleep`, `isProcessAlive`, and `pid` options in tests; production
defaults use `timers/promises`, `process.kill(pid, 0)`, and `process.pid`.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: PASS, including one build for concurrent callers and successful
retry after a failed build.

- [ ] **Step 5: Commit atomic installation**

```bash
git add tools/kd/bin/kd-cache.mjs tools/kd/tests/kd-cache.test.mjs
git commit -m "feat(kd): publish shared installs atomically"
```

### Task 3: Self-contained build resolver

**Files:**
- Create: `tools/kd/bin/kd-resolver.mjs`
- Modify: `tools/kd/tsup.config.ts`
- Modify: `tools/kd/tests/kd-cache.test.mjs`

- [ ] **Step 1: Add failing resolver and standalone-bundle tests**

Add tests which build into a temporary cache and assert:

```js
const result = spawnSync(process.execPath, [
  resolve(repoRoot, "tools/kd/bin/kd-resolver.mjs"),
  "kd"
], {
  cwd: repoRoot,
  env: { ...process.env, KANNA_KD_CACHE_ROOT: cacheRoot },
  encoding: "utf8",
  timeout: 180_000
});
expect(result.status).toBe(0);
const entrypoint = result.stdout.trim();
expect(entrypoint.startsWith(`${cacheRoot}/`)).toBe(true);
expect(entrypoint.endsWith("/bin/kd.js")).toBe(true);
expect(result.stderr).toContain("Installing kd");

const isolated = spawnSync(process.execPath, [entrypoint, "--help"], {
  cwd: repoRoot,
  env: { ...process.env, NODE_PATH: "" },
  encoding: "utf8"
});
expect(isolated.status).toBe(0);
expect(isolated.stdout).toContain("Usage: kd <command>");
```

Run the resolver a second time and require the identical path with empty
stderr, proving a hit does not run pnpm or tsup.

- [ ] **Step 2: Run the resolver tests and verify failure**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: FAIL because `kd-resolver.mjs` does not exist.

- [ ] **Step 3: Bundle runtime dependencies**

Change `tools/kd/tsup.config.ts` to:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "bin/kd": "src/bin/kd.ts",
    "bin/kd-mcp": "src/bin/kd-mcp.ts"
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: ["@modelcontextprotocol/sdk", "smol-toml", "zod"]
});
```

- [ ] **Step 4: Implement the command-line resolver**

Create `tools/kd/bin/kd-resolver.mjs`. Validate that argv is exactly `kd` or
`kd-mcp`; resolve repo paths from `import.meta.url`; bootstrap
`tools/kd/node_modules` with `pnpm --dir <kdDir> install` when absent; parse
`pnpm-lock.yaml` with `yaml.parse`; compute runtime and identity; and call
`ensureKdInstallation`.

The production build callback runs:

```js
spawnSync("pnpm", ["--dir", kdDir, "exec", "tsup", "--out-dir", outputDir], {
  cwd: repoRoot,
  env: process.env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
```

On a nonzero result, throw an error containing bounded stdout/stderr. On
success, write the manifest and validate both files with
`node --check`. Print the final entrypoint path and nothing else to stdout.
Print `Installing kd <short-hash>...` to stderr only from the lock-owning
builder callback.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
pnpm --dir tools/kd typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit the resolver**

```bash
git add tools/kd/bin/kd-resolver.mjs tools/kd/bin/kd-cache.mjs tools/kd/tsup.config.ts tools/kd/tests/kd-cache.test.mjs
git commit -m "feat(kd): resolve self-contained cached bundles"
```

### Task 4: Route kd and kd-mcp through the shared installation

**Files:**
- Modify: `tools/kd/bin/kd`
- Modify: `tools/kd/bin/kd-mcp`
- Modify: `tools/kd/tests/cli.test.ts`

- [ ] **Step 1: Update launcher contract tests to require shared cache reuse**

Replace assertions for fixture-local `tools/kd/dist` with:

```ts
const cacheRoot = join(tempRoot, "cache");
const env = { ...cleanLauncherEnv(home), KANNA_KD_CACHE_ROOT: cacheRoot };
const kd = spawnSync("./kd", ["--help"], { cwd: fixtureRepoRoot, env, encoding: "utf8", timeout: 180_000 });
expect(kd.status).toBe(0);
expect(kd.stderr).toContain("Installing kd");
expect(existsSync(resolve(fixtureRepoRoot, "tools/kd/dist"))).toBe(false);

const second = spawnSync("./kd", ["--help"], { cwd: fixtureRepoRoot, env, encoding: "utf8", timeout: 30_000 });
expect(second.status).toBe(0);
expect(second.stderr).toBe("");

const installs = readdirSync(cacheRoot).filter((name) => !name.startsWith("."));
expect(installs).toHaveLength(1);
expect(existsSync(join(cacheRoot, installs[0], "bin/kd-mcp.js"))).toBe(true);
```

Start `tools/kd/bin/kd-mcp` with the same cache root and a short timeout;
assert stderr does not contain `Installing kd`, `Cannot find module`, or
`No such file or directory`.

- [ ] **Step 2: Run the launcher contract and verify old launchers fail it**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/cli.test.ts -t "bootstraps root kd" --maxWorkers=1
```

Expected: FAIL because current wrappers still write `tools/kd/dist`.

- [ ] **Step 3: Replace both shell launchers**

After the existing symlink-safe root discovery, use:

```bash
RESOLVER="$KD_DIR/bin/kd-resolver.mjs"
DIST_ENTRY="$(node "$RESOLVER" "kd")"
exec node "$DIST_ENTRY" "$@"
```

Use `"kd-mcp"` in the MCP wrapper. Reject an empty resolver result before
`exec`. Remove all local `node_modules`, mtime, and `tools/kd/dist` build logic;
the resolver owns those concerns.

- [ ] **Step 4: Run launcher and MCP tests**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/cli.test.ts tests/mcp-tools.test.ts tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: PASS. The fixture contains no local `dist`, and both entrypoints use
one cache installation.

- [ ] **Step 5: Commit launcher routing**

```bash
git add tools/kd/bin/kd tools/kd/bin/kd-mcp tools/kd/tests/cli.test.ts
git commit -m "feat(kd): launch shared content-addressed installs"
```

### Task 5: Document and verify the workflow

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Document the installed-artifact behavior**

Add a `kd installation cache` subsection near worktree isolation:

```markdown
### kd installation cache

`./kd` and `kd-mcp` install a self-contained bundle under
`~/Library/Caches/kanna/tools/kd/<input-hash>/`. Worktrees with identical
`tools/kd` sources and resolved kd dependencies share that immutable bundle;
committed or dirty kd source changes select a new hash. Parallel cold launches
serialize on one build. The cached code still runs with the invoking
worktree's cwd, ports, database, daemon directory, and tmux identity.
```

- [ ] **Step 2: Run package verification**

Run:

```bash
pnpm --dir tools/kd test
pnpm --dir tools/kd typecheck
```

Expected: all Vitest tests PASS and typecheck exits zero.

- [ ] **Step 3: Run repository contracts**

Run:

```bash
pnpm test
```

Expected: all repository test tasks PASS. If an unrelated environment-heavy
suite is explicitly skipped by the repository test command, report that skip
rather than claiming it ran.

- [ ] **Step 4: Run a clean concurrent canary**

Create two temporary fixture copies using the launcher test helper or two
temporary Git worktrees at the same commit, set one temporary
`KANNA_KD_CACHE_ROOT`, remove fixture-local `dist`, and start:

```bash
KANNA_KD_CACHE_ROOT="$canary_cache" ./kd --help
```

concurrently in both. Expected: both exit zero, exactly one stderr stream
contains `Installing kd`, the cache contains one valid hash directory, and
neither worktree contains `tools/kd/dist`.

- [ ] **Step 5: Inspect final repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline -6
```

Expected: no whitespace errors; only intended changes are present; commits
show the identity, atomic installer, resolver, launchers, and documentation.

- [ ] **Step 6: Commit documentation**

```bash
git add AGENTS.md
git commit -m "docs(kd): explain shared installation cache"
```
