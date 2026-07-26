import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const KD_CACHE_SCHEMA = 1;
export const KD_CACHE_MAX_ENTRIES = 20;
export const KD_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const KD_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const KD_CACHE_ROOT_MARKER = ".kanna-kd-cache-root.json";
export const KD_ENTRYPOINTS = Object.freeze({
  kd: "bin/kd.js",
  "kd-mcp": "bin/kd-mcp.js"
});
const KD_IDENTITY_PATTERN = /^[0-9a-f]{64}$/;
const KD_CACHE_ROOT_MARKER_VALUE = Object.freeze({
  kind: "kanna-kd-cache",
  schema: KD_CACHE_SCHEMA
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function formatKdCacheEvent(event) {
  const context = `identity=${event.identity} cache=${event.cachePath} phase=${event.phase}`;
  switch (event.type) {
    case "install":
      return `Installing kd: ${context}`;
    case "wait":
      return `Waiting for kd installation: ${context}`;
    case "stale-lock-recovery":
      return `Recovering stale kd lock: ${context}`;
    case "corrupt-entry-recovery":
      return `Recovering corrupt kd installation: ${context}`;
    case "failure":
      return `kd installation failed: ${context}: ${event.error}`;
    default:
      throw new Error(`Unknown kd cache event: ${event.type}`);
  }
}

function emitCacheEvent(onCacheEvent, event) {
  if (typeof onCacheEvent !== "function") {
    return;
  }
  try {
    onCacheEvent(event);
  } catch {
    // Cache diagnostics must never change installation behavior.
  }
}

function installationFailure({
  identity,
  cachePath,
  phase,
  error,
  onCacheEvent
}) {
  const event = {
    type: "failure",
    identity,
    cachePath,
    phase,
    error: errorMessage(error)
  };
  emitCacheEvent(onCacheEvent, event);
  return new Error(formatKdCacheEvent(event), { cause: error });
}

const HASHED_KD_FILES = Object.freeze([
  "tools/kd/package.json",
  "tools/kd/tsconfig.json",
  "tools/kd/tsup.config.ts",
  "pnpm-workspace.yaml"
]);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function dependencyKey(name, version, snapshots) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`kd lockfile dependency ${name} has no resolved version`);
  }
  if (version.startsWith("link:") || version.startsWith("workspace:")) {
    throw new Error(`kd lockfile dependency ${name} is not an installable package`);
  }
  if (version.startsWith("npm:")) {
    return version.slice("npm:".length);
  }
  const conventional = `${name}@${version}`;
  if (snapshots?.[conventional] || !snapshots) {
    return conventional;
  }
  return snapshots[version] ? version : conventional;
}

function packageMetadata(packages, snapshotKey) {
  if (packages[snapshotKey]) {
    return packages[snapshotKey];
  }
  const peerSuffix = snapshotKey.indexOf("(");
  const baseKey = peerSuffix === -1 ? snapshotKey : snapshotKey.slice(0, peerSuffix);
  const metadata = packages[baseKey];
  if (!metadata) {
    throw new Error(`kd lockfile package metadata is missing for ${snapshotKey}`);
  }
  return metadata;
}

export function kdDependencyProjection(lockfile) {
  const importer = lockfile?.importers?.["tools/kd"];
  if (!importer) {
    throw new Error("pnpm lockfile is missing the tools/kd importer");
  }

  const snapshots = lockfile.snapshots ?? {};
  const packages = lockfile.packages ?? {};
  const roots = [
    ...Object.entries(importer.dependencies ?? {}).map(([name, value]) =>
      dependencyKey(name, value.version, snapshots)
    )
  ];
  const tsup = importer.devDependencies?.tsup;
  if (!tsup) {
    throw new Error("pnpm lockfile tools/kd importer is missing tsup");
  }
  roots.push(dependencyKey("tsup", tsup.version, snapshots));
  roots.sort();

  const selectedSnapshots = {};
  const selectedPackages = {};
  const pending = [...roots];
  const visited = new Set();

  while (pending.length > 0) {
    const key = pending.pop();
    if (visited.has(key)) {
      continue;
    }
    const snapshot = snapshots[key];
    if (!snapshot) {
      throw new Error(`kd lockfile snapshot is missing for ${key}`);
    }
    visited.add(key);
    selectedSnapshots[key] = snapshot;

    const metadataKey = packages[key]
      ? key
      : key.slice(0, key.indexOf("(") === -1 ? key.length : key.indexOf("("));
    selectedPackages[metadataKey] = packageMetadata(packages, key);

    for (const dependencies of [
      snapshot.dependencies ?? {},
      snapshot.optionalDependencies ?? {}
    ]) {
      for (const [name, version] of Object.entries(dependencies)) {
        pending.push(dependencyKey(name, version, snapshots));
      }
    }
  }

  return canonicalize({
    lockfileVersion: lockfile.lockfileVersion,
    settings: lockfile.settings ?? {},
    packageExtensionsChecksum: lockfile.packageExtensionsChecksum ?? null,
    roots,
    packages: selectedPackages,
    snapshots: selectedSnapshots
  });
}

function collectRegularFiles(root, directory, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`kd build input must not be a symlink: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) {
      collectRegularFiles(root, path, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`kd build input must be a regular file: ${relative(root, path)}`);
    }
    output.push(path);
  }
}

function updateHashWithFile(hash, repoRoot, path) {
  const relativePath = relative(repoRoot, path).split(sep).join("/");
  const bytes = readFileSync(path);
  hash.update(`${relativePath.length}:${relativePath}:${bytes.length}:`);
  hash.update(bytes);
}

export async function computeKdIdentity({ repoRoot, lockfile, runtime }) {
  const hash = createHash("sha256");
  hash.update(`kd-cache-schema:${KD_CACHE_SCHEMA}\n`);
  hash.update(`${JSON.stringify(canonicalize(runtime))}\n`);
  hash.update(`${JSON.stringify(kdDependencyProjection(lockfile))}\n`);

  for (const relativePath of HASHED_KD_FILES) {
    updateHashWithFile(hash, repoRoot, join(repoRoot, relativePath));
  }

  const sourceFiles = [];
  collectRegularFiles(repoRoot, join(repoRoot, "tools/kd/src"), sourceFiles);
  for (const path of sourceFiles) {
    updateHashWithFile(hash, repoRoot, path);
  }
  return hash.digest("hex");
}

export function resolveKdCacheRoot({
  platform = process.platform,
  home = homedir(),
  env = process.env
} = {}) {
  if (env.KANNA_KD_CACHE_ROOT?.trim()) {
    return resolve(env.KANNA_KD_CACHE_ROOT);
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "kanna", "tools", "kd");
  }
  if (env.XDG_CACHE_HOME?.trim()) {
    return join(env.XDG_CACHE_HOME, "kanna", "tools", "kd");
  }
  return join(home, ".cache", "kanna", "tools", "kd");
}

export function writeKdManifest(outputDir, identity, runtime) {
  writeFileSync(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(
      {
        schema: KD_CACHE_SCHEMA,
        identity,
        runtime,
        entrypoints: KD_ENTRYPOINTS
      },
      null,
      2
    )}\n`
  );
}

function readKdManifest(entryDir) {
  try {
    return JSON.parse(readFileSync(join(entryDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function validateKdInstallationOwnership(entryDir, identity) {
  const manifest = readKdManifest(entryDir);
  if (
    !manifest ||
    manifest.schema !== KD_CACHE_SCHEMA ||
    manifest.identity !== identity
  ) {
    return false;
  }
  try {
    return Object.entries(KD_ENTRYPOINTS).every(
      ([name, path]) =>
        manifest.entrypoints?.[name] === path &&
        statSync(join(entryDir, path)).isFile()
    );
  } catch {
    return false;
  }
}

export function validateKdInstallation(entryDir, identity, runtime) {
  const manifest = readKdManifest(entryDir);
  return (
    validateKdInstallationOwnership(entryDir, identity) &&
    JSON.stringify(manifest.runtime) === JSON.stringify(runtime)
  );
}

function canonicalBoundary(path) {
  const resolvedPath = resolve(path);
  try {
    return realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isRecognizedLegacyCacheEntry(cacheRoot, entry) {
  if (entry.name === KD_CACHE_ROOT_MARKER) {
    return true;
  }
  if (entry.name.startsWith(".")) {
    return (
      entry.name === ".reclamation.guard" ||
      /^\.[0-9a-f]{64}\.(?:used|lock|lease-.+)$/.test(entry.name)
    );
  }
  return (
    entry.isDirectory() &&
    KD_IDENTITY_PATTERN.test(entry.name) &&
    validateKdInstallationOwnership(join(cacheRoot, entry.name), entry.name)
  );
}

function validateKdCacheRootMarker(markerPath, readMarker = readFileSync) {
  let marker;
  try {
    marker = JSON.parse(readMarker(markerPath, "utf8"));
  } catch {
    throw new Error(`Kd cache root marker is invalid: ${markerPath}`);
  }
  if (
    marker.kind !== KD_CACHE_ROOT_MARKER_VALUE.kind ||
    marker.schema !== KD_CACHE_ROOT_MARKER_VALUE.schema
  ) {
    throw new Error(`Kd cache root marker is invalid: ${markerPath}`);
  }
}

export function initializeKdCacheRoot({
  cacheRoot,
  home = homedir(),
  tempRoot = tmpdir(),
  allowLegacyAdoption = false,
  writeMarker = writeFileSync,
  readMarker = readFileSync,
  waitForMarkerPublication = (delayMs) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}) {
  const resolvedRoot = resolve(cacheRoot);
  const unsafeRoots = new Set([
    parse(resolvedRoot).root,
    canonicalBoundary(home),
    canonicalBoundary(tempRoot)
  ]);
  if (unsafeRoots.has(canonicalBoundary(resolvedRoot))) {
    throw new Error(`Unsafe kd cache root: ${resolvedRoot}`);
  }
  if (existsSync(resolvedRoot) && lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error(`Unsafe kd cache root symlink: ${resolvedRoot}`);
  }
  mkdirSync(resolvedRoot, { recursive: true });
  const canonicalRoot = realpathSync(resolvedRoot);
  if (unsafeRoots.has(canonicalRoot)) {
    throw new Error(`Unsafe kd cache root: ${canonicalRoot}`);
  }

  const markerPath = join(resolvedRoot, KD_CACHE_ROOT_MARKER);
  if (existsSync(markerPath)) {
    validateKdCacheRootMarker(markerPath, readMarker);
    return resolvedRoot;
  }

  const entries = readdirSync(resolvedRoot, { withFileTypes: true });
  if (
    entries.length > 0 &&
    !(
      allowLegacyAdoption &&
      entries.every((entry) => isRecognizedLegacyCacheEntry(resolvedRoot, entry))
    )
  ) {
    throw new Error(`Cache root is not owned by kd: ${canonicalRoot}`);
  }
  try {
    writeMarker(
      markerPath,
      `${JSON.stringify(KD_CACHE_ROOT_MARKER_VALUE)}\n`,
      { flag: "wx", mode: 0o600 }
    );
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    let markerError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        validateKdCacheRootMarker(markerPath, readMarker);
        markerError = undefined;
        break;
      } catch (validationError) {
        markerError = validationError;
        if (attempt < 19) {
          waitForMarkerPublication(5);
        }
      }
    }
    if (markerError) {
      throw markerError;
    }
  }
  return resolvedRoot;
}

function kdUseMarkerPath(cacheRoot, identity) {
  return join(cacheRoot, `.${identity}.used`);
}

export function createKdInstallationLease({
  cacheRoot,
  identity,
  pid,
  now = Date.now()
}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`kd installation lease requires a positive pid, got ${pid}`);
  }
  cacheRoot = initializeKdCacheRoot({ cacheRoot });
  const releaseGuard = acquireCacheReclamationGuard({
    cacheRoot,
    isProcessAlive: defaultIsProcessAlive
  });
  try {
    const token = randomUUID();
    const leasePath = join(cacheRoot, `.${identity}.lease-${pid}-${token}`);
    writeFileSync(
      leasePath,
      `${JSON.stringify({ identity, pid, token, startedAt: now })}\n`,
      { flag: "wx", mode: 0o600 }
    );
    writeFileSync(kdUseMarkerPath(cacheRoot, identity), `${now}\n`, {
      mode: 0o600
    });
    return leasePath;
  } finally {
    releaseGuard();
  }
}

function directoryBytes(path) {
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      bytes += directoryBytes(child);
    } else if (entry.isFile()) {
      bytes += statSync(child).size;
    }
  }
  return bytes;
}

function readLease(path) {
  try {
    const lease = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof lease.identity !== "string" ||
      lease.identity.length === 0 ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0
    ) {
      return null;
    }
    return lease;
  } catch {
    return null;
  }
}

function installationLastUsedAt(cacheRoot, identity, entryRoot) {
  try {
    return statSync(kdUseMarkerPath(cacheRoot, identity)).mtimeMs;
  } catch {
    return statSync(entryRoot).mtimeMs;
  }
}

function removeKdInstallation(cacheRoot, entry) {
  rmSync(entry.path, { recursive: true, force: true });
  rmSync(kdUseMarkerPath(cacheRoot, entry.identity), { force: true });
}

export function pruneKdInstallations({
  cacheRoot,
  currentIdentity,
  now = Date.now(),
  maxEntries = KD_CACHE_MAX_ENTRIES,
  maxBytes = KD_CACHE_MAX_BYTES,
  maxAgeMs = KD_CACHE_MAX_AGE_MS,
  isProcessAlive = defaultIsProcessAlive,
  home = homedir(),
  tempRoot = tmpdir()
}) {
  if (!existsSync(cacheRoot)) {
    return { removedIdentities: [], retainedEntries: 0, retainedBytes: 0 };
  }
  cacheRoot = initializeKdCacheRoot({ cacheRoot, home, tempRoot });
  const releaseGuard = acquireCacheReclamationGuard({
    cacheRoot,
    isProcessAlive
  });
  try {
    return pruneKdInstallationsLocked({
      cacheRoot,
      currentIdentity,
      now,
      maxEntries,
      maxBytes,
      maxAgeMs,
      isProcessAlive
    });
  } finally {
    releaseGuard();
  }
}

function pruneKdInstallationsLocked({
  cacheRoot,
  currentIdentity,
  now,
  maxEntries,
  maxBytes,
  maxAgeMs,
  isProcessAlive
}) {
  const names = readdirSync(cacheRoot).sort();
  const fencedIdentities = new Set([currentIdentity]);
  for (const name of names) {
    if (!name.startsWith(".") || !name.includes(".lease-")) {
      continue;
    }
    const leasePath = join(cacheRoot, name);
    const lease = readLease(leasePath);
    if (lease && isProcessAlive(lease.pid)) {
      fencedIdentities.add(lease.identity);
    } else {
      rmSync(leasePath, { force: true });
    }
  }
  for (const name of names) {
    if (!name.startsWith(".") || !name.endsWith(".lock")) {
      continue;
    }
    const identity = name.slice(1, -".lock".length);
    const owner = readLockOwner(join(cacheRoot, name));
    if (!owner || isProcessAlive(owner.pid)) {
      fencedIdentities.add(identity);
    }
  }

  let entries = readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory() &&
      KD_IDENTITY_PATTERN.test(entry.name) &&
      validateKdInstallationOwnership(join(cacheRoot, entry.name), entry.name)
    )
    .map((entry) => {
      const path = join(cacheRoot, entry.name);
      return {
        identity: entry.name,
        path,
        bytes: directoryBytes(path),
        lastUsedAt: installationLastUsedAt(cacheRoot, entry.name, path),
      };
    })
    .sort((left, right) =>
      left.lastUsedAt - right.lastUsedAt ||
      left.identity.localeCompare(right.identity)
    );
  const removedIdentities = [];
  const removeEntry = (entry) => {
    removeKdInstallation(cacheRoot, entry);
    removedIdentities.push(entry.identity);
  };

  const expired = entries.filter((entry) =>
    !fencedIdentities.has(entry.identity) &&
    Number.isFinite(maxAgeMs) &&
    now - entry.lastUsedAt > maxAgeMs
  );
  for (const entry of expired) {
    removeEntry(entry);
  }
  const expiredIds = new Set(expired.map((entry) => entry.identity));
  entries = entries.filter((entry) => !expiredIds.has(entry.identity));

  let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  for (const entry of [...entries]) {
    if (entries.length <= maxEntries && retainedBytes <= maxBytes) {
      break;
    }
    if (fencedIdentities.has(entry.identity)) {
      continue;
    }
    removeEntry(entry);
    entries = entries.filter((candidate) => candidate.identity !== entry.identity);
    retainedBytes -= entry.bytes;
  }

  return {
    removedIdentities,
    retainedEntries: entries.length,
    retainedBytes,
  };
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function lockOwnerPath(lockRoot) {
  try {
    const lockStat = lstatSync(lockRoot);
    if (lockStat.isDirectory()) {
      return join(lockRoot, "owner.json");
    }
    return lockStat.isFile() ? lockRoot : null;
  } catch {
    return null;
  }
}

function readLockOwner(lockRoot) {
  try {
    const ownerPath = lockOwnerPath(lockRoot);
    if (!ownerPath) {
      return null;
    }
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== "string" ||
      owner.token.length === 0
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function acquireCacheReclamationGuard({
  cacheRoot,
  isProcessAlive,
  pid = process.pid,
  waitTimeoutMs = 30_000
}) {
  const guardRoot = join(cacheRoot, ".reclamation.guard");
  const startedAt = Date.now();
  const token = randomUUID();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    const candidateRoot = `${guardRoot}.candidate-${token}`;
    try {
      writeFileSync(
        candidateRoot,
        `${JSON.stringify({ pid, token, startedAt: Date.now() })}\n`,
        { flag: "wx", mode: 0o600 }
      );
      linkSync(candidateRoot, guardRoot);
      return () => removeOwnedLock(guardRoot, token);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    } finally {
      rmSync(candidateRoot, { force: true });
    }

    const owner = readLockOwner(guardRoot);
    if (owner && !isProcessAlive(owner.pid)) {
      quarantineLock(guardRoot);
      continue;
    }
    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error("Timed out waiting for kd cache reclamation guard");
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

function statFingerprint(path) {
  try {
    const value = lstatSync(path, { bigint: true });
    return [
      value.dev,
      value.ino,
      value.mode,
      value.size,
      value.mtimeNs,
      value.ctimeNs
    ].join(":");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function lockFingerprint(lockRoot) {
  const rootFingerprint = statFingerprint(lockRoot);
  if (rootFingerprint === null) {
    return null;
  }
  const ownerPath = lockOwnerPath(lockRoot);
  return `${rootFingerprint}|${
    ownerPath && ownerPath !== lockRoot
      ? statFingerprint(ownerPath) ?? "owner-missing"
      : "owner-is-lock"
  }`;
}

function removeOwnedLock(lockRoot, token) {
  const owner = readLockOwner(lockRoot);
  if (owner?.token === token) {
    rmSync(lockRoot, { recursive: true, force: true });
  }
}

function quarantineLock(lockRoot) {
  const staleRoot = `${lockRoot}.stale-${randomUUID()}`;
  try {
    renameSync(lockRoot, staleRoot);
    rmSync(staleRoot, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function acquireInstallationLock({
  cacheRoot,
  entryRoot,
  identity,
  pid,
  isProcessAlive,
  onCacheEvent,
  writeLockOwner,
  sleep,
  waitTimeoutMs,
  pollIntervalMs
}) {
  const lockRoot = join(cacheRoot, `.${identity}.lock`);
  const startedAt = Date.now();
  let invalidFingerprint;
  let reportedWait = false;

  while (true) {
    const token = randomUUID();
    const candidateRoot = `${lockRoot}.candidate-${token}`;
    try {
      writeLockOwner(
        candidateRoot,
        `${JSON.stringify({ pid, token, startedAt: Date.now() })}\n`,
        { flag: "wx", mode: 0o600 }
      );
      linkSync(candidateRoot, lockRoot);
      return { lockRoot, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    } finally {
      rmSync(candidateRoot, { force: true });
    }

    if (!reportedWait) {
      emitCacheEvent(onCacheEvent, {
        type: "wait",
        identity,
        cachePath: entryRoot,
        phase: "lock"
      });
      reportedWait = true;
    }

    const owner = readLockOwner(lockRoot);
    if (owner) {
      invalidFingerprint = undefined;
      if (!isProcessAlive(owner.pid) && quarantineLock(lockRoot)) {
        emitCacheEvent(onCacheEvent, {
          type: "stale-lock-recovery",
          identity,
          cachePath: lockRoot,
          phase: "lock-recovery"
        });
        continue;
      }
    } else {
      const currentFingerprint = lockFingerprint(lockRoot);
      if (currentFingerprint === null) {
        invalidFingerprint = undefined;
        continue;
      }
      if (
        invalidFingerprint === currentFingerprint &&
        quarantineLock(lockRoot)
      ) {
        emitCacheEvent(onCacheEvent, {
          type: "stale-lock-recovery",
          identity,
          cachePath: lockRoot,
          phase: "lock-recovery"
        });
        invalidFingerprint = undefined;
        continue;
      }
      invalidFingerprint = currentFingerprint;
    }

    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error(
        `Timed out waiting for kd installation ${identity} after ${waitTimeoutMs}ms`
      );
    }
    await sleep(pollIntervalMs);
  }
}

export async function ensureKdInstallation({
  cacheRoot,
  identity,
  entrypoint,
  runtime,
  build,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  writeLockOwner = writeFileSync,
  sleep = delay,
  waitTimeoutMs = 180_000,
  pollIntervalMs = 100,
  onCacheEvent
}) {
  const entrypointPath = KD_ENTRYPOINTS[entrypoint];
  if (!entrypointPath) {
    throw new Error(`Unknown kd entrypoint: ${entrypoint}`);
  }

  cacheRoot = initializeKdCacheRoot({ cacheRoot });
  const entryRoot = join(cacheRoot, identity);
  if (validateKdInstallation(entryRoot, identity, runtime)) {
    return join(entryRoot, entrypointPath);
  }

  let lock;
  try {
    lock = await acquireInstallationLock({
      cacheRoot,
      entryRoot,
      identity,
      pid,
      isProcessAlive,
      onCacheEvent,
      writeLockOwner,
      sleep,
      waitTimeoutMs,
      pollIntervalMs
    });
  } catch (error) {
    throw installationFailure({
      identity,
      cachePath: entryRoot,
      phase: "lock",
      error,
      onCacheEvent
    });
  }

  let temporaryRoot;
  let corruptRoot;
  let resolvedEntrypoint;
  let failure;
  let phase = "validation";

  try {
    if (validateKdInstallation(entryRoot, identity, runtime)) {
      resolvedEntrypoint = join(entryRoot, entrypointPath);
    } else {
      emitCacheEvent(onCacheEvent, {
        type: "install",
        identity,
        cachePath: entryRoot,
        phase: "install"
      });

      if (existsSync(entryRoot)) {
        phase = "corrupt-entry-recovery";
        corruptRoot = join(cacheRoot, `.${identity}.corrupt-${randomUUID()}`);
        renameSync(entryRoot, corruptRoot);
        emitCacheEvent(onCacheEvent, {
          type: "corrupt-entry-recovery",
          identity,
          cachePath: entryRoot,
          phase: "recovery"
        });
      }

      phase = "temporary-directory";
      temporaryRoot = mkdtempSync(join(cacheRoot, `.${identity}.tmp-`));
      phase = "build";
      await build({ outputDir: temporaryRoot, identity, runtime });
      phase = "build-validation";
      if (!validateKdInstallation(temporaryRoot, identity, runtime)) {
        throw new Error(
          `kd build ${identity} did not produce a valid cache installation`
        );
      }

      phase = "publication";
      try {
        renameSync(temporaryRoot, entryRoot);
        temporaryRoot = undefined;
      } catch (error) {
        if (
          error?.code !== "EEXIST" ||
          !validateKdInstallation(entryRoot, identity, runtime)
        ) {
          throw error;
        }
      }

      if (corruptRoot) {
        phase = "corrupt-entry-cleanup";
        rmSync(corruptRoot, { recursive: true, force: true });
        corruptRoot = undefined;
      }
      resolvedEntrypoint = join(entryRoot, entrypointPath);
    }
  } catch (error) {
    failure = installationFailure({
      identity,
      cachePath: entryRoot,
      phase,
      error,
      onCacheEvent
    });
  }

  try {
    if (temporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
    removeOwnedLock(lock.lockRoot, lock.token);
  } catch (error) {
    if (!failure) {
      failure = installationFailure({
        identity,
        cachePath: entryRoot,
        phase: "cleanup",
        error,
        onCacheEvent
      });
    }
  }

  if (failure) {
    throw failure;
  }
  return resolvedEntrypoint;
}
