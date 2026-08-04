import { chromium } from "playwright";
import { verifyTerminalInitialContentReadiness } from "./terminalInitialContentReadiness.ts";
import { verifyTerminalSafeRegion } from "./terminalSafeRegion.ts";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    await verifyTerminalSafeRegion(browser);
    process.stdout.write("PASS terminal-safe-region\n");
    await verifyTerminalInitialContentReadiness(browser);
    process.stdout.write("PASS terminal-initial-content-readiness\n");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
