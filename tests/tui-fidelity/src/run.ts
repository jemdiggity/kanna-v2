import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { diffGrids, formatResult } from "./diff.ts";
import { emitFixtureFrames } from "./emitter.ts";
import { writeFixtures } from "./fixtures.ts";
import { ARTIFACT_DIR, FIXTURE_DIR, GOLDEN_DIR } from "./paths.ts";
import {
  renderPathGrid,
  renderReferenceGrid,
  renderSessionStorePathGrid,
  verifyMobileEasedScrolling,
  verifyMobileTerminalSelection
} from "./render.ts";
import { verifyTerminalSafeRegion } from "./terminalSafeRegion.ts";
import type { FixtureResult } from "./types.ts";

const DEFAULT_COLS = 220;
const DEFAULT_ROWS = 48;

async function main(): Promise<void> {
  const updateGoldens = process.argv.includes("--update-goldens");
  await mkdir(GOLDEN_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const fixtures = await writeFixtures();
  const browser = await chromium.launch();
  const results: FixtureResult[] = [];
  try {
    await verifyTerminalSafeRegion(browser);
    process.stdout.write("PASS terminal-safe-region\n");
    await verifyMobileEasedScrolling(browser);
    process.stdout.write("PASS mobile-eased-scrolling\n");
    await verifyMobileTerminalSelection(browser);
    process.stdout.write("PASS mobile-terminal-selection\n");
    for (const fixture of fixtures) {
      const fixturePath = path.join(FIXTURE_DIR, `${fixture.name}.ansi`);
      const cols = fixture.cols ?? DEFAULT_COLS;
      const rows = fixture.rows ?? DEFAULT_ROWS;
      const emitted = await emitFixtureFrames({
        fixturePath,
        cols,
        rows,
        snapshotAt: fixture.snapshotAt,
        resnapshotAt: fixture.resnapshotAt,
        chunkPattern: fixture.chunkPattern
      });
      if (emitted.used_visible_text_fallback && !fixture.allowFallback) {
        throw new Error(`${fixture.name} unexpectedly used visible_text_vt fallback`);
      }
      const sessionStoreResult = fixture.replayThroughSessionStore
        ? await renderSessionStorePathGrid(browser, emitted)
        : null;
      const pathGrid = sessionStoreResult?.grid ?? await renderPathGrid(browser, emitted);
      if (fixture.replayThroughSessionStore && pathGrid.serialized.trim().length === 0) {
        throw new Error(`${fixture.name} rendered a blank terminal after sessionStore replay`);
      }
      if (fixture.assertStreamCompaction) {
        if (!sessionStoreResult) {
          throw new Error(`${fixture.name} did not use the sessionStore render path`);
        }
        const { metrics } = sessionStoreResult;
        if (metrics.maxRetainedStart <= 0) {
          throw new Error(`${fixture.name} did not cross the retained-history cap`);
        }
        if (metrics.snapshotCount !== 2 || metrics.replaceCount !== metrics.snapshotCount) {
          throw new Error(
            `${fixture.name} expected one replacement per authoritative snapshot; ` +
            `snapshots=${metrics.snapshotCount}, replacements=${metrics.replaceCount}`
          );
        }
        if (metrics.appendCount <= 0) {
          throw new Error(`${fixture.name} did not exercise live append mutations`);
        }
        const visibleText = pathGrid.cells.map((cell) => cell.chars).join("");
        if (!visibleText.includes("230s") || !visibleText.includes("esc to interrupt")) {
          throw new Error(
            `${fixture.name} lost static or changing status text after compaction/reconnect`
          );
        }
      }
      const referenceGrid = await renderReferenceGrid(
        browser,
        fixture.name,
        fixture.bytes,
        emitted.cols,
        emitted.rows
      );
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
