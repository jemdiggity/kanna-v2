import assert from "node:assert/strict";
import type { Browser } from "playwright";
import {
  buildInstrumentedMobileDocument,
  waitForWrites
} from "./render.ts";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

const SAFE_REGION_CASES = [
  { name: "normal", bottomInset: 132 },
  { name: "multiline", bottomInset: 212 },
  { name: "keyboard", bottomInset: 446 },
  { name: "keyboard-multiline", bottomInset: 526 }
] as const;

interface ScrollSnapshot {
  baseY: number;
  viewportY: number;
  topLine: string;
}

export async function verifyTerminalSafeRegion(browser: Browser): Promise<void> {
  const page = await browser.newPage({ viewport: MOBILE_VIEWPORT });

  try {
    await page.setContent(await buildInstrumentedMobileDocument(132), {
      waitUntil: "load"
    });
    await page.waitForFunction(
      () =>
        typeof window.__setTerminalDims === "function" &&
        typeof window.__replaceTerminalState === "function"
    );

    await page.evaluate(() => {
      window.__setTerminalDims({ cols: 132, rows: 43 });
      window.__replaceTerminalState({
        chunksB64: Array.from({ length: 300 }, (_, index) =>
          btoa(`line ${index}\r\n`)
        )
      });
    });
    await waitForWrites(page);

    for (const safeRegionCase of SAFE_REGION_CASES) {
      await page.evaluate((bottomInset) => {
        window.__setTerminalBottomInset({ bottomInset });
      }, safeRegionCase.bottomInset);
      await waitForAnimationFrames(page, 2);

      const geometry = await page.evaluate((bottomInset) => {
        const host = document.querySelector<HTMLElement>(
          ".xterm-scrollable-element"
        );
        const legacyViewport = document.querySelector<HTMLElement>(
          ".xterm-viewport"
        );
        const screen = document.querySelector<HTMLElement>(".xterm-screen");
        const root = document.getElementById("terminal-root");
        if (!host || !legacyViewport || !screen || !root) {
          throw new Error("bundled xterm did not create its expected DOM");
        }

        return {
          hostBottom: host.getBoundingClientRect().bottom,
          screenBottom: screen.getBoundingClientRect().bottom,
          obstructionTop: window.innerHeight - bottomInset,
          hostContainsScreen: host.contains(screen),
          legacyContainsScreen: legacyViewport.contains(screen),
          appliedInset: root.dataset.kannaBottomInset
        };
      }, safeRegionCase.bottomInset);

      assert.ok(
        geometry.hostBottom <= geometry.obstructionTop + 1,
        `${safeRegionCase.name}: rendered xterm bottom ${geometry.hostBottom} ` +
          `overlaps obstruction beginning at ${geometry.obstructionTop}`
      );
      assert.ok(
        geometry.screenBottom <= geometry.obstructionTop + 1,
        `${safeRegionCase.name}: rendered xterm screen bottom ${geometry.screenBottom} ` +
          `overlaps obstruction beginning at ${geometry.obstructionTop}`
      );
      assert.equal(geometry.hostContainsScreen, true);
      assert.equal(geometry.legacyContainsScreen, false);
      assert.equal(
        geometry.appliedInset,
        String(safeRegionCase.bottomInset)
      );
    }

    await page.evaluate(() => {
      window.__setTerminalBottomInset({ bottomInset: 212 });
    });
    await waitForAnimationFrames(page, 2);

    const bottomBeforeManualScroll = await readScrollSnapshot(page);
    await page.mouse.move(100, 300);
    await page.mouse.wheel(0, -1200);
    await page.waitForFunction(
      (baseY) =>
        baseY - window.__kannaTerminals[0].buffer.active.viewportY >= 3,
      bottomBeforeManualScroll.baseY
    );
    const manualPosition = await readScrollSnapshot(page);

    await page.evaluate(() => {
      window.__appendTerminalChunk({
        chunksB64: [btoa("manual append\r\n")]
      });
    });
    await waitForWrites(page);
    const afterManualAppend = await readScrollSnapshot(page);

    assert.ok(afterManualAppend.baseY > manualPosition.baseY);
    assert.equal(afterManualAppend.viewportY, manualPosition.viewportY);
    assert.equal(afterManualAppend.topLine, manualPosition.topLine);

    await page.evaluate(() => {
      const term = window.__kannaTerminals[0];
      term.scrollToLine(term.buffer.active.baseY - 1);
    });
    await page.waitForFunction(
      () => {
        const buffer = window.__kannaTerminals[0].buffer.active;
        return buffer.baseY - buffer.viewportY === 1;
      }
    );
    const nearBottomBaseY = (
      await readScrollSnapshot(page)
    ).baseY;

    await page.evaluate(() => {
      window.__appendTerminalChunk({
        chunksB64: [btoa("near-bottom append\r\n")]
      });
    });
    await waitForWrites(page);
    const afterNearBottomAppend = await readScrollSnapshot(page);

    assert.ok(afterNearBottomAppend.baseY > nearBottomBaseY);
    assert.equal(
      afterNearBottomAppend.viewportY,
      afterNearBottomAppend.baseY
    );
  } finally {
    await page.close();
  }
}

async function readScrollSnapshot(
  page: Parameters<typeof waitForWrites>[0]
): Promise<ScrollSnapshot> {
  return await page.evaluate(() => {
    const buffer = window.__kannaTerminals[0].buffer.active;
    return {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      topLine: buffer.getLine(buffer.viewportY)?.translateToString(true) ?? ""
    };
  });
}

async function waitForAnimationFrames(
  page: Parameters<typeof waitForWrites>[0],
  frameCount: number
): Promise<void> {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frameCount);
}
