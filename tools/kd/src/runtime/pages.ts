import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildConfigSchemaPagesInput {
  repoRoot: string;
  outDir: string;
}

interface CatalogGuideSection {
  body: string;
  schemaPaths?: string[];
}

interface CatalogFile {
  guides?: Array<{ sections: CatalogGuideSection[] }>;
}

function schemaNodeAtPointer(schema: unknown, pointer: string): Record<string, unknown> {
  let current: unknown = schema;
  for (const encodedPart of pointer.split("/").slice(1)) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new Error(`catalog guide references missing config schema path: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error(`catalog guide config schema path is not an object: ${pointer}`);
  }
  return current as Record<string, unknown>;
}

export function configSchemaWithCatalogDescriptions(repoRoot: string): Record<string, unknown> {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, ".kanna", "config.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, "crates", "kanna-tool-catalog", "src", "catalog.json"), "utf8"),
  ) as CatalogFile;

  for (const guide of catalog.guides ?? []) {
    for (const section of guide.sections) {
      for (const pointer of section.schemaPaths ?? []) {
        schemaNodeAtPointer(schema, pointer).description = section.body;
      }
    }
  }
  return schema;
}

// The artifact this builds is deployed by .github/workflows/config-schema-pages.yml
// through actions/upload-pages-artifact + actions/deploy-pages, which is why the
// repository's Pages source is "GitHub Actions". There is no kd publish command:
// publication happens on merge to main, not from a developer's machine.
export function buildConfigSchemaPages(input: BuildConfigSchemaPagesInput): string[] {
  mkdirSync(input.outDir, { recursive: true });
  const schemaOut = join(input.outDir, "config.schema.json");
  const cnameOut = join(input.outDir, "CNAME");
  const schema = configSchemaWithCatalogDescriptions(input.repoRoot);
  writeFileSync(schemaOut, `${JSON.stringify(schema, null, 2)}\n`);
  writeFileSync(cnameOut, "schemas.kanna.build\n");
  return [schemaOut, cnameOut];
}
