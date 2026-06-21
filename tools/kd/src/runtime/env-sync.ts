import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeCargoConfig(repoRoot: string): string {
  const path = join(repoRoot, ".cargo", "config.toml");
  mkdirSync(join(repoRoot, ".cargo"), { recursive: true });
  writeFileSync(path, `[build]\ntarget-dir = ".build"\n`);
  return path;
}
