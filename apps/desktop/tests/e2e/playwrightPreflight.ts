import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { chromium } from "playwright";

export const PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND =
  "pnpm --dir apps/desktop exec playwright install chromium";

export interface PlaywrightChromiumPreflightOptions {
  executablePath?: string;
  isExecutable?: (path: string) => Promise<boolean>;
}

export async function assertPlaywrightChromiumAvailable(
  options: PlaywrightChromiumPreflightOptions = {},
): Promise<void> {
  const executablePath = options.executablePath ?? chromium.executablePath();
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  if (await isExecutable(executablePath)) return;

  throw new Error(
    `Playwright Chromium is not installed or executable at ${executablePath}. ` +
      `Run: ${PLAYWRIGHT_CHROMIUM_INSTALL_COMMAND}`,
  );
}

async function defaultIsExecutable(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(() => true).catch(() => false);
}
