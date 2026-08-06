import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGlobalKeydownScript } from "../helpers/keyboard";
import { resetDatabase } from "../helpers/reset";
import { pauseForSlowMode } from "../helpers/slowMode";
import { createPrimaryAndSecondaryClients } from "../helpers/twoInstance";
import { getVueState, tauriInvoke } from "../helpers/vue";

interface TransferPeer {
  peer_id?: string;
  peerId?: string;
  display_name?: string;
  displayName?: string;
  public_key?: string;
  publicKey?: string;
  trusted?: boolean;
}

function readPeerId(peer: TransferPeer): string | null {
  if (typeof peer.peer_id === "string" && peer.peer_id.length > 0) return peer.peer_id;
  if (typeof peer.peerId === "string" && peer.peerId.length > 0) return peer.peerId;
  return null;
}

function readPeerDisplayName(peer: TransferPeer): string | null {
  if (typeof peer.display_name === "string" && peer.display_name.length > 0) return peer.display_name;
  if (typeof peer.displayName === "string" && peer.displayName.length > 0) return peer.displayName;
  return null;
}

function readPeerPublicKey(peer: TransferPeer): string | null {
  if (typeof peer.public_key === "string" && peer.public_key.length > 0) return peer.public_key;
  if (typeof peer.publicKey === "string" && peer.publicKey.length > 0) return peer.publicKey;
  return null;
}

function computePairingCode(leftPeer: TransferPeer, rightPeer: TransferPeer): string {
  const leftPeerId = readPeerId(leftPeer);
  const rightPeerId = readPeerId(rightPeer);
  const leftPublicKey = readPeerPublicKey(leftPeer);
  const rightPublicKey = readPeerPublicKey(rightPeer);
  if (!leftPeerId || !rightPeerId || !leftPublicKey || !rightPublicKey) {
    throw new Error("cannot compute pairing code without both peer ids and public keys");
  }

  const participants = [
    `${leftPeerId}:${leftPublicKey}`,
    `${rightPeerId}:${rightPublicKey}`,
  ].sort();
  const digest = createHash("sha256")
    .update(participants[0])
    .update("|")
    .update(participants[1])
    .digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, "0");
}

async function installPairingPromptStub(code: string): Promise<void> {
  await secondary.executeSync(
    `window.__KANNA_E2E_PAIRING_PROMPT__ = { called: false, message: null, returnedCode: ${JSON.stringify(code)} };
     window.prompt = (message) => {
       window.__KANNA_E2E_PAIRING_PROMPT__.called = true;
       window.__KANNA_E2E_PAIRING_PROMPT__.message = message;
       return window.__KANNA_E2E_PAIRING_PROMPT__.returnedCode;
     };`,
  );
}

async function waitForSecondaryPairingPrompt(timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prompt = await secondary.executeSync<{ called?: boolean; message?: string | null }>(
      `return window.__KANNA_E2E_PAIRING_PROMPT__ ?? null;`,
    );
    if (prompt?.called && typeof prompt.message === "string") {
      return prompt.message;
    }
    await sleep(100);
  }

  throw new Error("timed out waiting for secondary pairing prompt");
}

async function waitForPeer(
  client: typeof primary,
  peerId: string,
  predicate: (peer: TransferPeer) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<TransferPeer> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = await tauriInvoke(client, "list_transfer_peers");
    if (Array.isArray(raw)) {
      const peer = (raw as TransferPeer[]).find(
        (candidate) => readPeerId(candidate) === peerId && predicate(candidate),
      );
      if (peer) {
        return peer;
      }
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for peer ${peerId}`);
}

async function waitForPairPickerReady(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observed = "never sampled";

  while (Date.now() < deadline) {
    const mode = await getVueState(primary, "peerPickerMode");
    const visible = await getVueState(primary, "showPeerPicker");
    const loading = await getVueState(primary, "transferPeersLoading");
    if (mode === "pair" && visible === true && loading === false) {
      return;
    }
    // Three separate conditions fail this wait; without the last sample the
    // failure cannot be told apart from a picker that never opened.
    observed = `mode=${String(mode)} visible=${String(visible)} loading=${String(loading)}`;
    await sleep(250);
  }

  throw new Error(`timed out waiting for Pair Machine picker to load peers (${observed})`);
}

async function waitForPrimaryButtonEnabled(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const enabled = await primary.executeSync<boolean>(
      `const button = [...document.querySelectorAll(".btn-primary")]
        .find((candidate) => candidate.textContent?.includes("Pair Machine"));
       return Boolean(button && !button.disabled);`,
    );
    if (enabled) return;
    await sleep(100);
  }

  throw new Error("timed out waiting for Pair Machine action to become enabled");
}

async function deleteSessionIfRunning(client: { deleteSession(): Promise<void> }): Promise<void> {
  await client.deleteSession().catch(() => undefined);
}

const { primary, secondary } = createPrimaryAndSecondaryClients();

describe("local transfer Pair Machine", () => {
  // The accept-without-reply timeout path stays covered by the task-transfer runtime test.
  // This real E2E harness only launches full responsive sidecars; testing that timeout
  // end to end would require harness support for a controllable fake registered peer.
  beforeAll(async () => {
    await primary.createSession();
    await secondary.createSession();
    await resetDatabase(primary);
    await resetDatabase(secondary);
  });

  afterAll(async () => {
    await deleteSessionIfRunning(primary);
    await deleteSessionIfRunning(secondary);
  });

  it("pairs an untrusted secondary peer through the command palette and modal", async () => {
    const discovered = await waitForPeer(
      primary,
      "peer-secondary",
      (peer) => peer.trusted === false,
    );
    expect(readPeerDisplayName(discovered)).toBe("Secondary");
    const primaryDiscoveredFromSecondary = await waitForPeer(
      secondary,
      "peer-primary",
      (peer) => peer.trusted === false,
    );
    const pairingCode = computePairingCode(discovered, primaryDiscoveredFromSecondary);
    await installPairingPromptStub(pairingCode);
    await pauseForSlowMode("untrusted secondary peer discovered");

    await primary.executeSync(buildGlobalKeydownScript({ key: "P", meta: true, shift: true }));
    const commandInput = await primary.waitForElement(".palette-input", 2_000);
    await primary.sendKeys(commandInput, "Pair Machine");
    const pairCommand = await primary.waitForText(".command-item", "Pair Machine", 2_000);
    await primary.click(pairCommand);
    await pauseForSlowMode("Pair Machine command selected");

    await waitForPairPickerReady();
    const peerRow = await primary.waitForText(".peer-row", "Secondary", 5_000);
    await primary.click(peerRow);
    await waitForPrimaryButtonEnabled();
    const pairButton = await primary.waitForText(".btn-primary", "Pair Machine", 2_000);
    await primary.click(pairButton);
    await pauseForSlowMode("Pair Machine action clicked");

    const startedToast = await primary.waitForText(".toast", `Enter code ${pairingCode} on Secondary.`, 10_000);
    expect(await primary.getText(startedToast)).toContain(`Enter code ${pairingCode} on Secondary.`);

    const secondaryPromptMessage = await waitForSecondaryPairingPrompt();
    expect(secondaryPromptMessage).toBe("Enter pairing code for Primary");

    const primaryPeer = await waitForPeer(
      primary,
      "peer-secondary",
      (peer) => peer.trusted === true,
    );
    expect(primaryPeer.trusted).toBe(true);

    const secondaryPeer = await waitForPeer(
      secondary,
      "peer-primary",
      (peer) => peer.trusted === true,
    );
    expect(secondaryPeer.trusted).toBe(true);

    const primaryToast = await primary.waitForText(".toast", "Paired with Secondary. Verify code", 10_000);
    const primaryToastText = await primary.getText(primaryToast);
    expect(primaryToastText).toContain(`Verify code ${pairingCode}`);

    const secondaryToast = await secondary.waitForText(".toast", "Paired with Primary. Verify code", 10_000);
    const secondaryToastText = await secondary.getText(secondaryToast);
    expect(secondaryToastText).toContain(`Verify code ${pairingCode}`);

    expect(await getVueState(primary, "showPeerPicker")).toBe(false);
  });
});
