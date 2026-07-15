import { chromium } from "playwright";
import { verifyTerminalSafeRegion } from "./terminalSafeRegion.ts";

async function main(): Promise<void> {
  const browser = await chromium.launch();
  try {
    await verifyTerminalSafeRegion(browser);
    process.stdout.write("PASS terminal-safe-region\n");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
