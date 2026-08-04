import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { buildInstrumentedMobileDocument } from "./render.ts";

const LARGE_SCROLLBACK_LINE_COUNT = 10_050;
const CONTENT_REVISION = 41;
const SENTINEL = "MOBILE_INITIAL_CONTENT_READY_SENTINEL";

interface BridgeMessage {
  type?: string;
  contentRevision?: number;
}

export async function verifyTerminalInitialContentReadiness(
  browser: Browser
): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.setContent(await buildInstrumentedMobileDocument(132), {
      waitUntil: "load"
    });
    await page.waitForFunction(() =>
      window.__kannaBridgeMessages.some((message) => {
        const parsed = JSON.parse(message) as BridgeMessage;
        return parsed.type === "terminal-ready";
      })
    );

    const chunksB64 = Array.from(
      { length: LARGE_SCROLLBACK_LINE_COUNT },
      (_, index) =>
        Buffer.from(
          `MOBILE_INITIAL_HISTORY_${String(index + 1).padStart(5, "0")}_${"X".repeat(54)}\r\n`,
          "utf8"
        ).toString("base64")
    );
    chunksB64.push(Buffer.from(`${SENTINEL}\r\n`, "utf8").toString("base64"));

    const wasReadyInInjectionTask = await page.evaluate(
      ({ chunks, contentRevision }) => {
        window.__kannaBridgeMessages = [];
        window.__replaceTerminalState({
          chunksB64: chunks,
          contentRevision
        });
        return window.__kannaBridgeMessages.some((message) => {
          const parsed = JSON.parse(message) as BridgeMessage;
          return (
            parsed.type === "terminal-content-ready" &&
            parsed.contentRevision === contentRevision
          );
        });
      },
      { chunks: chunksB64, contentRevision: CONTENT_REVISION }
    );
    assert.equal(
      wasReadyInInjectionTask,
      false,
      "large scrollback must not report content-ready when it is only queued"
    );

    await page.waitForFunction(
      (contentRevision) =>
        window.__kannaBridgeMessages.some((message) => {
          const parsed = JSON.parse(message) as BridgeMessage;
          return (
            parsed.type === "terminal-content-ready" &&
            parsed.contentRevision === contentRevision
          );
        }),
      CONTENT_REVISION,
      { timeout: 30_000 }
    );

    const rendered = await page.evaluate((sentinel) => {
      const terminal = window.__kannaTerminals[0];
      const buffer = terminal.buffer.active;
      const firstLine = Math.max(0, buffer.baseY - 20);
      const visibleTail: string[] = [];
      for (let index = firstLine; index < buffer.length; index += 1) {
        const line = buffer.getLine(index);
        if (line) visibleTail.push(line.translateToString(true));
      }
      return {
        contentReadyCount: window.__kannaBridgeMessages.filter((message) => {
          const parsed = JSON.parse(message) as BridgeMessage;
          return parsed.type === "terminal-content-ready";
        }).length,
        pendingWrites: window.__kannaPendingWrites,
        renderedSentinel: visibleTail.includes(sentinel),
        retainedLines: buffer.length
      };
    }, SENTINEL);

    assert.equal(rendered.pendingWrites, 0);
    assert.equal(rendered.contentReadyCount, 1);
    assert.equal(rendered.renderedSentinel, true);
    assert.ok(
      rendered.retainedLines >= 10_000,
      `expected deliberately large retained scrollback, got ${rendered.retainedLines} lines`
    );
  } finally {
    await page.close();
  }
}
