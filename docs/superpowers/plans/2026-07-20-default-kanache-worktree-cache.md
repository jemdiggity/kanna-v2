# Default Kanache Worktree Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exact-commit Kanache warming the default for new Kanna worktrees while retaining private Cargo build directories and automatic cold-build fallback.

**Architecture:** Add a pure `kd` cache-policy module for enablement, pinned paths, manifest parsing, and donor ranking, plus an effectful runtime module for tool bootstrap, Git discovery, Kanache invocation, lifecycle recording, events, and status. Wire those functions into `kd rust-cache`, bounded sidecar/test workflows, and `.kanna/config.json`; Bazel release code remains untouched.

**Tech Stack:** TypeScript, Node.js filesystem/process APIs, Vitest, Zod, Git worktrees, Cargo 1.93.1, Kanache `6107c7b533a77a0c7c190b75c0284e7501c6edbf`, macOS/APFS.

---

## File map

- Create `tools/kd/src/runtime/rust-cache-policy.ts`: constants, enablement parsing, versioned paths, worktree-list parsing, manifest validation, and deterministic donor ranking.
- Create `tools/kd/src/runtime/rust-cache.ts`: bootstrap, warm, begin/record lifecycle, event logging, status, and best-effort bounded-build wrapper.
- Create `tools/kd/tests/rust-cache-policy.test.ts`: pure policy coverage.
- Create `tools/kd/tests/rust-cache.test.ts`: fake-runner filesystem integration coverage.
- Modify `tools/kd/src/cli.ts`: `rust-cache warm|record|status` parsing and help.
- Modify `tools/kd/tests/cli.test.ts`: CLI contract coverage.
- Modify `tools/kd/src/tasks/registry.ts`: task definitions and bounded workflow integration.
- Modify `tools/kd/tests/rust-test.test.ts`: lifecycle order/success/failure coverage.
- Create `tools/kd/tests/kanna-config.test.ts`: default setup and release-isolation contract.
- Modify `.kanna/config.json`: default warm setup command.
- Modify `AGENTS.md`: development behavior, rollback, seeding, and release isolation.

### Task 1: Pure cache policy and donor ranking

**Files:**
- Create: `tools/kd/src/runtime/rust-cache-policy.ts`
- Create: `tools/kd/tests/rust-cache-policy.test.ts`

- [ ] **Step 1: Write the failing policy tests**

Create `tools/kd/tests/rust-cache-policy.test.ts` with concrete cases for default enablement, rollback values, versioned paths, porcelain parsing, manifest rejection, and ranking:

```ts
import { describe, expect, it } from "vitest";
import {
  KANACHE_REVISION,
  parseRustCacheMode,
  resolveKanachePaths,
  parseWorktreeList,
  parseKanacheManifest,
  rankDonors,
} from "../src/runtime/rust-cache-policy";

describe("rust cache policy", () => {
  it("enables Kanache by default and accepts only documented values", () => {
    expect(parseRustCacheMode(undefined)).toEqual({ enabled: true });
    expect(parseRustCacheMode("on")).toEqual({ enabled: true });
    expect(parseRustCacheMode("kanache")).toEqual({ enabled: true });
    expect(parseRustCacheMode("off")).toEqual({ enabled: false });
    expect(parseRustCacheMode("mystery")).toEqual({
      enabled: false,
      warning: "Unknown KANNA_RUST_CACHE value \"mystery\"; cache disabled.",
    });
  });

  it("pins the binary and event log below the Kanna cache root", () => {
    expect(resolveKanachePaths("/Users/tester")).toEqual({
      revision: KANACHE_REVISION,
      versionRoot: `/Users/tester/Library/Caches/kanna/tools/kanache/${KANACHE_REVISION}`,
      binary: `/Users/tester/Library/Caches/kanna/tools/kanache/${KANACHE_REVISION}/bin/kanache`,
      events: "/Users/tester/Library/Caches/kanna/kanache/events.jsonl",
    });
  });

  it("parses Git porcelain without accepting bare or prunable entries", () => {
    expect(parseWorktreeList([
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.kanna-worktrees/task-one",
      "HEAD abc123",
      "detached",
      "",
      "worktree /missing",
      "HEAD abc123",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n"))).toEqual([
      { path: "/repo", head: "abc123" },
      { path: "/repo/.kanna-worktrees/task-one", head: "abc123" },
    ]);
  });

  it("accepts only Kanna dev manifests with no extra inputs", () => {
    expect(parseKanacheManifest(JSON.stringify({
      profiles: ["dev"],
      targets: ["aarch64-apple-darwin", "host"],
      extra_inputs: [],
      created_unix_nanos: 42,
    }))).toMatchObject({ targets: ["aarch64-apple-darwin", "host"] });
    expect(() => parseKanacheManifest(JSON.stringify({
      profiles: ["release"], targets: ["host"], extra_inputs: [], created_unix_nanos: 1,
    }))).toThrow("profile dev");
    expect(() => parseKanacheManifest(JSON.stringify({
      profiles: ["dev"], targets: ["host"], extra_inputs: [{ path: ".env" }], created_unix_nanos: 1,
    }))).toThrow("extra inputs");
  });

  it("prefers both layouts, then host, then explicit target, newest first", () => {
    expect(rankDonors([
      { path: "/explicit", head: "abc", manifest: { profiles: ["dev"], targets: ["aarch64-apple-darwin"], extraInputs: [], createdUnixNanos: 30 } },
      { path: "/both-old", head: "abc", manifest: { profiles: ["dev"], targets: ["aarch64-apple-darwin", "host"], extraInputs: [], createdUnixNanos: 10 } },
      { path: "/host", head: "abc", manifest: { profiles: ["dev"], targets: ["host"], extraInputs: [], createdUnixNanos: 40 } },
      { path: "/both-new", head: "abc", manifest: { profiles: ["dev"], targets: ["aarch64-apple-darwin", "host"], extraInputs: [], createdUnixNanos: 20 } },
    ], "aarch64-apple-darwin").map((donor) => donor.path)).toEqual([
      "/both-new", "/both-old", "/host", "/explicit",
    ]);
  });
});
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache-policy.test.ts
```

Expected: FAIL because `../src/runtime/rust-cache-policy` does not exist.

- [ ] **Step 3: Implement the pure policy module**

Create `tools/kd/src/runtime/rust-cache-policy.ts` with these exported contracts and complete validation behavior:

```ts
import { join } from "node:path";

export const KANACHE_REPOSITORY = "https://github.com/jemdiggity/kanache";
export const KANACHE_REVISION = "6107c7b533a77a0c7c190b75c0284e7501c6edbf";
export const KANACHE_PROFILE = "dev";

export interface KanachePaths {
  revision: string;
  versionRoot: string;
  binary: string;
  events: string;
}

export interface WorktreeEntry { path: string; head: string }
export interface KanacheManifestSummary {
  profiles: string[];
  targets: string[];
  extraInputs: unknown[];
  createdUnixNanos: number;
}
export interface DonorCandidate extends WorktreeEntry {
  manifest: KanacheManifestSummary;
}

export function parseRustCacheMode(value: string | undefined): { enabled: boolean; warning?: string } {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "on" || normalized === "kanache") return { enabled: true };
  if (normalized === "off") return { enabled: false };
  return { enabled: false, warning: `Unknown KANNA_RUST_CACHE value ${JSON.stringify(value)}; cache disabled.` };
}

export function resolveKanachePaths(homeDir: string): KanachePaths {
  const versionRoot = join(homeDir, "Library", "Caches", "kanna", "tools", "kanache", KANACHE_REVISION);
  return {
    revision: KANACHE_REVISION,
    versionRoot,
    binary: join(versionRoot, "bin", "kanache"),
    events: join(homeDir, "Library", "Caches", "kanna", "kanache", "events.jsonl"),
  };
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
  return output.split(/\n\n+/).flatMap((record) => {
    const lines = record.split("\n");
    if (lines.some((line) => line === "bare" || line.startsWith("prunable "))) return [];
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
    return path && head ? [{ path, head }] : [];
  });
}

export function parseKanacheManifest(raw: string): KanacheManifestSummary {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const profiles = Array.isArray(value.profiles) ? value.profiles.filter((item): item is string => typeof item === "string") : [];
  const targets = Array.isArray(value.targets) ? value.targets.filter((item): item is string => typeof item === "string") : [];
  const extraInputs = Array.isArray(value.extra_inputs) ? value.extra_inputs : [];
  if (profiles.length !== 1 || profiles[0] !== KANACHE_PROFILE) throw new Error("Kanache donor must contain only profile dev.");
  if (targets.length === 0 || targets.some((target) => target !== "host" && !target.endsWith("-apple-darwin"))) throw new Error("Kanache donor has unsupported targets.");
  if (extraInputs.length !== 0) throw new Error("Kanache donor extra inputs are unsupported by the initial Kanna rollout.");
  const created = Number(value.created_unix_nanos);
  if (!Number.isFinite(created)) throw new Error("Kanache donor has no creation timestamp.");
  return { profiles, targets: [...new Set(targets)].sort(), extraInputs, createdUnixNanos: created };
}

function coverage(candidate: DonorCandidate, hostTarget: string): number {
  const host = candidate.manifest.targets.includes("host");
  const explicit = candidate.manifest.targets.includes(hostTarget);
  return host && explicit ? 3 : host ? 2 : explicit ? 1 : 0;
}

export function rankDonors(candidates: DonorCandidate[], hostTarget: string): DonorCandidate[] {
  return candidates
    .filter((candidate) => coverage(candidate, hostTarget) > 0)
    .sort((left, right) => coverage(right, hostTarget) - coverage(left, hostTarget)
      || right.manifest.createdUnixNanos - left.manifest.createdUnixNanos);
}
```

- [ ] **Step 4: Run the policy tests and typecheck**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache-policy.test.ts
pnpm --dir tools/kd typecheck
```

Expected: policy tests PASS and typecheck exits 0. The timestamp is used only for ordering; cache correctness never depends on JavaScript preserving its nanosecond precision.

- [ ] **Step 5: Commit the policy layer**

```bash
git add tools/kd/src/runtime/rust-cache-policy.ts tools/kd/tests/rust-cache-policy.test.ts
git commit -m "feat(kd): define Kanache cache policy"
```

### Task 2: Versioned bootstrap and local event log

**Files:**
- Create: `tools/kd/src/runtime/rust-cache.ts`
- Create: `tools/kd/tests/rust-cache.test.ts`

- [ ] **Step 1: Write failing bootstrap and event tests**

Create `tools/kd/tests/rust-cache.test.ts`. Use a real temporary home and a fake `CommandRunner`; when the fake receives `cargo install`, create `<root>/bin/kanache`, and assert the exact pinned invocation:

```ts
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureKanacheBinary, appendRustCacheEvent, readRustCacheEvents } from "../src/runtime/rust-cache";
import { KANACHE_REPOSITORY, KANACHE_REVISION, resolveKanachePaths } from "../src/runtime/rust-cache-policy";
import type { CommandRunner } from "../src/runtime/process";

describe("Kanache runtime", () => {
  it("installs the pinned locked revision into an atomic version root", async () => {
    const home = mkdtempSync(join(tmpdir(), "kd-kanache-home-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args });
        if (command === "cargo") {
          const root = args[args.indexOf("--root") + 1]!;
          mkdirSync(join(root, "bin"), { recursive: true });
          writeFileSync(join(root, "bin", "kanache"), "#!/bin/sh\n");
          chmodSync(join(root, "bin", "kanache"), 0o755);
        }
        return { exitCode: 0, stdout: command === "cargo" ? "" : "kanache 0.1.0\n", stderr: "" };
      },
    };

    const binary = await ensureKanacheBinary({ homeDir: home, runner });

    expect(binary).toBe(resolveKanachePaths(home).binary);
    expect(existsSync(binary)).toBe(true);
    expect(calls[0]).toMatchObject({
      command: "cargo",
      args: expect.arrayContaining(["install", "--git", KANACHE_REPOSITORY, "--rev", KANACHE_REVISION, "--locked", "--root"]),
    });
    expect(calls[1]?.command).toContain(`.install-${KANACHE_REVISION}-`);
    expect(calls[1]?.args).toEqual(["--version"]);
  });

  it("writes JSONL and ignores malformed historical lines", () => {
    const home = mkdtempSync(join(tmpdir(), "kd-kanache-events-"));
    appendRustCacheEvent(home, { timestamp: "2026-07-20T00:00:00.000Z", repository: "repo", commit: "abc", destination: "/repo/wt", layouts: ["host"], outcome: "miss", category: "no-donor", wallMs: 3, allocationDeltaBytes: 0 });
    appendFileSync(resolveKanachePaths(home).events, "not json\n");
    const warnings: string[] = [];
    expect(readRustCacheEvents(home, "repo", 10, (warning) => warnings.push(warning))).toHaveLength(1);
    expect(warnings).toEqual(["Ignored malformed Kanache event log line 2."]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache.test.ts
```

Expected: FAIL because `rust-cache.ts` does not exist.

- [ ] **Step 3: Implement bootstrap and events**

Create `tools/kd/src/runtime/rust-cache.ts` with:

```ts
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./process";
import { KANACHE_REPOSITORY, KANACHE_REVISION, resolveKanachePaths } from "./rust-cache-policy";

export interface RustCacheEvent {
  timestamp: string;
  repository: string;
  commit: string;
  destination: string;
  donor?: string;
  layouts: string[];
  outcome: "hit" | "miss" | "recorded" | "record-miss";
  category: string;
  wallMs: number;
  allocationDeltaBytes: number;
}

export async function ensureKanacheBinary(input: { homeDir: string; runner: CommandRunner }): Promise<string> {
  const paths = resolveKanachePaths(input.homeDir);
  if (existsSync(paths.binary)) return paths.binary;
  const parent = dirname(paths.versionRoot);
  mkdirSync(parent, { recursive: true });
  const tempRoot = mkdtempSync(join(parent, `.install-${KANACHE_REVISION}-`));
  try {
    const installed = await input.runner.run("cargo", ["install", "--git", KANACHE_REPOSITORY, "--rev", KANACHE_REVISION, "--locked", "--root", tempRoot]);
    if (installed.exitCode !== 0) throw new Error(installed.stderr || "cargo install failed");
    const tempBinary = join(tempRoot, "bin", "kanache");
    chmodSync(tempBinary, 0o755);
    const verified = await input.runner.run(tempBinary, ["--version"]);
    if (verified.exitCode !== 0 || !verified.stdout.startsWith("kanache 0.1.0")) throw new Error("installed Kanache version check failed");
    try { renameSync(tempRoot, paths.versionRoot); }
    catch (error) {
      if (!existsSync(paths.binary)) throw error;
    }
    return paths.binary;
  } finally {
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function appendRustCacheEvent(homeDir: string, event: RustCacheEvent): void {
  const path = resolveKanachePaths(homeDir).events;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function readRustCacheEvents(
  homeDir: string,
  repository: string,
  limit: number,
  onWarning: (warning: string) => void = () => {},
): RustCacheEvent[] {
  const path = resolveKanachePaths(homeDir).events;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line, index) => {
    if (!line) return [];
    try {
      const event = JSON.parse(line) as RustCacheEvent;
      return event.repository === repository ? [event] : [];
    } catch {
      onWarning(`Ignored malformed Kanache event log line ${index + 1}.`);
      return [];
    }
  }).slice(-limit);
}
```

The production implementation must preserve the same contracts while adding contextual error messages to filesystem operations. Losing an atomic publish race is success if the verified final binary exists.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache.test.ts
pnpm --dir tools/kd typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit bootstrap and events**

```bash
git add tools/kd/src/runtime/rust-cache.ts tools/kd/tests/rust-cache.test.ts
git commit -m "feat(kd): bootstrap pinned Kanache tool"
```

### Task 3: Donor discovery and warm fallback

**Files:**
- Modify: `tools/kd/src/runtime/rust-cache.ts`
- Modify: `tools/kd/tests/rust-cache.test.ts`

- [ ] **Step 1: Add failing warm tests**

Extend `rust-cache.test.ts` with temporary `current`, `bad`, and `good` directories. Pre-create the pinned fake binary, write manifests and success markers for candidates, and make the fake runner return Git worktree porcelain plus a first Kanache refusal and second success:

```ts
it("tries ranked exact-HEAD donors until Kanache publishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kd-kanache-warm-"));
  const home = join(root, "home");
  const current = join(root, "current");
  const first = join(root, "first");
  const second = join(root, "second");
  for (const path of [current, first, second]) mkdirSync(join(path, ".build", "cargo-build"), { recursive: true });
  rmSync(join(current, ".build"), { recursive: true, force: true });
  const binary = resolveKanachePaths(home).binary;
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(binary, "fake");
  for (const [path, created] of [[first, 20], [second, 10]] as const) {
    writeFileSync(join(path, ".build/cargo-build/.kanache-manifest.json"), JSON.stringify({ profiles: ["dev"], targets: ["host", "aarch64-apple-darwin"], extra_inputs: [], created_unix_nanos: created }));
    writeFileSync(join(path, ".build/cargo-build/.kanache-success"), "marker");
  }
  const warmCalls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      if (command === "git" && args.join(" ") === "worktree list --porcelain") return { exitCode: 0, stdout: `worktree ${current}\nHEAD abc\n\nworktree ${first}\nHEAD abc\n\nworktree ${second}\nHEAD abc\n`, stderr: "" };
      if (command === "rustc") return { exitCode: 0, stdout: "host: aarch64-apple-darwin\n", stderr: "" };
      if (command === binary) {
        warmCalls.push(args);
        if (warmCalls.length === 1) return { exitCode: 1, stdout: "", stderr: "donor dirty" };
        mkdirSync(join(current, ".build", "cargo-build"), { recursive: true });
        return { exitCode: 0, stdout: "warmed files=100 elapsed_ms=7\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    },
  };
  const result = await warmRustCache({ repoRoot: current, homeDir: home, env: {}, runner, commit: "abc" });
  expect(result).toMatchObject({ ok: true, outcome: "hit", donor: second });
  expect(warmCalls).toHaveLength(2);
});

it("cold-falls back without installing or deleting an existing destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "kd-kanache-existing-"));
  mkdirSync(join(root, ".build", "cargo-build"), { recursive: true });
  writeFileSync(join(root, ".build", "cargo-build", "keep"), "user data");
  const calls: string[] = [];
  const result = await warmRustCache({
    repoRoot: root, homeDir: join(root, "home"), env: {}, commit: "abc",
    runner: { async run(command) { calls.push(command); return { exitCode: 1, stdout: "", stderr: "" }; } },
  });
  expect(result).toMatchObject({ ok: true, outcome: "miss", category: "destination-exists" });
  expect(readFileSync(join(root, ".build", "cargo-build", "keep"), "utf8")).toBe("user data");
  expect(calls).toEqual([]);
});
```

Use a destination path that is absent before warm; do not leave a fabricated `.build/cargo-build` in `current` after fixture setup.

- [ ] **Step 2: Run the warm tests and verify they fail**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache.test.ts
```

Expected: FAIL because `warmRustCache` is not exported.

- [ ] **Step 3: Implement discovery and warm**

Add these public contracts to `rust-cache.ts`:

```ts
export interface RustCacheRuntimeInput {
  repoRoot: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  commit: string;
}
export interface RustCacheOperationResult {
  ok: true;
  outcome: "hit" | "miss" | "recorded" | "record-miss";
  category: string;
  donor?: string;
  message: string;
}
```

Implement `warmRustCache(input)` in this order:

1. Parse `KANNA_RUST_CACHE`; disabled/unknown returns a logged miss.
2. Require `process.platform === "darwin"`; other platforms return `unsupported-platform`.
3. If `<repo>/.build/cargo-build` exists, return `destination-exists` before bootstrap.
4. Run `git worktree list --porcelain` and `rustc -vV` with `cwd: repoRoot`.
5. Parse the host triple from the `host:` line.
6. Filter current path, nonmatching `HEAD`, missing files, symlinked candidate roots, invalid manifests, and candidates whose `git -C <path> rev-parse --git-common-dir` differs from the current common directory.
7. Rank candidates with `rankDonors`.
8. If none remain, return `no-donor` before bootstrap.
9. Resolve/install the pinned binary.
10. For each candidate, run:

```ts
const args = ["warm", donor.path, input.repoRoot, "--profile", "dev"];
for (const target of donor.manifest.targets) args.push("--target", target);
args.push("--strategy", "root");
```

11. Measure wall time with `performance.now()` and allocation delta with `statfsSync(repoRoot, { bigint: true })` around each invocation.
12. On the first exit 0, log `hit` and return. On refusals, log each reason and continue. If all refuse, return `all-donors-refused`.
13. Catch bootstrap, Git, statfs, manifest, and process errors and convert them to a miss. Never remove the destination.

- [ ] **Step 4: Run warm tests, all rust-cache tests, and typecheck**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache-policy.test.ts rust-cache.test.ts
pnpm --dir tools/kd typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit warm orchestration**

```bash
git add tools/kd/src/runtime/rust-cache.ts tools/kd/tests/rust-cache.test.ts
git commit -m "feat(kd): warm Cargo trees from compatible donors"
```

### Task 4: Manifest lifecycle, status, and best-effort wrapper

**Files:**
- Modify: `tools/kd/src/runtime/rust-cache.ts`
- Modify: `tools/kd/tests/rust-cache.test.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Add tests that assert exact command order and that failed/dirty builds do not record:

```ts
it("brackets a successful bounded build and records the narrow layout", async () => {
  const calls: string[] = [];
  const cache = fakeRuntimeInput({ calls, clean: true, host: "aarch64-apple-darwin" });
  const value = await withRustCacheBuild(cache, "sidecars", async () => {
    calls.push("BUILD");
    return { ok: true };
  }, (result) => result.ok);
  expect(value).toEqual({ ok: true });
  expect(calls).toEqual([
    "kanache manifest begin /repo",
    "BUILD",
    "git status --porcelain=v1 --untracked-files=all",
    "rustc -vV",
    "kanache manifest record /repo --profile dev --target aarch64-apple-darwin",
  ]);
});

it("does not record a failed bounded build", async () => {
  const calls: string[] = [];
  const result = await withRustCacheBuild(fakeRuntimeInput({ calls, clean: true }), "all", async () => {
    calls.push("BUILD");
    return { ok: false };
  }, (value) => value.ok);
  expect(result).toEqual({ ok: false });
  expect(calls.filter((call) => call.includes("manifest record"))).toEqual([]);
});

it("status reports enablement, pin, current manifest, and recent events", async () => {
  const status = await getRustCacheStatus(fakeRuntimeInput({ clean: true }));
  expect(status).toMatchObject({ enabled: true, revision: KANACHE_REVISION });
  expect(status).toHaveProperty("binary");
  expect(status).toHaveProperty("events");
});
```

Implement `fakeRuntimeInput` in the test file as a real temporary filesystem plus a fake runner that renders every command as `${command} ${args.join(" ")}`, returns clean Git status, returns the host line, and pre-creates the pinned fake binary.

- [ ] **Step 2: Run the lifecycle tests and verify they fail**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache.test.ts
```

Expected: FAIL because lifecycle/status functions do not exist.

- [ ] **Step 3: Implement lifecycle and status**

Add:

```ts
export type RustCacheLayouts = "sidecars" | "all";

export async function beginRustCacheBuild(input: RustCacheRuntimeInput): Promise<RustCacheOperationResult>;
export async function recordRustCache(input: RustCacheRuntimeInput, layouts: RustCacheLayouts): Promise<RustCacheOperationResult>;
export async function withRustCacheBuild<T>(
  input: RustCacheRuntimeInput,
  layouts: RustCacheLayouts,
  operation: () => Promise<T>,
  succeeded: (value: T) => boolean,
): Promise<T>;
export async function getRustCacheStatus(input: RustCacheRuntimeInput): Promise<{
  enabled: boolean;
  warning?: string;
  revision: string;
  binary: string;
  installed: boolean;
  manifest?: KanacheManifestSummary;
  events: RustCacheEvent[];
}>;
```

Behavior:

- `beginRustCacheBuild` is best-effort: disabled/no binary/bootstrap error returns `record-miss`; otherwise invoke `manifest begin`.
- `recordRustCache` first requires `git status --porcelain=v1 --untracked-files=all` to be empty. Resolve the host triple. `sidecars` passes only the triple; `all` passes sorted `[triple, "host"]`. Invoke `manifest record` immediately and log the result.
- `withRustCacheBuild` always awaits begin, runs the operation exactly once, records only if `succeeded(value)` is true, and preserves the operation's return value or thrown error. Cache failures never replace an operation error or success.
- `getRustCacheStatus` never installs. It reads the current manifest if valid and returns the last ten repository events.
- Repository event identity is `blake3` unnecessary at this layer; use `git rev-parse --git-common-dir` normalized to an absolute path and hash it with Node `createHash("sha256")`, truncating to 16 hex characters.

- [ ] **Step 4: Run lifecycle tests and typecheck**

Run:

```bash
pnpm --dir tools/kd test -- rust-cache.test.ts
pnpm --dir tools/kd typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit lifecycle support**

```bash
git add tools/kd/src/runtime/rust-cache.ts tools/kd/tests/rust-cache.test.ts
git commit -m "feat(kd): manage Kanache donor lifecycle"
```

### Task 5: CLI and kd task surface

**Files:**
- Modify: `tools/kd/src/cli.ts`
- Modify: `tools/kd/tests/cli.test.ts`
- Modify: `tools/kd/src/tasks/registry.ts`

- [ ] **Step 1: Add failing CLI parsing and help tests**

Extend `tools/kd/tests/cli.test.ts`:

```ts
it("parses rust-cache commands", () => {
  expect(parseCliArgs(["rust-cache", "warm"])).toEqual({ taskId: "rust-cache.warm", input: {} });
  expect(parseCliArgs(["rust-cache", "status"])).toEqual({ taskId: "rust-cache.status", input: {} });
  expect(parseCliArgs(["rust-cache", "record", "--layouts", "sidecars"])).toEqual({
    taskId: "rust-cache.record", input: { layouts: "sidecars" },
  });
  expect(parseCliArgs(["rust-cache", "record", "--layouts", "all"])).toEqual({
    taskId: "rust-cache.record", input: { layouts: "all" },
  });
  expect(() => parseCliArgs(["rust-cache", "record"])).toThrow("--layouts");
  expect(() => parseCliArgs(["rust-cache", "record", "--layouts", "release"])).toThrow("sidecars or all");
});
```

Add help assertions for the group and record subcommand.

- [ ] **Step 2: Run CLI tests and verify they fail**

Run:

```bash
pnpm --dir tools/kd test -- cli.test.ts
```

Expected: FAIL with `Unknown command: rust-cache ...`.

- [ ] **Step 3: Implement CLI parsing and task schemas**

In `parseFlagInput`, add explicit string handling:

```ts
if (arg === "--layouts") {
  const value = rest[index + 1];
  if (value !== "sidecars" && value !== "all") throw new Error("--layouts requires sidecars or all");
  input.layouts = value;
  index += 1;
  continue;
}
```

In `parseCliArgs`, add exact routing and required-value validation. Add `rust-cache`, `rust-cache warm`, `rust-cache record`, and `rust-cache status` help topics.

In `registry.ts`, import the runtime functions, add:

```ts
const rustCacheRecordInputSchema = z.object({ layouts: z.enum(["sidecars", "all"]) });
```

and task definitions:

```ts
{
  id: "rust-cache.warm",
  description: "Warm the private Cargo build tree from a compatible Kanache donor.",
  inputSchema: emptyInputSchema,
  execute: async () => {
    const context = await resolveDefaultContext(process.env);
    const result = await warmRustCache({ repoRoot: context.repoRoot, homeDir: context.homeDir, env: context.env, runner: nodeCommandRunner, commit: context.commit });
    return { ok: true, message: result.message, data: result };
  },
},
```

Add analogous `rust-cache.record` and `rust-cache.status` definitions. They return task failure only for invalid CLI/schema input; cache misses remain `{ ok: true }` so setup continues.

- [ ] **Step 4: Run CLI, runtime, and type tests**

Run:

```bash
pnpm --dir tools/kd test -- cli.test.ts rust-cache-policy.test.ts rust-cache.test.ts
pnpm --dir tools/kd typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the command surface**

```bash
git add tools/kd/src/cli.ts tools/kd/tests/cli.test.ts tools/kd/src/tasks/registry.ts
git commit -m "feat(kd): expose rust-cache commands"
```

### Task 6: Bounded sidecar and Rust-test recording

**Files:**
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/tests/rust-test.test.ts`
- Modify: `tools/kd/src/runtime/rust-test.ts` only if dependency injection is needed to test lifecycle ordering without the global registry runner.

- [ ] **Step 1: Add failing wrapper-order tests**

Extend `rust-test.test.ts` with a cache lifecycle fake:

```ts
it("begins before canonical Rust tests and records all layouts only after success", async () => {
  const order: string[] = [];
  const result = await executeRustTests({
    repoRoot: "/repo",
    env: {},
    runner: { async run(command) { order.push(command); return { exitCode: 0, stdout: "", stderr: "" }; } },
    cache: {
      async begin() { order.push("cache.begin"); },
      async record() { order.push("cache.record.all"); },
    },
  });
  expect(result.ok).toBe(true);
  expect(order[0]).toBe("cache.begin");
  expect(order.at(-1)).toBe("cache.record.all");
});

it("leaves the marker cleared when a canonical Rust test fails", async () => {
  const order: string[] = [];
  const result = await executeRustTests({
    repoRoot: "/repo", env: {},
    runner: { async run(command) { order.push(command); return { exitCode: 1, stdout: "", stderr: "failed" }; } },
    cache: {
      async begin() { order.push("cache.begin"); },
      async record() { order.push("cache.record.all"); },
    },
  });
  expect(result.ok).toBe(false);
  expect(order).not.toContain("cache.record.all");
});
```

- [ ] **Step 2: Run Rust orchestration tests and verify they fail**

Run:

```bash
pnpm --dir tools/kd test -- rust-test.test.ts
```

Expected: TypeScript/test failure because `executeRustTests` has no `cache` input.

- [ ] **Step 3: Add the injectable lifecycle and registry wiring**

In `rust-test.ts`, define:

```ts
export interface RustTestCacheLifecycle {
  begin(): Promise<void>;
  record(): Promise<void>;
}
```

Accept `cache?: RustTestCacheLifecycle`; await `cache?.begin()` before the loop, and await `cache?.record()` only after every command succeeds.

In the `test.rust` registry task:

1. Resolve context.
2. Check `getDevStatus(nodeCommandRunner, context.tmux)`. If running, provide a lifecycle whose `record` is a no-op that emits a `record-miss/dev-active` event; it must still begin so prior both-layout markers cannot survive host mutation.
3. Otherwise provide begin and `recordRustCache(..., "all")`.

In `build.sidecars`, call `beginRustCacheBuild` before `buildDesktopSidecars`; after success call `recordRustCache(..., "sidecars")`. Cache functions are best-effort and may not change the sidecar task's success/failure.

The sidecar path is allowed during `dev up`: it records only the explicit layout, and Kanache prunes the later undeclared host layout.

- [ ] **Step 4: Run orchestration, sidecar, runtime, and type tests**

Run:

```bash
pnpm --dir tools/kd test -- rust-test.test.ts sidecars.test.ts rust-cache.test.ts
pnpm --dir tools/kd typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit bounded lifecycle integration**

```bash
git add tools/kd/src/tasks/registry.ts tools/kd/src/runtime/rust-test.ts tools/kd/tests/rust-test.test.ts
git commit -m "feat(kd): record successful Rust build donors"
```

### Task 7: Default setup, documentation, and release isolation

**Files:**
- Modify: `.kanna/config.json`
- Create: `tools/kd/tests/kanna-config.test.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the failing repository-config contract test**

Create `tools/kd/tests/kanna-config.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Kanna repository cache defaults", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const config = JSON.parse(readFileSync(resolve(root, ".kanna/config.json"), "utf8"));

  it("warms after environment sync in every Kanna-managed worktree", () => {
    expect(config.setup).toEqual(["pnpm install", "./kd env sync", "./kd rust-cache warm"]);
  });

  it("keeps teardown on private workspace cleanup", () => {
    expect(config.teardown).toEqual(["./kd dev down --kill-daemon", "./kd clean --all"]);
  });

  it("does not add Kanache to release configuration", () => {
    expect(JSON.stringify(config)).not.toContain("release ship");
    const releaseSource = readFileSync(resolve(root, "tools/kd/src/runtime/release.ts"), "utf8");
    expect(releaseSource).not.toContain("rust-cache");
    expect(releaseSource).not.toContain("kanache");
  });
});
```

- [ ] **Step 2: Run the config test and verify it fails**

Run:

```bash
pnpm --dir tools/kd test -- kanna-config.test.ts
```

Expected: FAIL because setup lacks `./kd rust-cache warm`.

- [ ] **Step 3: Enable default warming and document it**

Change `.kanna/config.json` setup to:

```json
"setup": [
  "pnpm install",
  "./kd env sync",
  "./kd rust-cache warm"
]
```

Update `AGENTS.md` in the Development Workflow section with these exact operational facts:

- new Kanna worktrees attempt exact-`HEAD` Kanache warming by default;
- misses continue with `.build/cargo-build` cold builds;
- `KANNA_RUST_CACHE=off` disables warm and record immediately;
- `./kd test rust` on a clean, dev-down checkout seeds host plus explicit layouts;
- `./kd rust-cache status` displays recent measurements;
- release remains Bazel-only and never executes Kanache.

- [ ] **Step 4: Run the config and focused kd suite**

Run:

```bash
pnpm --dir tools/kd test -- kanna-config.test.ts cli.test.ts rust-cache-policy.test.ts rust-cache.test.ts rust-test.test.ts sidecars.test.ts
pnpm --dir tools/kd typecheck
```

Expected: PASS and exit 0.

- [ ] **Step 5: Commit default enablement**

```bash
git add .kanna/config.json AGENTS.md tools/kd/tests/kanna-config.test.ts
git commit -m "feat: enable Kanache for Kanna worktrees"
```

### Task 8: Full verification and real default-path canary

**Files:**
- Modify only if verification exposes a defect in files already listed above.

- [ ] **Step 1: Run formatting, typecheck, and the complete kd test suite**

Run:

```bash
git diff --check
pnpm --dir tools/kd typecheck
pnpm --dir tools/kd build
pnpm --dir tools/kd test
```

Expected: no whitespace errors; typecheck, build, and all kd tests PASS.

- [ ] **Step 2: Run repository-level bounded verification**

Run:

```bash
pnpm test
```

Expected: repository test graph exits 0. Do not run release ship or any cloud/mobile mutation.

- [ ] **Step 3: Verify rollback and no-donor fallback through the real CLI**

Run:

```bash
KANNA_RUST_CACHE=off ./kd rust-cache warm
./kd rust-cache status
```

Expected: the first command reports `disabled` and exits 0; status reports the pinned revision and leaves the current `.build/cargo-build` unchanged.

- [ ] **Step 4: Verify the pinned bootstrap without claiming a cache hit**

If the current destination build directory exists or no clean exact-`HEAD` donor exists, run only:

```bash
./kd rust-cache status
```

Record that the real hit is blocked by fixture state. Do not delete the current build directory or touch another registered Kanna worktree to manufacture a hit. The post-merge operator can seed a clean main checkout with `./kd test rust`, then create new exact-`HEAD` tasks through Kanna for the 7–9 GiB measurement.

- [ ] **Step 5: Inspect the final diff and repository state**

Run:

```bash
git diff --check
git status --short --branch
git log --oneline --decorate -10
```

Expected: no whitespace errors; only pre-existing unrelated untracked investigation files remain; implementation commits are present locally; nothing is pushed.

- [ ] **Step 6: Commit any verification-only correction**

If and only if verification required a code correction:

```bash
git add .kanna/config.json AGENTS.md \
  tools/kd/src/cli.ts \
  tools/kd/src/runtime/rust-cache-policy.ts \
  tools/kd/src/runtime/rust-cache.ts \
  tools/kd/src/runtime/rust-test.ts \
  tools/kd/src/tasks/registry.ts \
  tools/kd/tests/cli.test.ts \
  tools/kd/tests/kanna-config.test.ts \
  tools/kd/tests/rust-cache-policy.test.ts \
  tools/kd/tests/rust-cache.test.ts \
  tools/kd/tests/rust-test.test.ts
git commit -m "fix(kd): harden Kanache default rollout"
```

Do not stage `docs/specs/safe-rust-build-caching.md`, `docs/superpowers/plans/2026-07-18-kache-worktree-canary.md`, or `scripts/experiments/`; they predate this implementation and are outside its commit set.
