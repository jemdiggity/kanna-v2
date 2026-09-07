import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const crateUniverseExtension = "@@rules_rust+//crate_universe:extensions.bzl%crate";

interface CargoLockPackage {
  name?: unknown;
  dependencies?: unknown;
}

function parseTomlFile(path: string): Record<string, unknown> {
  return parseToml(readFileSync(resolve(repoRoot, path), "utf8")) as Record<string, unknown>;
}

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} is not an object`);
  }
  return value as Record<string, unknown>;
}

function registryManifestDependencies(manifestPath: string): string[] {
  const manifest = parseTomlFile(manifestPath);
  const dependencies = expectRecord(manifest.dependencies, `${manifestPath} [dependencies]`);

  return Object.entries(dependencies)
    .filter(([, specification]) => {
      if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
        return true;
      }
      // Workspace path dependencies use repository-native Bazel targets, not crate-universe labels.
      return typeof (specification as Record<string, unknown>).path !== "string";
    })
    .map(([name]) => name)
    .sort();
}

function extractBracedBlock(source: string, openingBrace: number, context: string): string {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingBrace, index + 1);
      }
    }
  }
  throw new Error(`${context} has no closing brace`);
}

function crateUniverseDirectDependencies(repository: string, packagePath: string): string[] {
  const moduleLock = expectRecord(
    JSON.parse(readFileSync(resolve(repoRoot, "MODULE.bazel.lock"), "utf8")) as unknown,
    "MODULE.bazel.lock"
  );
  const extensions = expectRecord(moduleLock.moduleExtensions, "MODULE.bazel.lock moduleExtensions");
  const extension = expectRecord(extensions[crateUniverseExtension], crateUniverseExtension);
  const general = expectRecord(extension.general, `${crateUniverseExtension} general`);
  const repoSpecs = expectRecord(general.generatedRepoSpecs, "crate universe generatedRepoSpecs");
  const repoSpec = expectRecord(repoSpecs[repository], `${repository} generated repo`);
  const attributes = expectRecord(repoSpec.attributes, `${repository} attributes`);
  const contents = expectRecord(attributes.contents, `${repository} contents`);
  const defs = contents["defs.bzl"];
  if (typeof defs !== "string") {
    throw new Error(`${repository} has no generated defs.bzl`);
  }

  const normalDependenciesStart = defs.indexOf("_NORMAL_DEPENDENCIES = {");
  const normalAliasesStart = defs.indexOf("_NORMAL_ALIASES = {", normalDependenciesStart);
  if (normalDependenciesStart < 0 || normalAliasesStart < 0) {
    throw new Error(`${repository} defs.bzl has no normal dependency map`);
  }
  const normalDependencies = defs.slice(normalDependenciesStart, normalAliasesStart);
  const packageMarker = `    "${packagePath}": {`;
  const packageStart = normalDependencies.indexOf(packageMarker);
  if (packageStart < 0) {
    throw new Error(`${repository} has no direct dependencies for ${packagePath}`);
  }
  const openingBrace = normalDependencies.indexOf("{", packageStart);
  const packageDependencies = extractBracedBlock(
    normalDependencies,
    openingBrace,
    `${repository} ${packagePath} dependency map`
  );

  return Array.from(packageDependencies.matchAll(/^\s+"([^"]+)": Label\("@[^/]+\/\//gm))
    .map((match) => match[1])
    .sort();
}

function catalogManifestDependencies(): string[] {
  const manifest = parseTomlFile("crates/kanna-tool-catalog/Cargo.toml");
  const dependencies = {
    ...expectRecord(manifest.dependencies, "kanna-tool-catalog Cargo.toml [dependencies]"),
    ...expectRecord(manifest["dev-dependencies"], "kanna-tool-catalog Cargo.toml [dev-dependencies]"),
  };
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error("kanna-tool-catalog Cargo.toml has no [dependencies] table");
  }

  return Object.entries(dependencies as Record<string, unknown>)
    .map(([name, specification]) => {
      if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
        return name;
      }
      const packageName = (specification as Record<string, unknown>).package;
      return typeof packageName === "string" ? packageName : name;
    })
    .sort();
}

function lockedCatalogDependencies(lockPath: string): string[] {
  const lock = parseTomlFile(lockPath);
  if (!Array.isArray(lock.package)) {
    throw new Error(`${lockPath} has no [[package]] entries`);
  }

  const catalog = (lock.package as CargoLockPackage[]).find(
    (lockedPackage) => lockedPackage.name === "kanna-tool-catalog"
  );
  if (!catalog || !Array.isArray(catalog.dependencies)) {
    throw new Error(`${lockPath} has no kanna-tool-catalog dependency list`);
  }

  return catalog.dependencies
    .map((dependency) => {
      if (typeof dependency !== "string") {
        throw new Error(`${lockPath} contains a non-string kanna-tool-catalog dependency`);
      }
      return dependency.split(" ", 1)[0];
    })
    .sort();
}

describe("Bazel release Cargo locks", () => {
  it("exposes every release sidecar registry dependency through all_crate_deps", () => {
    const releaseSidecars = [
      {
        manifestPath: "crates/kanna-cli/Cargo.toml",
        packagePath: "crates/kanna-cli",
        repository: "kanna_cli_crates"
      },
      {
        manifestPath: "crates/kanna-mcp/Cargo.toml",
        packagePath: "crates/kanna-mcp",
        repository: "kanna_mcp_crates"
      },
      {
        manifestPath: "crates/kanna-server/Cargo.toml",
        packagePath: "crates/kanna-server",
        repository: "kanna_server_crates"
      }
    ];

    for (const sidecar of releaseSidecars) {
      expect(
        crateUniverseDirectDependencies(sidecar.repository, sidecar.packagePath),
        sidecar.repository
      ).toEqual(registryManifestDependencies(sidecar.manifestPath));
    }
  });

  it("keeps every direct tool-catalog dependency in each release sidecar graph", () => {
    const manifestDependencies = catalogManifestDependencies();
    const releaseLocks = [
      "crates/kanna-cli/Cargo.lock",
      "crates/kanna-mcp/Cargo.lock",
      "crates/kanna-server/Cargo.lock"
    ];

    for (const lockPath of releaseLocks) {
      expect(lockedCatalogDependencies(lockPath), lockPath).toEqual(manifestDependencies);
    }
  });

  it("derives the CLI catalog target from the CLI synthetic workspace and lock", () => {
    const moduleBazel = readFileSync(resolve(repoRoot, "MODULE.bazel"), "utf8");
    const catalogBuild = readFileSync(
      resolve(repoRoot, "crates/kanna-tool-catalog/BUILD.bazel"),
      "utf8"
    );

    expect(moduleBazel).toMatch(
      /name = "kanna_cli_crates",\s+cargo_lockfile = "\/\/crates\/kanna-cli:Cargo\.lock",\s+manifests = \["\/\/:Cargo\.cli\.toml"\]/
    );
    expect(catalogBuild).toContain(
      'deps = all_crate_deps_for_cli(normal = True, package_name = "crates/kanna-tool-catalog")'
    );
  });
});
