import { remote, type Browser } from "webdriverio";

export async function createMobileSession(options: {
  hostname?: string;
  port: number;
  capabilities: Record<string, unknown>;
}): Promise<Browser> {
  return remote({
    hostname: options.hostname || "127.0.0.1",
    path: "/",
    port: options.port,
    // A clean simulator may need to build WebDriverAgent before Appium can
    // answer POST /session. WebdriverIO's 120s default can abort that healthy
    // first launch while xcodebuild is still running.
    connectionRetryTimeout: 300_000,
    capabilities: options.capabilities
  });
}
