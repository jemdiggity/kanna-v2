# kd Lock Publication Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make kd installation locks atomically visible and recover legacy invalid locks, with real cross-process launcher and MCP regression coverage.

**Architecture:** `kd-cache.mjs` writes the complete owner JSON to a private file and publishes it with `linkSync`, whose destination-exists failure preserves exclusive ownership without exposing partial content. Lock readers accept both the new file and legacy directory shapes; an invalid legacy lock must remain unchanged across one poll before quarantine. The launcher integration test runs two byte-identical git fixtures against one cache and drives the cached MCP over newline-delimited JSON-RPC.

**Tech Stack:** Node.js ESM and filesystem primitives, Bash launchers, TypeScript, Vitest, MCP stdio JSON-RPC.

---

## File map

- Modify `tools/kd/bin/kd-cache.mjs`: atomically publish owner records, read file/directory locks, stabilize invalid-lock recovery, and clean private candidates.
- Modify `tools/kd/tests/kd-cache.test.mjs`: cover ownerless/malformed recovery and owner-record write failure.
- Modify `tools/kd/tests/cli.test.ts`: run concurrent cold launchers from two fixtures and complete a real MCP handshake.
- Modify `docs/superpowers/specs/2026-07-26-content-addressed-kd-install-design.md`: record the corrected lock and verification contracts.

### Task 1: Lock recovery regressions

**Files:**
- Modify: `tools/kd/tests/kd-cache.test.mjs`

- [ ] **Step 1: Add failing ownerless and malformed lock tests**

Create an empty `.<identity>.lock` directory and another directory whose
`owner.json` is invalid JSON. Call `ensureKdInstallation` with one-millisecond
polling and assert each call publishes a valid entry and removes the public
lock:

```js
for (const [identity, owner] of [
  ["ownerless", undefined],
  ["malformed", "{not-json"]
]) {
  const lockRoot = join(cacheRoot, `.${identity}.lock`);
  mkdirSync(lockRoot, { recursive: true });
  if (owner !== undefined) {
    writeFileSync(join(lockRoot, "owner.json"), owner);
  }
  await expect(ensureKdInstallation({
    cacheRoot,
    identity,
    entrypoint: "kd",
    runtime,
    build: successfulFakeBuild,
    waitTimeoutMs: 100,
    pollIntervalMs: 1
  })).resolves.toBe(join(cacheRoot, `${identity}/bin/kd.js`));
  expect(existsSync(lockRoot)).toBe(false);
}
```

- [ ] **Step 2: Add a failing owner-publication cleanup test**

Inject an owner writer that throws and assert the original error is returned
while no cache entry beginning with `.publish-failure.lock` remains:

```js
await expect(ensureKdInstallation({
  cacheRoot,
  identity: "publish-failure",
  entrypoint: "kd",
  runtime,
  build: successfulFakeBuild,
  writeLockOwner: () => {
    throw new Error("synthetic owner write failure");
  }
})).rejects.toThrow("synthetic owner write failure");
expect(readdirSync(cacheRoot).filter((name) =>
  name.startsWith(".publish-failure.lock"))).toEqual([]);
```

- [ ] **Step 3: Run the focused tests and verify red**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: ownerless/malformed cases time out and the publication test fails
because `writeLockOwner` is not yet consumed.

### Task 2: Atomic owner publication

**Files:**
- Modify: `tools/kd/bin/kd-cache.mjs`

- [ ] **Step 1: Implement file and legacy-directory owner reads**

Use `lstatSync(lockRoot).isDirectory()` to select either
`join(lockRoot, "owner.json")` or `lockRoot`, then validate the existing PID
and token fields. Add a lock fingerprint from device, inode, size, mtime, and
ctime so unchanged invalid observations can be compared.

- [ ] **Step 2: Publish a private owner file with an exclusive hard link**

For each acquisition attempt, write `{ pid, token, startedAt }` to a unique
candidate beside the public lock, call `linkSync(candidate, lockRoot)`, and
remove the candidate in `finally`. Treat only `EEXIST` as contention. Forward
an injectable `writeLockOwner` from `ensureKdInstallation`; its production
default is `writeFileSync`.

- [ ] **Step 3: Recover only stable invalid locks**

When the owner cannot be parsed, record its fingerprint, wait one poll, and
quarantine it only if the next observation has the same fingerprint. Reset
the observation when a valid owner appears or the public path changes. Keep
the existing dead-owner quarantine and token-checked release semantics.

- [ ] **Step 4: Run the focused lock tests and verify green**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs --maxWorkers=1
```

Expected: all identity, publication, recovery, resolver, and cleanup tests
pass.

### Task 3: Real launcher and MCP integration

**Files:**
- Modify: `tools/kd/tests/cli.test.ts`

- [ ] **Step 1: Add process helpers and make two git fixtures**

Add an async `spawnResult` helper that captures stdout/stderr and rejects on
spawn errors or timeout. Copy the launcher fixture twice, initialize and
commit each fixture with Git, and use one shared `KANNA_KD_CACHE_ROOT`.

- [ ] **Step 2: Add a real MCP exchange helper**

Spawn `tools/kd/bin/kd-mcp` with piped stdio. Send newline-delimited
`initialize`, `notifications/initialized`, and `tools/list` messages. Parse
each stdout line as JSON, wait for response IDs 1 and 2, assert the initialize
server name is `kd`, assert `tools/list` contains `dev_up`, then close stdin
and require clean stderr.

- [ ] **Step 3: Replace the sequential launcher contract with concurrent cold launches**

Run `./kd env print` concurrently from both fixtures. Assert both exit zero,
each output contains its own fixture root, and the combined stderr contains
exactly one `Installing kd` line. Assert the shared cache has one non-dot
entry, `validateKdInstallation` accepts it for the current runtime, and no
dot-prefixed lock, candidate, temp, corrupt, or stale paths remain.

- [ ] **Step 4: Run both focused suites**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/kd-cache.test.mjs tests/cli.test.ts --maxWorkers=1
```

Expected: both suites pass, including two real cold launcher processes and
the MCP initialize/tools-list exchange.

### Task 4: Required repository verification

**Files:**
- Verify only.

- [ ] **Step 1: Run the full JavaScript suite**

Run:

```bash
pnpm test
```

Expected: all repository JavaScript/TypeScript tests pass.

- [ ] **Step 2: Run daemon Rust tests serially**

Run:

```bash
cd crates/daemon && cargo test -- --test-threads=1
```

Expected: all daemon tests pass.

- [ ] **Step 3: Inspect final worktree state**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the intended cache, test, spec, and
plan files are modified.
