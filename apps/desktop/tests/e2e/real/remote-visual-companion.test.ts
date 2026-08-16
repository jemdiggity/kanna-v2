import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupFixtureRepos, createFixtureRepo } from "../helpers/fixture-repo";
import {
  activateRemoteCompanionLink,
  clickRemoteCompanionLink,
  captureNextRemoteCompanionOpen,
  createRemoteCompanionFixture,
  RemoteCompanionBrowser,
  setRelayConnected,
  waitForRemoteCompanionSnapshot,
  type RemoteCompanionFixture,
  type RemoteCompanionOwner,
} from "../helpers/remoteCompanion";
import { cleanupWorktrees, importTestRepo, resetDatabase } from "../helpers/reset";
import { resolveAppKannaServer } from "../helpers/kannaServer";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { pairWithPeerThroughUi } from "../helpers/transferFlow";
import { callVueMethod, execDb, queryDb, tauriInvoke } from "../helpers/vue";
import type { WebDriverClient } from "../helpers/webdriver";

const { primary, secondary } = createPrimaryAndSecondaryClients();
const execFileAsync = promisify(execFile);
const RELAY_RECOVERY_TIMEOUT_MS = 90_000;
let fixtureRepoPath = "";
let primaryRepoId = "";
let secondaryRepoId = "";
let primaryDesktopId = "";
let relayConnected = true;
let lanPairReady = false;
let sharedOwnerTask: {
  taskId: string;
  prompt: string;
  worktreePath: string;
} | null = null;

interface TerminalDimensions {
  cols: number;
  rows: number;
}

async function activateVisibleCompanionControl(
  client: WebDriverClient,
  key: "Enter" | "Space",
): Promise<void> {
  const label = "Open visual companion";
  const selector = `button[aria-label=${JSON.stringify(label)}]`;
  await client.waitForElement(selector, 15_000);
  const deadline = Date.now() + 10_000;
  let latest: {
    active: boolean;
    label: string | null;
    visible: boolean;
  } | null = null;
  while (Date.now() < deadline) {
    const controls = await client.findElements(selector);
    const visibleControls: string[] = [];
    for (const control of controls) {
      const rect = await client.getElementRect(control);
      if (rect.width > 0 && rect.height > 0) {
        visibleControls.push(control);
      }
    }
    latest = await client.executeSync(`
      const candidates = Array.from(document.querySelectorAll(
        ${JSON.stringify(selector)}
      ));
      const control = candidates.find((candidate) => {
        if (!(candidate instanceof HTMLButtonElement) || candidate.disabled) {
          return false;
        }
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        return candidate.isConnected &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden";
      });
      if (!(control instanceof HTMLButtonElement)) {
        return { active: false, label: null, visible: false };
      }
      control.focus();
      return {
        active: document.activeElement === control,
        label: control.getAttribute("aria-label"),
        visible: true,
      };
    `);
    if (latest.active && visibleControls.length === 1) {
      expect(latest).toEqual({
        active: true,
        label,
        visible: true,
      });
      await client.pressKey(key === "Enter" ? "\uE007" : "\uE00D");
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out focusing visible companion control: ${JSON.stringify(latest)}`,
  );
}

async function setSetupState(
  client: WebDriverClient,
  key: string,
  value: unknown,
): Promise<void> {
  await client.executeSync(`
    const ctx = window.__KANNA_E2E__.setupState;
    const current = ctx[${JSON.stringify(key)}];
    if (current?.__v_isRef) current.value = ${JSON.stringify(value)};
    else ctx[${JSON.stringify(key)}] = ${JSON.stringify(value)};
  `);
}

async function signIn(client: WebDriverClient): Promise<void> {
  await setSetupState(client, "showPreferencesPanel", true);
  await client.click(await client.waitForElement(
    '[data-testid="preferences-account-tab"]',
  ));
  await client.sendKeys(
    await client.waitForElement('[data-testid="account-email"]'),
    "upvote.sieve.7t@icloud.com",
  );
  await client.sendKeys(
    await client.waitForElement('[data-testid="account-password"]'),
    "password123",
  );
  await client.click(await client.waitForElement(
    '[data-testid="account-sign-in"] .primary-button',
  ));
  await client.waitForText(
    ".prefs-panel",
    "upvote.sieve.7t@icloud.com",
    15_000,
  );
  await callVueMethod(client, "associateDesktopCloudCredential");
  await setSetupState(client, "showPreferencesPanel", false);
  await setSetupState(client, "maximized", false);
  await setSetupState(client, "sidebarHidden", false);
}

async function signOut(client: WebDriverClient): Promise<void> {
  const alreadySignedOut = await client.executeSync<boolean>(`
    const value = window.__KANNA_E2E__.setupState.desktopAuthSession;
    const session = value?.__v_isRef ? value.value : value;
    return session?.getState?.().status !== "signedIn";
  `);
  if (alreadySignedOut) return;
  await setSetupState(client, "showPreferencesPanel", true);
  await client.click(await client.waitForElement(
    '[data-testid="preferences-account-tab"]',
  ));
  await client.click(await client.waitForText(
    ".account-signed-in button",
    "Sign out",
    10_000,
  ));
  await client.waitForElement('[data-testid="account-sign-in"]', 15_000);
  await setSetupState(client, "showPreferencesPanel", false);
}

async function ensureLanPair(): Promise<void> {
  if (lanPairReady) return;
  await Promise.all([signOut(primary), signOut(secondary)]);
  await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
    promptClient: secondary,
    promptPeerId: "peer-primary",
  });
  lanPairReady = true;
}

async function waitForPrimaryDesktopId(): Promise<string> {
  const deadline = Date.now() + 30_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await tauriInvoke(primary, "mobile_server_status");
    const status = latest as { state?: string; desktopId?: string };
    if (status.state === "running" && status.desktopId) return status.desktopId;
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for owner desktop identity: ${JSON.stringify(latest)}`,
  );
}

async function createOwnerTask(input: {
  prompt: string;
  sessionId: string;
  initialMarker: string;
  recoveryMarker: string;
  updatedMarker: string;
  choice: string;
}): Promise<{
  taskId: string;
  worktreePath: string;
  fixture: RemoteCompanionFixture;
}> {
  const sourceUrl = "http://localhost:52341";
  const heartbeatSetup =
    `count=0; while true; do printf '%s companion-heartbeat:%s\\n' ${JSON.stringify(sourceUrl)} "$count"; count=$((count + 1)); sleep 2; done`;
  const result = await callVueMethod(
    primary,
    "store.createItem",
    primaryRepoId,
    fixtureRepoPath,
    input.prompt,
    "pty",
    {
      agentProvider: "codex",
      baseRef: "origin/main",
      customTask: {
        name: "Remote visual companion fixture",
        prompt: input.prompt,
        executionMode: "pty",
        setup: [heartbeatSetup],
      },
    },
  );
  if (typeof result !== "string") {
    throw new Error(`owner task creation failed: ${JSON.stringify(result)}`);
  }
  const rows = await queryDb(
    primary,
    "SELECT path FROM worktree WHERE pipeline_item_id = ? ORDER BY created_at DESC LIMIT 1",
    [result],
  );
  const worktreePath = (rows[0] as { path?: unknown } | undefined)?.path;
  if (typeof worktreePath !== "string") {
    throw new Error(`owner task has no worktree: ${JSON.stringify(rows)}`);
  }
  const fixture = await createRemoteCompanionFixture({
    worktreePath,
    sessionId: input.sessionId,
    initialMarker: input.initialMarker,
    recoveryMarker: input.recoveryMarker,
    updatedMarker: input.updatedMarker,
    choice: input.choice,
    sourceUrl,
  });
  const recoveryDeadline = Date.now() + 30_000;
  let latestRecovery: { serialized?: string; sequence?: number } | null = null;
  let latestSession: Record<string, unknown> | null = null;
  while (Date.now() < recoveryDeadline) {
    latestRecovery = await tauriInvoke(
      primary,
      "get_session_recovery_state",
      { sessionId: result },
    ) as { serialized?: string; sequence?: number } | null;
    const sessions = await tauriInvoke(primary, "list_sessions") as Array<
      Record<string, unknown>
    >;
    latestSession = sessions.find((session) => session.session_id === result) ?? null;
    if (latestRecovery?.serialized?.includes(fixture.sourceUrl)) {
      return { taskId: result, worktreePath, fixture };
    }
    await sleep(100);
  }
  throw new Error(`scripted owner session produced no source output: ${JSON.stringify({
    recovery: latestRecovery
      ? {
          sequence: latestRecovery.sequence ?? null,
          serializedLength: latestRecovery.serialized?.length ?? 0,
        }
      : null,
    session: latestSession,
  })}`);
}

async function assertScriptedOwnerTask(taskId: string): Promise<void> {
  const rows = await queryDb(
    primary,
    "SELECT agent_type, activity, unread_at FROM pipeline_item WHERE id = ?",
    [taskId],
  );
  expect(rows).toEqual([
    expect.objectContaining({
      agent_type: "pty",
      unread_at: null,
    }),
  ]);
  expect((rows[0] as { activity?: unknown }).activity).not.toBe("unread");
}

async function latestTerminalHeartbeat(sourceUrl: string): Promise<number> {
  return await secondary.executeSync<number>(`
    const buffers = window.__KANNA_E2E__?.terminalBuffers;
    if (!buffers) return -1;
    const prefix = ${JSON.stringify(`${sourceUrl} companion-heartbeat:`)};
    let latest = -1;
    for (const id of buffers.sessionIds()) {
      for (const line of buffers.lines(id)) {
        const index = line.indexOf(prefix);
        if (index < 0) continue;
        const value = Number.parseInt(line.slice(index + prefix.length), 10);
        if (Number.isFinite(value)) latest = Math.max(latest, value);
      }
    }
    return latest;
  `);
}

async function latestTaskTerminalHeartbeat(
  ownerTaskId: string,
  sourceUrl: string,
): Promise<number> {
  return await secondary.executeSync<number>(`
    const buffers = window.__KANNA_E2E__?.terminalBuffers;
    const ownerTaskId = ${JSON.stringify(ownerTaskId)};
    if (!buffers || !buffers.sessionIds().includes(ownerTaskId)) return -1;
    const prefix = ${JSON.stringify(`${sourceUrl} companion-heartbeat:`)};
    let latest = -1;
    for (const line of buffers.lines(ownerTaskId)) {
      const index = line.indexOf(prefix);
      if (index < 0) continue;
      const value = Number.parseInt(line.slice(index + prefix.length), 10);
      if (Number.isFinite(value)) latest = Math.max(latest, value);
    }
    return latest;
  `);
}

async function visibleRemoteTerminalDimensions(
  ownerTaskId: string,
  sourceUrl: string,
): Promise<TerminalDimensions> {
  const dimensions = await secondary.executeSync<TerminalDimensions | null>(`
    const cell = window.__KANNA_E2E__?.terminalBuffers?.findTextCell(
      ${JSON.stringify(ownerTaskId)},
      ${JSON.stringify(sourceUrl)}
    );
    return cell ? { cols: cell.columns, rows: cell.rows } : null;
  `);
  if (!dimensions) {
    throw new Error(`remote terminal dimensions unavailable for ${ownerTaskId}`);
  }
  return dimensions;
}

async function ownerTerminalDimensions(
  ownerTaskId: string,
): Promise<TerminalDimensions> {
  const snapshot = await tauriInvoke(
    primary,
    "get_session_recovery_state",
    { sessionId: ownerTaskId },
  ) as { cols?: unknown; rows?: unknown } | null;
  if (
    typeof snapshot?.cols !== "number"
    || typeof snapshot.rows !== "number"
  ) {
    throw new Error(
      `owner terminal dimensions unavailable for ${ownerTaskId}: ${JSON.stringify(snapshot)}`,
    );
  }
  return { cols: snapshot.cols, rows: snapshot.rows };
}

async function waitForRemoteTask(input: {
  prompt: string;
  transport: "cloud" | "lan";
  expectedOwnerDesktopId: string;
  expectedOwnerTaskId: string;
}): Promise<{ itemId: string; owner: RemoteCompanionOwner }> {
  const deadline = Date.now() + (
    input.transport === "cloud" ? RELAY_RECOVERY_TIMEOUT_MS : 45_000
  );
  let latest: unknown = null;
  while (Date.now() < deadline) {
    latest = await secondary.executeSync(`
      const ctx = window.__KANNA_E2E__.setupState;
      const read = (value) => value?.__v_isRef ? value.value : value;
      const snapshot = read(ctx.${input.transport === "cloud" ? "cloudSnapshot" : "lanSnapshot"}) || {};
      const matches = Object.entries(snapshot.terminalRefs || {}).filter(
        ([, ref]) =>
          ref.ownerDesktopId === ${JSON.stringify(input.expectedOwnerDesktopId)} &&
          ref.ownerLocalTaskId === ${JSON.stringify(input.expectedOwnerTaskId)} &&
          (ref.transport || ${JSON.stringify(input.transport)}) === ${JSON.stringify(input.transport)}
      );
      const renderedIds = new Set(Array.from(
        document.querySelectorAll(".sidebar .workflow-item[data-task-id]")
      ).filter((row) => row.isConnected && row.getClientRects().length > 0)
        .map((row) => row.dataset.taskId));
      const canonical = matches.filter(([id]) =>
        renderedIds.has(id) &&
        (snapshot.items || []).some((candidate) => candidate.id === id)
      );
      const selected = canonical.length === 1 ? canonical[0] : null;
      const terminalRef = selected?.[1];
      return selected && terminalRef ? {
        itemId: selected[0],
        ownerDesktopId: terminalRef.ownerDesktopId,
        ownerTaskId: terminalRef.ownerLocalTaskId,
        transport: terminalRef.transport || ${JSON.stringify(input.transport)},
      } : {
        debug: {
          expectedPrompt: ${JSON.stringify(input.prompt)},
          matchingIds: matches.map(([id]) => id),
          canonicalIds: canonical.map(([id]) => id),
          renderedIds: Array.from(renderedIds),
          items: (snapshot.items || []).map((candidate) => ({
            id: candidate.id,
            prompt: candidate.prompt,
          })),
          terminalRefs: Object.entries(snapshot.terminalRefs || {}).map(
            ([id, ref]) => ({
              id,
              ownerDesktopId: ref.ownerDesktopId,
              ownerTaskId: ref.ownerLocalTaskId,
              transport: ref.transport || null,
            })
          ),
        },
      };
    `);
    const candidate = latest as {
      itemId?: string;
      ownerDesktopId?: string;
      ownerTaskId?: string;
      transport?: string;
    } | null;
    if (
      candidate?.itemId &&
      candidate.ownerDesktopId &&
      candidate.ownerTaskId &&
      candidate.transport === input.transport
    ) {
      return {
        itemId: candidate.itemId,
        owner: {
          ownerDesktopId: candidate.ownerDesktopId,
          ownerTaskId: candidate.ownerTaskId,
        },
      };
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for ${input.transport} task: ${JSON.stringify(latest)}`,
  );
}

async function selectRemoteTask(input: {
  itemId: string;
  owner: RemoteCompanionOwner;
  prompt: string;
  transport: "cloud" | "lan";
}): Promise<void> {
  const deadline = Date.now() + 30_000;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    try {
      latest = await secondary.executeSync(`
        const itemId = ${JSON.stringify(input.itemId)};
        const rows = Array.from(
          document.querySelectorAll(".sidebar .workflow-item[data-task-id]")
        ).filter((candidate) =>
          candidate.dataset.taskId === itemId &&
          candidate.isConnected &&
          candidate.getClientRects().length > 0
        );
        if (rows.length === 1) rows[0].click();
        const ctx = window.__KANNA_E2E__.setupState;
        const read = (value) => value?.__v_isRef ? value.value : value;
        const diagnostics = read(ctx.remoteTaskDiagnostics) || [];
        const matching = diagnostics.find(
          (entry) =>
            entry.itemId === itemId &&
            entry.ownerDesktopId === ${JSON.stringify(input.owner.ownerDesktopId)} &&
            entry.ownerLocalTaskId === ${JSON.stringify(input.owner.ownerTaskId)}
        );
        return {
          renderedRowCount: rows.length,
          status: document.querySelector(".cloud-terminal-shell")
            ?.getAttribute("data-status") ?? null,
          error: document.querySelector(".cloud-terminal-status")
            ?.textContent?.trim() ?? null,
          matching: matching ? JSON.parse(JSON.stringify(matching)) : null,
        };
      `);
    } catch (error) {
      // The macOS driver can briefly reject script execution while Vue swaps
      // the terminal view for a newly selected remote task. Selection is
      // idempotent, so retry the complete read rather than failing setup on
      // that transient protocol response.
      latest = {
        webdriverError: error instanceof Error ? error.message : String(error),
      };
      await sleep(100);
      continue;
    }
    const state = latest as {
      status?: string | null;
      matching?: {
        selectedTerminalTransport?: string;
        ownerDesktopId?: string;
        ownerLocalTaskId?: string;
      } | null;
    };
    if (
      state.status === "live" &&
      state.matching?.selectedTerminalTransport === input.transport &&
      state.matching.ownerDesktopId === input.owner.ownerDesktopId &&
      state.matching.ownerLocalTaskId === input.owner.ownerTaskId
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for selected ${input.transport} terminal (${input.prompt}): ${JSON.stringify(latest)}`,
  );
}

async function waitForTerminalSource(
  ownerTaskId: string,
  sourceUrl: string,
): Promise<void> {
  await expect.poll(
    () => secondary.executeSync<boolean>(`
      const buffers = window.__KANNA_E2E__?.terminalBuffers;
      return Boolean(buffers?.findTextCell(
        ${JSON.stringify(ownerTaskId)},
        ${JSON.stringify(sourceUrl)}
      ));
    `),
    { timeout: 30_000, interval: 100 },
  ).toBe(true);
}

async function waitForRemoteTerminalLine(
  ownerTaskId: string,
  expectedLine: string,
): Promise<void> {
  await expect.poll(
    () => secondary.executeSync<boolean>(`
      const buffers = window.__KANNA_E2E__?.terminalBuffers;
      return buffers?.lines(${JSON.stringify(ownerTaskId)})
        .some((line) => line === ${JSON.stringify(expectedLine)}) ?? false;
    `),
    { timeout: 30_000, interval: 100 },
  ).toBe(true);
}

async function setSystemClipboardText(value: string): Promise<void> {
  const script = [
    'ObjC.import("AppKit")',
    "const pasteboard = $.NSPasteboard.generalPasteboard",
    "pasteboard.clearContents",
    `pasteboard.setStringForType(${JSON.stringify(value)}, $.NSPasteboardTypeString)`,
  ].join(";");
  await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script]);
}

async function readSystemClipboardText(): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/pbpaste", []);
  return stdout;
}

async function assertRemoteTerminalCopy(
  ownerTaskId: string,
  expectedText: string,
): Promise<void> {
  const originalClipboard = await readSystemClipboardText();
  try {
    await setSystemClipboardText("kanna-remote-terminal-copy-sentinel");
    const selection = await secondary.executeSync<string | null>(`
      const buffers = window.__KANNA_E2E__?.terminalBuffers;
      const selection = buffers?.selectText(
        ${JSON.stringify(ownerTaskId)},
        ${JSON.stringify(expectedText)}
      ) ?? null;
      const input = document.querySelector(
        ".main-panel .cloud-terminal-shell .xterm-helper-textarea"
      );
      if (input instanceof HTMLElement) input.focus();
      return selection;
    `);
    expect(selection).toBe(expectedText);

    await secondary.pressShortcut(["Meta", "c"]);
    await expect.poll(
      readSystemClipboardText,
      { timeout: 5_000, interval: 100 },
    ).toBe(expectedText);
  } finally {
    await setSystemClipboardText(originalClipboard);
  }
}

async function waitForChoice(
  fixture: RemoteCompanionFixture,
  choice: string,
): Promise<void> {
  await expect.poll(
    async () => (await fixture.events()).some(
      (event) => event.choice === choice && event.type === "click",
    ),
    { timeout: 30_000, interval: 100 },
  ).toBe(true);
}

async function transferSidecarPid(peerId: string): Promise<number> {
  const registryDir = process.env.KANNA_TRANSFER_REGISTRY_DIR;
  if (!registryDir) {
    throw new Error("KANNA_TRANSFER_REGISTRY_DIR is required");
  }
  for (const name of await readdir(registryDir)) {
    if (!name.endsWith(".json")) continue;
    const raw = await readFile(`${registryDir}/${name}`, "utf8").catch(
      () => "",
    );
    if (!raw) continue;
    const entry = JSON.parse(raw) as { peer_id?: unknown; pid?: unknown };
    if (entry.peer_id !== peerId) continue;
    if (
      !Number.isInteger(entry.pid)
      || (entry.pid as number) <= 1
      || entry.pid === process.pid
    ) {
      throw new Error("transfer sidecar registry contains an invalid PID");
    }
    const pid = entry.pid as number;
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 5_000 },
    );
    if (!/(?:^|\/)kanna-task-transfer(?:\s|$)/u.test(stdout.trim())) {
      throw new Error("transfer sidecar PID does not identify kanna-task-transfer");
    }
    return pid;
  }
  throw new Error(`transfer sidecar registry entry is absent for ${peerId}`);
}

async function interruptLanRoute(): Promise<number> {
  const originalPid = await transferSidecarPid("peer-secondary");
  process.kill(originalPid, "SIGTERM");
  return originalPid;
}

async function waitForReplacementLanRoute(originalPid: number): Promise<void> {
  await expect.poll(
    async () => {
      const nextPid = await transferSidecarPid("peer-secondary")
        .catch(() => null);
      return nextPid && nextPid !== originalPid ? nextPid : null;
    },
    { timeout: 30_000, interval: 100 },
  ).not.toBeNull();
}

async function runCompanionJourney(input: {
  owner: RemoteCompanionOwner;
  fixture: RemoteCompanionFixture;
  interruptRoute: "relay" | "lan" | null;
}): Promise<void> {
  await waitForTerminalSource(
    input.owner.ownerTaskId,
    input.fixture.sourceUrl,
  );
  await assertRemoteTerminalCopy(
    input.owner.ownerTaskId,
    input.fixture.sourceUrl,
  );
  // Arm only the one-time capability capture. Both activations below use a
  // physical WebDriver pointer at the observed URL cell in xterm.
  await captureNextRemoteCompanionOpen(secondary, input.owner);
  await clickRemoteCompanionLink(
    secondary,
    input.owner.ownerTaskId,
    input.fixture.sourceUrl,
  );
  const initial = await waitForRemoteCompanionSnapshot(
    secondary,
    input.owner,
    (snapshot) =>
      snapshot.status === "available" &&
      Boolean(snapshot.sessionId && snapshot.revision && snapshot.entryUrl),
  );
  const browser = await RemoteCompanionBrowser.open(initial.entryUrl!);
  try {
    await browser.waitForText(input.fixture.initialMarker);
    await expect(browser.asset("layout.png")).resolves.toEqual(
      input.fixture.assetBytes,
    );
    // The Playwright navigation consumed the captured capability. A fresh,
    // independent xterm click now exercises the ordinary OS opener boundary.
    await clickRemoteCompanionLink(
      secondary,
      input.owner.ownerTaskId,
      input.fixture.sourceUrl,
    );
    const opened = await waitForRemoteCompanionSnapshot(
      secondary,
      input.owner,
      (snapshot) =>
        snapshot.openerAttempt > initial.openerAttempt &&
        snapshot.openerOutcome === "success",
    );
    expect(opened.openerOutcome).toBe("success");

    await input.fixture.publishUpdate();
    const updated = await waitForRemoteCompanionSnapshot(
      secondary,
      input.owner,
      (snapshot) =>
        snapshot.status === "available" &&
        snapshot.sessionId === initial.sessionId &&
        Boolean(snapshot.revision) &&
        snapshot.revision !== initial.revision,
    );
    expect(updated.revision).not.toBe(initial.revision);
    await browser.waitForText(input.fixture.updatedMarker);

    await browser.clickChoice(input.fixture.choice);
    await waitForChoice(input.fixture, input.fixture.choice);

    if (input.interruptRoute) {
      const heartbeatBeforeDisconnect =
        await latestTerminalHeartbeat(input.fixture.sourceUrl);
      expect(heartbeatBeforeDisconnect).toBeGreaterThanOrEqual(0);
      let originalLanPid: number | null = null;
      if (input.interruptRoute === "relay") {
        relayConnected = false;
        await setRelayConnected(false);
      } else {
        originalLanPid = await interruptLanRoute();
      }
      await browser.waitForStatus("reconnecting");
      await browser.assertContentInert();
      await waitForRemoteCompanionSnapshot(
        secondary,
        input.owner,
        (snapshot) => snapshot.status === "reconnecting",
      );
      await input.fixture.publishRecoveryUpdate();
      if (input.interruptRoute === "relay") {
        await setRelayConnected(true);
        relayConnected = true;
      } else if (originalLanPid !== null) {
        await waitForReplacementLanRoute(originalLanPid);
      }
      const recoveryDeadline = Date.now() + RELAY_RECOVERY_TIMEOUT_MS;
      const recovered = await waitForRemoteCompanionSnapshot(
        secondary,
        input.owner,
        (snapshot) =>
          snapshot.status === "available" &&
          snapshot.sessionId === updated.sessionId &&
          Boolean(snapshot.revision) &&
          snapshot.revision !== updated.revision,
        RELAY_RECOVERY_TIMEOUT_MS,
      );
      expect(recovered.revision).not.toBe(updated.revision);
      await browser.waitForStatus(
        "available",
        Math.max(1, recoveryDeadline - Date.now()),
      );
      await browser.assertContentAvailable();
      await browser.waitForText(
        input.fixture.recoveryMarker,
        Math.max(1, recoveryDeadline - Date.now()),
      );
      if (input.interruptRoute === "relay") {
        await expect.poll(
          () => latestTerminalHeartbeat(input.fixture.sourceUrl),
          { timeout: 30_000, interval: 100 },
        ).toBeGreaterThan(heartbeatBeforeDisconnect);
      }
    }

    await input.fixture.stop();
    await browser.waitForStatus("unavailable");
    await browser.waitForText("This visual companion has ended.");
    await browser.assertContentInert({ staleControlsRemoved: true });
    await waitForRemoteCompanionSnapshot(
      secondary,
      input.owner,
      (snapshot) => snapshot.status === "unavailable",
    );
  } finally {
    await browser.close();
  }
}

describe("remote desktop visual companion", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    fixtureRepoPath = await createFixtureRepo("remote-visual-companion");
    primaryRepoId = await importTestRepo(
      primary,
      fixtureRepoPath,
      "remote-companion-primary",
    );
    secondaryRepoId = await importTestRepo(
      secondary,
      fixtureRepoPath,
      "remote-companion-secondary",
    );
    expect(primaryRepoId).toBeTruthy();
    expect(secondaryRepoId).toBeTruthy();
    await signIn(primary);
    await signIn(secondary);
    primaryDesktopId = await waitForPrimaryDesktopId();
  }, 240_000);

  afterAll(async () => {
    if (!relayConnected) {
      await setRelayConnected(true).catch(() => undefined);
    }
    await cleanupWorktrees(primary, fixtureRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, fixtureRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(
      fixtureRepoPath ? [fixtureRepoPath] : [],
    ).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
  });

  it("mirrors the relay companion in an ordinary external browser and recovers after a real relay restart", async () => {
    const prompt = "Relay external visual companion";
    const task = await createOwnerTask({
      prompt,
      sessionId: "desktop-relay-companion",
      initialMarker: "Initial relay desktop companion",
      updatedMarker: "Updated relay desktop companion",
      recoveryMarker: "Recovered relay desktop companion",
      choice: "relay-layout-a",
    });
    sharedOwnerTask = {
      taskId: task.taskId,
      prompt,
      worktreePath: task.worktreePath,
    };
    await assertScriptedOwnerTask(task.taskId);
    const remote = await waitForRemoteTask({
      prompt,
      transport: "cloud",
      expectedOwnerDesktopId: primaryDesktopId,
      expectedOwnerTaskId: task.taskId,
    });
    expect(remote.owner).toEqual({
      ownerDesktopId: primaryDesktopId,
      ownerTaskId: task.taskId,
    });
    await selectRemoteTask({
      ...remote,
      prompt,
      transport: "cloud",
    });
    await runCompanionJourney({
      owner: remote.owner,
      fixture: task.fixture,
      interruptRoute: "relay",
    });
    await assertScriptedOwnerTask(task.taskId);
  }, 180_000);

  it("mirrors the paired LAN companion through the same external-browser bridge", async () => {
    if (!sharedOwnerTask) {
      throw new Error("relay owner task was not created");
    }
    await pairWithPeerThroughUi(primary, "Secondary", "peer-secondary", {
      promptClient: secondary,
      promptPeerId: "peer-primary",
    });
    const task = sharedOwnerTask;
    const fixture = await createRemoteCompanionFixture({
      worktreePath: task.worktreePath,
      sessionId: "desktop-lan-companion",
      initialMarker: "Initial LAN desktop companion",
      updatedMarker: "Updated LAN desktop companion",
      recoveryMarker: "Recovered LAN desktop companion",
      choice: "lan-layout-a",
    });
    const remote = await waitForRemoteTask({
      prompt: task.prompt,
      transport: "lan",
      expectedOwnerDesktopId: "peer-primary",
      expectedOwnerTaskId: task.taskId,
    });
    expect(remote.owner).toEqual({
      ownerDesktopId: "peer-primary",
      ownerTaskId: task.taskId,
    });
    await selectRemoteTask({
      ...remote,
      prompt: task.prompt,
      transport: "lan",
    });
    await runCompanionJourney({
      owner: remote.owner,
      fixture,
      interruptRoute: "lan",
    });
  }, 180_000);

  it("keeps two recently selected LAN terminals and companions concurrently interactive and isolated", async () => {
    const taskA = await createOwnerTask({
      prompt: "Concurrent visual companion A",
      sessionId: "desktop-concurrent-companion-a",
      initialMarker: "Initial concurrent companion A",
      updatedMarker: "Updated concurrent companion A",
      recoveryMarker: "unused A",
      choice: "concurrent-a",
    });
    const taskB = await createOwnerTask({
      prompt: "Concurrent visual companion B",
      sessionId: "desktop-concurrent-companion-b",
      initialMarker: "Initial concurrent companion B",
      updatedMarker: "Updated concurrent companion B",
      recoveryMarker: "unused B",
      choice: "concurrent-b",
    });
    const remoteA = await waitForRemoteTask({
      prompt: "Concurrent visual companion A",
      transport: "lan",
      expectedOwnerDesktopId: "peer-primary",
      expectedOwnerTaskId: taskA.taskId,
    });
    const remoteB = await waitForRemoteTask({
      prompt: "Concurrent visual companion B",
      transport: "lan",
      expectedOwnerDesktopId: "peer-primary",
      expectedOwnerTaskId: taskB.taskId,
    });
    let browserA: RemoteCompanionBrowser | null = null;
    let browserB: RemoteCompanionBrowser | null = null;
    try {
      await selectRemoteTask({
        ...remoteA,
        prompt: "Concurrent visual companion A",
        transport: "lan",
      });
      await waitForTerminalSource(
        remoteA.owner.ownerTaskId,
        taskA.fixture.sourceUrl,
      );
      const visibleDimensionsA = await visibleRemoteTerminalDimensions(
        remoteA.owner.ownerTaskId,
        taskA.fixture.sourceUrl,
      );
      expect(visibleDimensionsA.cols).toBeGreaterThan(2);
      expect(visibleDimensionsA.rows).toBeGreaterThan(1);
      await expect.poll(
        () => ownerTerminalDimensions(remoteA.owner.ownerTaskId),
        { timeout: 10_000, interval: 100 },
      ).toEqual(visibleDimensionsA);
      const initialA = await activateRemoteCompanionLink(
        secondary,
        remoteA.owner,
        taskA.fixture.sourceUrl,
      );
      browserA = await RemoteCompanionBrowser.open(initialA.entryUrl!);
      await browserA.waitForText("Initial concurrent companion A");

      // Selecting B hides A without releasing its terminal subscription.
      await selectRemoteTask({
        ...remoteB,
        prompt: "Concurrent visual companion B",
        transport: "lan",
      });
      await waitForTerminalSource(
        remoteB.owner.ownerTaskId,
        taskB.fixture.sourceUrl,
      );
      const hiddenHeartbeatA = await latestTaskTerminalHeartbeat(
        remoteA.owner.ownerTaskId,
        taskA.fixture.sourceUrl,
      );
      expect(hiddenHeartbeatA).toBeGreaterThanOrEqual(0);
      await expect.poll(
        () => latestTaskTerminalHeartbeat(
          remoteA.owner.ownerTaskId,
          taskA.fixture.sourceUrl,
        ),
        { timeout: 10_000, interval: 250 },
      ).toBeGreaterThan(hiddenHeartbeatA);
      await sleep(1_000);
      expect(await ownerTerminalDimensions(remoteA.owner.ownerTaskId)).toEqual(
        visibleDimensionsA,
      );
      await captureNextRemoteCompanionOpen(secondary, remoteB.owner);
      await activateVisibleCompanionControl(secondary, "Enter");
      const initialB = await waitForRemoteCompanionSnapshot(
        secondary,
        remoteB.owner,
        (snapshot) =>
          snapshot.status === "available" &&
          Boolean(snapshot.sessionId && snapshot.revision && snapshot.entryUrl),
      );
      expect(initialB.entryUrl).toBeTruthy();
      browserB = await RemoteCompanionBrowser.open(initialB.entryUrl!);
      await browserB.waitForText("Initial concurrent companion B");

      await activateVisibleCompanionControl(secondary, "Space");
      const openedB = await waitForRemoteCompanionSnapshot(
        secondary,
        remoteB.owner,
        (snapshot) =>
          snapshot.openerAttempt > initialB.openerAttempt &&
          snapshot.openerOutcome === "success",
      );
      expect(openedB.openerAttempt).toBeGreaterThan(initialB.openerAttempt);
      expect(openedB.openerOutcome).toBe("success");

      await Promise.all([
        taskA.fixture.publishUpdate(),
        taskB.fixture.publishUpdate(),
      ]);
      const [updatedA, updatedB] = await Promise.all([
        waitForRemoteCompanionSnapshot(
          secondary,
          remoteA.owner,
          (snapshot) =>
            snapshot.status === "available" &&
            snapshot.sessionId === initialA.sessionId &&
            Boolean(snapshot.revision) &&
            snapshot.revision !== initialA.revision,
        ),
        waitForRemoteCompanionSnapshot(
          secondary,
          remoteB.owner,
          (snapshot) =>
            snapshot.status === "available" &&
            snapshot.sessionId === initialB.sessionId &&
            Boolean(snapshot.revision) &&
            snapshot.revision !== initialB.revision,
        ),
      ]);
      expect(updatedA.revision).not.toBe(initialA.revision);
      expect(updatedB.revision).not.toBe(initialB.revision);
      await Promise.all([
        browserA.waitForText("Updated concurrent companion A"),
        browserB.waitForText("Updated concurrent companion B"),
      ]);

      await browserA.clickChoice("concurrent-a");
      await browserB.clickChoice("concurrent-b");
      await Promise.all([
        waitForChoice(taskA.fixture, "concurrent-a"),
        waitForChoice(taskB.fixture, "concurrent-b"),
      ]);
      const [eventsA, eventsB] = await Promise.all([
        taskA.fixture.events(),
        taskB.fixture.events(),
      ]);
      expect(eventsA.some((event) => event.choice === "concurrent-b")).toBe(false);
      expect(eventsB.some((event) => event.choice === "concurrent-a")).toBe(false);

      await selectRemoteTask({
        ...remoteA,
        prompt: "Concurrent visual companion A",
        transport: "lan",
      });
      await waitForTerminalSource(
        remoteA.owner.ownerTaskId,
        taskA.fixture.sourceUrl,
      );
      const restoredDimensionsA = await visibleRemoteTerminalDimensions(
        remoteA.owner.ownerTaskId,
        taskA.fixture.sourceUrl,
      );
      expect(restoredDimensionsA.cols).toBeGreaterThan(2);
      expect(restoredDimensionsA.rows).toBeGreaterThan(1);
      await expect.poll(
        () => ownerTerminalDimensions(remoteA.owner.ownerTaskId),
        { timeout: 10_000, interval: 100 },
      ).toEqual(restoredDimensionsA);
      await waitForRemoteCompanionSnapshot(
        secondary,
        remoteA.owner,
        (snapshot) =>
          snapshot.status === "available" &&
          snapshot.revision === updatedA.revision,
      );
      await browserA.waitForStatus("available");
      await browserA.waitForText("Updated concurrent companion A");
    } finally {
      await browserB?.close();
      await browserA?.close();
      await taskB.fixture.stop().catch(() => undefined);
      await taskA.fixture.stop().catch(() => undefined);
    }
  }, 240_000);

  it("keeps navigation and active same-origin assets inside the loopback browser boundary", async () => {
    const prompt = "Navigation boundary visual companion";
    const task = await createOwnerTask({
      prompt,
      sessionId: "desktop-navigation-boundary",
      initialMarker: "Navigation boundary companion",
      updatedMarker: "unused",
      recoveryMarker: "unused",
      choice: "stay-local",
    });
    const fixture = task.fixture;
    await fixture.publishAsset(
      "active.svg",
      Buffer.from([
        '<svg xmlns="http://www.w3.org/2000/svg">',
        "<script>window.top.__activeAssetExecuted=true;window.top.location='https://attacker.invalid/asset'</script>",
        '<a href="https://attacker.invalid/svg"><text>escape</text></a>',
        "</svg>",
      ].join("")),
    );
    await fixture.publishDocument([
      "<main><h1>Navigation boundary companion</h1></main>",
      '<meta http-equiv="refresh" content="0;url=https://attacker.invalid/meta">',
      "<script>window.location='https://attacker.invalid/script'</script>",
      '<a href="/files/active.svg">Open active asset</a>',
      '<iframe src="/files/active.svg"></iframe>',
      '<object data="/files/active.svg"></object>',
      '<svg><animate attributeName="href" to="/files/active.svg"></animate></svg>',
      '<img id="active-image" alt="active" src="/files/active.svg">',
    ].join(""));
    const remote = await waitForRemoteTask({
      prompt,
      transport: "lan",
      expectedOwnerDesktopId: "peer-primary",
      expectedOwnerTaskId: task.taskId,
    });
    await selectRemoteTask({
      ...remote,
      prompt,
      transport: "lan",
    });
    await expect.poll(
      () => secondary.executeSync<boolean>(`
        return Boolean(window.__KANNA_E2E__?.terminalBuffers?.findTextCell(
          ${JSON.stringify(remote.owner.ownerTaskId)},
          ${JSON.stringify(fixture.sourceUrl)}
        ));
      `),
      { timeout: 30_000, interval: 100 },
    ).toBe(true);
    // Terminal output and companion discovery travel over independent
    // channels. Do not physically activate the xterm link until this owner
    // session has published a revision; otherwise the click can legitimately
    // resolve as unavailable before setup catches up.
    await waitForRemoteCompanionSnapshot(
      secondary,
      remote.owner,
      (value) =>
        value.sessionId === fixture.sessionId && Boolean(value.revision),
    );
    const snapshot = await activateRemoteCompanionLink(
      secondary,
      remote.owner,
      fixture.sourceUrl,
    );
    const browser = await RemoteCompanionBrowser.open(snapshot.entryUrl!);
    try {
      await browser.waitForText("Navigation boundary companion");
      await browser.assertNavigationContained();
      await browser.assertActiveAssetInert("active.svg");
    } finally {
      await browser.close();
      await fixture.stop();
    }
  }, 180_000);

});

async function runCausalRemoteInputTest(): Promise<void> {
    await ensureLanPair();
    const taskId = `remote-lan-draft-${randomUUID()}`;
    const prompt = `Remote LAN draft boundary ${randomUUID()}`;
    const readyMarker = `REMOTE_BOUNDARY_READY_${randomUUID().replaceAll("-", "")}`;
    const humanInput = "human-draft";
    const managerInput = "manager-message";
    const script = [
      "select(STDOUT); $| = 1;",
      "system('stty raw -echo');",
      `print qq{\\e[?1004h${readyMarker}\\r\\n};`,
      "my $composer = '';",
      "while (1) {",
      "  my $read = sysread(STDIN, my $chunk, 1);",
      "  last unless defined($read) && $read > 0;",
      "  if ($chunk eq qq{\\e}) {",
      "    my $tail = '';",
      "    my $tail_read = sysread(STDIN, $tail, 2);",
      "    last unless defined($tail_read) && $tail_read == 2;",
      "    if ($tail eq '[I' || $tail eq '[O') {",
      "      print qq{CONTROL:<$composer>\\r\\n};",
      "      next;",
      "    }",
      "    $composer .= $chunk . $tail;",
      "    next;",
      "  }",
      "  if ($chunk eq qq{\\r}) {",
      "    print qq{SUBMIT:<$composer>\\r\\n};",
      "    $composer = '';",
      "    next;",
      "  }",
      "  $composer .= $chunk;",
      "  print qq{DRAFT:<$composer>\\r\\n};",
      "}",
    ].join("\n");

    await execDb(
      primary,
      "INSERT INTO pipeline_item (id, repo_id, prompt, stage, agent_type) VALUES (?, ?, ?, ?, ?)",
      [taskId, primaryRepoId, prompt, "in progress", "pty"],
    );
    await tauriInvoke(primary, "spawn_session", {
      sessionId: taskId,
      cwd: fixtureRepoPath,
      executable: "/usr/bin/perl",
      args: ["-e", script],
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
    });
    await callVueMethod(primary, "loadItems", primaryRepoId);

    try {
      const remote = await waitForRemoteTask({
        prompt,
        transport: "lan",
        expectedOwnerDesktopId: "peer-primary",
        expectedOwnerTaskId: taskId,
      });
      await selectRemoteTask({
        ...remote,
        prompt,
        transport: "lan",
      });
      await waitForRemoteTerminalLine(taskId, readyMarker);

      const terminalTextarea = await secondary.waitForElement(
        ".main-panel .cloud-terminal-shell .xterm-helper-textarea",
      );
      await secondary.sendKeys(terminalTextarea, humanInput);
      await waitForRemoteTerminalLine(taskId, `DRAFT:<${humanInput}>`);

      const { baseUrl } = await resolveAppKannaServer(primary);
      const response = await fetch(
        `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/input`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: managerInput }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `logical task input failed: ${response.status} ${await response.text()}`,
        );
      }

      await secondary.executeSync(`
        const input = document.querySelector(
          ".main-panel .cloud-terminal-shell .xterm-helper-textarea"
        );
        if (!(input instanceof HTMLTextAreaElement)) {
          throw new Error("remote terminal textarea unavailable");
        }
        input.blur();
      `);
      await waitForRemoteTerminalLine(taskId, `CONTROL:<${humanInput}>`);
      await secondary.executeSync(`
        const input = document.querySelector(
          ".main-panel .cloud-terminal-shell .xterm-helper-textarea"
        );
        if (!(input instanceof HTMLTextAreaElement)) {
          throw new Error("remote terminal textarea unavailable");
        }
        input.focus();
      `);
      await secondary.pressKey("\uE007");
      await waitForRemoteTerminalLine(taskId, `SUBMIT:<${managerInput}>`);

      const submittedLines = await secondary.executeSync<string[]>(`
        const buffers = window.__KANNA_E2E__?.terminalBuffers;
        if (!buffers) throw new Error("terminal buffer hook unavailable");
        return buffers.lines(${JSON.stringify(taskId)})
          .filter((line) => line.startsWith("SUBMIT:"));
      `);
      expect(submittedLines).toEqual([
        `SUBMIT:<${humanInput}>`,
        `SUBMIT:<${managerInput}>`,
      ]);
    } finally {
      await tauriInvoke(primary, "kill_session", { sessionId: taskId })
        .catch(() => undefined);
    }
}

describe("remote desktop LAN input semantics", () => {
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
    fixtureRepoPath = await createFixtureRepo("remote-lan-input-semantics");
    primaryRepoId = await importTestRepo(
      primary,
      fixtureRepoPath,
      "remote-input-primary",
    );
    secondaryRepoId = await importTestRepo(
      secondary,
      fixtureRepoPath,
      "remote-input-secondary",
    );
    expect(primaryRepoId).toBeTruthy();
    expect(secondaryRepoId).toBeTruthy();
    lanPairReady = false;
    await ensureLanPair();
  }, 120_000);

  afterAll(async () => {
    await cleanupWorktrees(primary, fixtureRepoPath).catch(() => undefined);
    await cleanupWorktrees(secondary, fixtureRepoPath).catch(() => undefined);
    await cleanupFixtureRepos(
      fixtureRepoPath ? [fixtureRepoPath] : [],
    ).catch(() => undefined);
    await primary.deleteSession().catch(() => undefined);
    await secondary.deleteSession().catch(() => undefined);
    lanPairReady = false;
  });

  it(
    "keeps remote LAN draft, control, submission, and logical API input separate and ordered",
    runCausalRemoteInputTest,
    120_000,
  );
});
