import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { diffGrids, formatResult } from "./diff.ts";
import { emitFixtureFrames } from "./emitter.ts";
import { writeFixtures } from "./fixtures.ts";
import { ARTIFACT_DIR, FIXTURE_DIR, GOLDEN_DIR } from "./paths.ts";
import { renderPathGrid, renderReferenceGrid } from "./render.ts";
import type { FixtureResult } from "./types.ts";

const COLS = 220;
const ROWS = 48;

async function main(): Promise<void> {
  const updateGoldens = process.argv.includes("--update-goldens");
  await mkdir(GOLDEN_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const fixtures = await writeFixtures();
  const browser = await chromium.launch();
  const results: FixtureResult[] = [];
  try {
    for (const fixture of fixtures) {
      const fixturePath = path.join(FIXTURE_DIR, `${fixture.name}.ansi`);
      const emitted = await emitFixtureFrames({
        fixturePath,
        cols: COLS,
        rows: ROWS,
        snapshotAt: fixture.snapshotAt
      });
      if (emitted.used_visible_text_fallback && !fixture.allowFallback) {
        throw new Error(`${fixture.name} unexpectedly used visible_text_vt fallback`);
      }
      const pathGrid = await renderPathGrid(browser, emitted);
      const referenceGrid = await renderReferenceGrid(browser, fixture.name, fixture.bytes, pathGrid.rows);
      const result = diffGrids(
        fixture.name,
        fixture.description,
        fixture.snapshotAt,
        emitted.used_visible_text_fallback,
        pathGrid,
        referenceGrid
      );
      results.push(result);
      process.stdout.write(`${formatResult(result)}\n`);
      await verifyGolden(result, updateGoldens);
    }
  } finally {
    await browser.close();
  }

  await writeFile(
    path.join(ARTIFACT_DIR, "summary.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`
  );
}

async function verifyGolden(result: FixtureResult, updateGoldens: boolean): Promise<void> {
  const goldenPath = path.join(GOLDEN_DIR, `${result.name}.json`);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (updateGoldens) {
    await writeFile(goldenPath, serialized);
    return;
  }

  let expected: string;
  try {
    expected = await readFile(goldenPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`missing golden for ${result.name}; run pnpm test:tui-fidelity -- --update-goldens`);
    }
    throw error;
  }

  if (expected !== serialized) {
    throw new Error(`golden mismatch for ${result.name}; run pnpm test:tui-fidelity -- --update-goldens after reviewing artifacts`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
