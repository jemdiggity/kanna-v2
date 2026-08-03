import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildConfigSchemaPagesInput {
  repoRoot: string;
  outDir: string;
}

// The artifact this builds is deployed by .github/workflows/config-schema-pages.yml
// through actions/upload-pages-artifact + actions/deploy-pages, which is why the
// repository's Pages source is "GitHub Actions". There is no kd publish command:
// publication happens on merge to main, not from a developer's machine.
export function buildConfigSchemaPages(input: BuildConfigSchemaPagesInput): string[] {
  mkdirSync(input.outDir, { recursive: true });
  const schemaOut = join(input.outDir, "config.schema.json");
  const cnameOut = join(input.outDir, "CNAME");
  copyFileSync(join(input.repoRoot, ".kanna", "config.schema.json"), schemaOut);
  writeFileSync(cnameOut, "schemas.kanna.build\n");
  return [schemaOut, cnameOut];
}
