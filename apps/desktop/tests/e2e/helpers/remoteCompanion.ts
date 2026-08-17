import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { WebDriverClient } from "./webdriver";

const ASSET_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x4b, 0x41, 0x4e, 0x4e, 0x41, 0x2d, 0x45, 0x32,
  0x45,
]);
const ENTRY_HOST = /^[a-f0-9]{32}\.localhost$/u;
const CAPABILITY = /^[a-f0-9]{32}$/u;
const BROWSER_TIMEOUT_MS = 30_000;

export interface RemoteCompanionOwner {
  ownerDesktopId: string;
  ownerTaskId: string;
}

export interface RemoteCompanionHookSnapshot
  extends RemoteCompanionOwner {
  sessionId: string | null;
  revision: string | null;
  status: "available" | "reconnecting" | "unavailable" | "error";
  entryUrl: string | null;
  openerAttempt: number;
  openerOutcome: "pending" | "success" | "error" | null;
}

export interface RemoteCompanionFixture {
  assetBytes: Buffer;
  choice: string;
  initialMarker: string;
  recoveryMarker: string;
  sessionId: string;
  sessionRoot: string;
  sourceUrl: string;
  updatedMarker: string;
  asset(): Promise<Buffer>;
  document(): Promise<string>;
  events(): Promise<Array<Record<string, unknown>>>;
  publishRecoveryUpdate(): Promise<void>;
  publishAsset(name: string, bytes: Buffer): Promise<void>;
  publishUpdate(): Promise<void>;
  publishDocument(html: string): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateRemoteCompanionFixtureInput {
  worktreePath: string;
  sessionId: string;
  choice: string;
  initialMarker: string;
  recoveryMarker: string;
  updatedMarker: string;
  sourceUrl?: string;
}

function companionHtml(marker: string, choice: string): string {
  return [
    `<main><h1>${marker}</h1>`,
    '<img alt="layout" src="/files/layout.png">',
    '<div class="options">',
    `<button class="option" data-choice="${choice}">Choose layout</button>`,
    "</div></main>",
  ].join("");
}

export async function createRemoteCompanionFixture(
  input: CreateRemoteCompanionFixtureInput,
): Promise<RemoteCompanionFixture> {
  const sourceUrl = input.sourceUrl ?? "http://localhost:52341";
  const sessionRoot = join(
    input.worktreePath,
    ".superpowers",
    "brainstorm",
    input.sessionId,
  );
  const contentRoot = join(sessionRoot, "content");
  const stateRoot = join(sessionRoot, "state");
  const documentPath = join(contentRoot, "screen.html");
  const assetPath = join(contentRoot, "layout.png");
  const eventsPath = join(stateRoot, "events");
  await mkdir(contentRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    join(stateRoot, "server-info"),
    JSON.stringify({ url: sourceUrl }),
    "utf8",
  );
  await writeFile(
    documentPath,
    companionHtml(input.initialMarker, input.choice),
    "utf8",
  );
  await writeFile(assetPath, ASSET_BYTES);

  return {
    assetBytes: Buffer.from(ASSET_BYTES),
    choice: input.choice,
    initialMarker: input.initialMarker,
    recoveryMarker: input.recoveryMarker,
    sessionId: input.sessionId,
    sessionRoot,
    sourceUrl,
    updatedMarker: input.updatedMarker,
    asset: () => readFile(assetPath),
    document: () => readFile(documentPath, "utf8"),
    async events() {
      const contents = await readFile(eventsPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      return contents
        .split(/\r\n|\r|\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    publishUpdate: () =>
      writeFile(
        documentPath,
        `${companionHtml(input.updatedMarker, input.choice)}<!-- updated revision -->`,
        "utf8",
      ),
    publishAsset: async (name, bytes) => {
      if (!/^[a-zA-Z0-9._-]+$/u.test(name)) {
        throw new Error("invalid companion fixture asset name");
      }
      await writeFile(join(contentRoot, name), bytes);
    },
    publishDocument: (html) => writeFile(documentPath, html, "utf8"),
    publishRecoveryUpdate: () =>
      writeFile(
        documentPath,
        `${companionHtml(input.recoveryMarker, input.choice)}<!-- recovery revision -->`,
        "utf8",
      ),
    stop: () => writeFile(join(stateRoot, "server-stopped"), "", "utf8"),
  };
}

export function parseCompanionEntryUrl(value: string): {
  baseUrl: string;
  entryUrl: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid companion entry URL");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    !ENTRY_HOST.test(parsed.hostname) ||
    !parsed.port ||
    parsed.pathname !== "/" ||
    parsed.hash ||
    parsed.searchParams.size !== 1 ||
    !CAPABILITY.test(parsed.searchParams.get("cap") ?? "")
  ) {
    throw new Error("invalid companion entry URL");
  }
  return {
    baseUrl: parsed.origin,
    entryUrl: parsed.href,
  };
}

export async function clickRemoteCompanionLink(
  client: WebDriverClient,
  sessionId: string,
  uri: string,
): Promise<void> {
  const point = await client.executeSync<{ x: number; y: number } | null>(`
    const shell = Array.from(document.querySelectorAll(".cloud-terminal-shell"))
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const screen = shell?.querySelector(".xterm-screen");
    const cell = window.__KANNA_E2E__?.terminalBuffers?.findTextCell(
      ${JSON.stringify(sessionId)},
      ${JSON.stringify(uri)}
    );
    if (!screen || !cell) return null;
    const screenRect = screen.getBoundingClientRect();
    return {
      x: screenRect.left + (cell.column + 0.5) * screenRect.width / cell.columns,
      y: screenRect.top + (cell.row + 0.5) * screenRect.height / cell.rows,
    };
  `);
  if (!point) {
    throw new Error("remote companion link cell is not visible in xterm");
  }
  await client.pointerPressAt(point.x, point.y);
}

export async function captureNextRemoteCompanionOpen(
  client: WebDriverClient,
  owner: RemoteCompanionOwner,
): Promise<void> {
  await client.executeSync(`
    const api = window.__KANNA_E2E__?.remoteCompanion;
    if (!api) throw new Error("remote companion E2E hook is unavailable");
    api.captureNextOpen(${JSON.stringify(owner)});
  `);
}

export async function activateRemoteCompanionLink(
  client: WebDriverClient,
  owner: RemoteCompanionOwner,
  uri: string,
  timeoutMs = 30_000,
): Promise<RemoteCompanionHookSnapshot> {
  await captureNextRemoteCompanionOpen(client, owner);
  const deadline = Date.now() + timeoutMs;
  let latest: RemoteCompanionHookSnapshot | null = null;
  while (Date.now() < deadline) {
    await clickRemoteCompanionLink(client, owner.ownerTaskId, uri);
    const attemptDeadline = Math.min(deadline, Date.now() + 1_000);
    while (Date.now() < attemptDeadline) {
      latest = await client.executeSync<RemoteCompanionHookSnapshot | null>(`
        const api = window.__KANNA_E2E__?.remoteCompanion;
        return api ? api.snapshot(${JSON.stringify(owner)}) : null;
      `);
      if (
        latest?.status === "available" &&
        latest.sessionId &&
        latest.revision &&
        latest.entryUrl
      ) {
        return latest;
      }
      await sleep(100);
    }
  }
  throw new Error(
    `timed out physically activating remote companion link: ${JSON.stringify(
      sanitizeRemoteCompanionSnapshotForDiagnostic(latest),
    )}`,
  );
}

export async function waitForRemoteCompanionSnapshot(
  client: WebDriverClient,
  owner: RemoteCompanionOwner,
  predicate: (snapshot: RemoteCompanionHookSnapshot) => boolean,
  timeoutMs = 30_000,
): Promise<RemoteCompanionHookSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let latest: RemoteCompanionHookSnapshot | null = null;
  while (Date.now() < deadline) {
    latest = await client.executeSync<RemoteCompanionHookSnapshot | null>(`
      const api = window.__KANNA_E2E__?.remoteCompanion;
      return api ? api.snapshot(${JSON.stringify(owner)}) : null;
    `);
    if (latest && predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for remote companion snapshot: ${JSON.stringify(
      sanitizeRemoteCompanionSnapshotForDiagnostic(latest),
    )}`,
  );
}

export function sanitizeRemoteCompanionSnapshotForDiagnostic(
  snapshot: RemoteCompanionHookSnapshot | null,
): (Omit<RemoteCompanionHookSnapshot, "entryUrl"> & {
  hasEntryUrl: boolean;
}) | null {
  if (!snapshot) return null;
  const {
    ownerDesktopId,
    ownerTaskId,
    sessionId,
    revision,
    status,
    entryUrl,
    openerAttempt,
    openerOutcome,
  } = snapshot;
  return {
    ownerDesktopId,
    ownerTaskId,
    sessionId,
    revision,
    status,
    openerAttempt,
    openerOutcome,
    hasEntryUrl: entryUrl !== null,
  };
}

interface CompanionNavigationResponse {
  ok(): boolean;
}

export async function navigateRemoteCompanionPage(
  navigate: () => Promise<CompanionNavigationResponse | null>,
): Promise<void> {
  try {
    const response = await navigate();
    if (!response?.ok()) {
      throw new Error("navigation response was not successful");
    }
  } catch {
    throw new Error("companion browser navigation failed");
  }
}

export class RemoteCompanionBrowser {
  readonly baseUrl: string;
  private readonly offOriginRequests: string[];
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    baseUrl: string,
    offOriginRequests: string[],
  ) {
    this.baseUrl = baseUrl;
    this.offOriginRequests = offOriginRequests;
  }

  static async open(
    entryUrl: string,
  ): Promise<RemoteCompanionBrowser> {
    const parsed = parseCompanionEntryUrl(entryUrl);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const offOriginRequests: string[] = [];
    const allowedHost = new URL(parsed.baseUrl).host;
    page.on("request", (request) => {
      let requestHost: string;
      try {
        requestHost = new URL(request.url()).host;
      } catch {
        offOriginRequests.push(request.url());
        return;
      }
      if (requestHost !== allowedHost) {
        offOriginRequests.push(request.url());
      }
    });
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    const companion = new RemoteCompanionBrowser(
      browser,
      context,
      page,
      parsed.baseUrl,
      offOriginRequests,
    );
    try {
      await navigateRemoteCompanionPage(() =>
        page.goto(parsed.entryUrl, {
          waitUntil: "domcontentloaded",
          timeout: BROWSER_TIMEOUT_MS,
        })
      );
      await companion.waitForStatus("available");
      return companion;
    } catch (error) {
      await companion.close();
      throw error;
    }
  }

  async waitForText(text: string, timeoutMs = BROWSER_TIMEOUT_MS): Promise<void> {
    await this.page.getByText(text, { exact: false }).first().waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
  }

  async asset(name: string): Promise<Buffer> {
    if (!/^[a-zA-Z0-9._-]+$/u.test(name)) {
      throw new Error("invalid companion asset name");
    }
    const result = await this.page.evaluate(async (assetName) => {
      const response = await fetch(`/files/${encodeURIComponent(assetName)}`);
      return {
        status: response.status,
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, name);
    if (result.status !== 200) {
      throw new Error(`companion asset request failed (${result.status})`);
    }
    return Buffer.from(result.bytes);
  }

  async waitForStatus(status: string, timeoutMs = 30_000): Promise<void> {
    await this.page.locator(
      `#kanna-companion-status[data-status="${status}"]`,
    ).waitFor({ state: "visible", timeout: timeoutMs });
  }

  async assertContentInert(options: {
    staleControlsRemoved?: boolean;
  } = {}): Promise<void> {
    const state = await this.page.locator("#kanna-companion-content").evaluate(
      (content) => ({
        inert: (content as HTMLElement).inert,
        ariaDisabled: content.getAttribute("aria-disabled"),
        selectedMarkers: content.querySelectorAll(".selected").length,
        choices: content.querySelectorAll("[data-choice]").length,
      }),
    );
    if (!state.inert || state.ariaDisabled !== "true") {
      throw new Error(`companion content remained interactive: ${JSON.stringify(state)}`);
    }
    if (state.selectedMarkers !== 0) {
      throw new Error(`companion retained stale selection markers: ${JSON.stringify(state)}`);
    }
    if (options.staleControlsRemoved && state.choices !== 0) {
      throw new Error(`companion retained stale controls: ${JSON.stringify(state)}`);
    }
  }

  async assertContentAvailable(): Promise<void> {
    const state = await this.page.locator("#kanna-companion-content").evaluate(
      (content) => ({
        inert: (content as HTMLElement).inert,
        ariaDisabled: content.getAttribute("aria-disabled"),
        selectedMarkers: content.querySelectorAll(".selected").length,
      }),
    );
    if (state.inert || state.ariaDisabled !== null || state.selectedMarkers !== 0) {
      throw new Error(`companion content did not recover cleanly: ${JSON.stringify(state)}`);
    }
  }

  async clickChoice(choice: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(choice)) {
      throw new Error("invalid companion choice");
    }
    await this.page.locator(`[data-choice="${choice}"]`).click();
    try {
      await this.page.locator(
        '#kanna-companion-status[data-status="sent"]',
      ).waitFor({ state: "visible", timeout: BROWSER_TIMEOUT_MS });
    } catch (error) {
      // The manager's delivery deadline matches the browser wait. Give its
      // correlated failure notification a brief chance to render so timeout
      // diagnostics report the transport outcome instead of "sending".
      await this.page.waitForTimeout(1_000);
      const diagnostic = await this.page.locator("#kanna-companion-status")
        .evaluate((element) => ({
          status: element.getAttribute("data-status"),
          text: element.textContent,
        }))
        .catch(() => null);
      throw new Error(
        `companion choice was not sent: ${JSON.stringify(diagnostic)}`,
        { cause: error },
      );
    }
  }

  async assertNavigationContained(): Promise<void> {
    await this.page.waitForTimeout(500);
    if (!this.page.url().startsWith(this.baseUrl)) {
      throw new Error(`companion escaped its loopback origin: ${this.page.url()}`);
    }
    if (this.offOriginRequests.length > 0) {
      throw new Error(
        `companion attempted off-origin requests: ${JSON.stringify(this.offOriginRequests)}`,
      );
    }
  }

  async assertActiveAssetInert(name: string): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+$/u.test(name)) {
      throw new Error("invalid companion asset name");
    }
    await this.page.waitForTimeout(500);
    const result = await this.page.evaluate(async (assetName) => {
      const response = await fetch(`/files/${encodeURIComponent(assetName)}`);
      return {
        contentType: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
        policy: response.headers.get("content-security-policy"),
        activeMarker: Boolean(
          (window as typeof window & { __activeAssetExecuted?: boolean })
            .__activeAssetExecuted
        ),
        activeNodes: document.querySelectorAll(
          "[href], iframe, frame, object, embed, animate, animateMotion, animateTransform, set"
        ).length,
      };
    }, name);
    if (
      result.contentType !== "application/octet-stream" ||
      result.disposition !== "attachment" ||
      !result.policy?.includes("script-src 'none'") ||
      result.activeMarker ||
      result.activeNodes !== 0
    ) {
      throw new Error(
        `active companion asset escaped containment: ${JSON.stringify(result)}`,
      );
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

export async function setRelayConnected(connected: boolean): Promise<void> {
  const controlUrl = process.env.KANNA_E2E_RELAY_CONTROL_URL;
  if (!controlUrl) throw new Error("KANNA_E2E_RELAY_CONTROL_URL is required");
  const response = await fetch(
    `${controlUrl}/${connected ? "reconnect" : "disconnect"}`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(
      `relay ${connected ? "reconnect" : "disconnect"} failed: ${await response.text()}`,
    );
  }
}
