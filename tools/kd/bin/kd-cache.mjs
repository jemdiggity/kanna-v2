import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const KD_CACHE_SCHEMA = 1;
export const KD_ENTRYPOINTS = Object.freeze({
  kd: "bin/kd.js",
  "kd-mcp": "bin/kd-mcp.js"
});

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

function dependencyKey(name, version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`kd lockfile dependency ${name} has no resolved version`);
  }
  if (version.startsWith("link:") || version.startsWith("workspace:")) {
    throw new Error(`kd lockfile dependency ${name} is not an installable package`);
  }
  return `${name}@${version}`;
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

  const roots = [
    ...Object.entries(importer.dependencies ?? {}).map(([name, value]) =>
      dependencyKey(name, value.version)
    )
  ];
  const tsup = importer.devDependencies?.tsup;
  if (!tsup) {
    throw new Error("pnpm lockfile tools/kd importer is missing tsup");
  }
  roots.push(dependencyKey("tsup", tsup.version));
  roots.sort();

  const snapshots = lockfile.snapshots ?? {};
  const packages = lockfile.packages ?? {};
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
        pending.push(dependencyKey(name, version));
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

export function validateKdInstallation(entryDir, identity, runtime) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(entryDir, "manifest.json"), "utf8")
    );
    return (
      manifest.schema === KD_CACHE_SCHEMA &&
      manifest.identity === identity &&
      JSON.stringify(manifest.runtime) === JSON.stringify(runtime) &&
      Object.entries(KD_ENTRYPOINTS).every(
        ([name, path]) =>
          manifest.entrypoints?.[name] === path &&
          statSync(join(entryDir, path)).isFile()
      )
    );
  } catch {
    return false;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readLockOwner(lockRoot) {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockRoot, "owner.json"), "utf8")
    );
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

function removeOwnedLock(lockRoot, token) {
  const owner = readLockOwner(lockRoot);
  if (owner?.token === token) {
    rmSync(lockRoot, { recursive: true, force: true });
  }
}

async function acquireInstallationLock({
  cacheRoot,
  identity,
  pid,
  isProcessAlive,
  sleep,
  waitTimeoutMs,
  pollIntervalMs
}) {
  const lockRoot = join(cacheRoot, `.${identity}.lock`);
  const startedAt = Date.now();

  while (true) {
    const token = randomUUID();
    try {
      mkdirSync(lockRoot);
      writeFileSync(
        join(lockRoot, "owner.json"),
        `${JSON.stringify({ pid, token, startedAt: Date.now() })}\n`
      );
      return { lockRoot, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const owner = readLockOwner(lockRoot);
    if (owner && !isProcessAlive(owner.pid)) {
      const staleRoot = `${lockRoot}.stale-${randomUUID()}`;
      try {
        renameSync(lockRoot, staleRoot);
        rmSync(staleRoot, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
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
  sleep = delay,
  waitTimeoutMs = 180_000,
  pollIntervalMs = 100
}) {
  const entrypointPath = KD_ENTRYPOINTS[entrypoint];
  if (!entrypointPath) {
    throw new Error(`Unknown kd entrypoint: ${entrypoint}`);
  }

  const entryRoot = join(cacheRoot, identity);
  if (validateKdInstallation(entryRoot, identity, runtime)) {
    return join(entryRoot, entrypointPath);
  }

  mkdirSync(cacheRoot, { recursive: true });
  const lock = await acquireInstallationLock({
    cacheRoot,
    identity,
    pid,
    isProcessAlive,
    sleep,
    waitTimeoutMs,
    pollIntervalMs
  });
  let temporaryRoot;
  let corruptRoot;

  try {
    if (validateKdInstallation(entryRoot, identity, runtime)) {
      return join(entryRoot, entrypointPath);
    }

    if (existsSync(entryRoot)) {
      corruptRoot = join(cacheRoot, `.${identity}.corrupt-${randomUUID()}`);
      renameSync(entryRoot, corruptRoot);
    }

    temporaryRoot = mkdtempSync(join(cacheRoot, `.${identity}.tmp-`));
    await build({ outputDir: temporaryRoot, identity, runtime });
    if (!validateKdInstallation(temporaryRoot, identity, runtime)) {
      throw new Error(
        `kd build ${identity} did not produce a valid cache installation`
      );
    }

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
      rmSync(corruptRoot, { recursive: true, force: true });
      corruptRoot = undefined;
    }
    return join(entryRoot, entrypointPath);
  } finally {
    if (temporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
    removeOwnedLock(lock.lockRoot, lock.token);
  }
}
