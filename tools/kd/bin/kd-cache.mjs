import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

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
