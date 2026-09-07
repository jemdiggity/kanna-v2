/**
 * Startup classification for the E2E harness.
 *
 * A window that never loads used to look exactly like a slow cargo build: the harness
 * polled for `window.__KANNA_E2E__.ready` and, ten minutes later, said "timed out waiting
 * for app" with nothing to act on. Once the WebDriver plugin answers, the app is running
 * and the build wait is over — from that point the loaded URL says whether the window is
 * booting or pointed somewhere it will never recover from.
 */

export interface AppStartupProbe {
  webdriverReady: boolean;
  url: string | null;
  appReady: boolean;
}

export type AppStartupState = "ready" | "booting" | "wrong-url";

/** How long a wrong URL is tolerated before failing; the initial load reports
 * `about:blank` for a moment while the first navigation is still provisional. */
export const WRONG_URL_GRACE_MS = 30_000;
export const WEBDRIVER_START_TIMEOUT_MS = 20 * 60_000;
export const APP_READY_TIMEOUT_MS = 60_000;

export interface AppStartupDeadline {
  deadline: number;
  webdriverObserved: boolean;
}

/** Start the app-boot clock only after the build has produced a WebDriver listener. */
export function advanceAppStartupDeadline(
  state: AppStartupDeadline,
  probe: AppStartupProbe,
  now: number,
  appReadyTimeoutMs = APP_READY_TIMEOUT_MS,
): AppStartupDeadline {
  if (state.webdriverObserved || !probe.webdriverReady) return state;
  return {
    deadline: now + appReadyTimeoutMs,
    webdriverObserved: true,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function classifyAppStartup(probe: AppStartupProbe, expectedUrl: string): AppStartupState {
  if (probe.appReady) return "ready";
  if (!probe.webdriverReady || !probe.url) return "booting";
  const expectedOrigin = originOf(expectedUrl);
  const actualOrigin = originOf(probe.url);
  if (expectedOrigin && actualOrigin === expectedOrigin) return "booting";
  return "wrong-url";
}

export interface AppStartupFailureInput {
  baseUrl: string;
  expectedUrl: string;
  probe: AppStartupProbe | null;
  reason: "timeout" | "wrong-url";
  paneLog?: string;
}

export function describeAppStartupFailure(input: AppStartupFailureInput): string {
  const lines: string[] = [];
  if (input.reason === "wrong-url") {
    lines.push(
      `app at ${input.baseUrl} loaded ${input.probe?.url ?? "nothing"} instead of ${input.expectedUrl}`,
      "The window will not recover on its own. This is what a stale compiled-in devUrl looks like:",
      "the dev binary was built for an earlier run's port, so the first navigation was refused.",
      "See apps/desktop/src-tauri/src/dev_url.rs.",
    );
  } else {
    lines.push(`timed out waiting for app at ${input.baseUrl}`);
    lines.push(
      input.probe?.webdriverReady
        ? `WebDriver answered but the app never became ready (last URL: ${input.probe.url ?? "unknown"}, expected ${input.expectedUrl})`
        : "WebDriver never answered — the app process never got far enough to serve it",
    );
  }
  if (input.paneLog?.trim()) {
    lines.push("", "[e2e] desktop pane:", input.paneLog.trimEnd());
  }
  return lines.join("\n");
}
