import { ref, type Ref } from "vue";
import type { DbHandle } from "../types/kanna";

import { isTauri } from "../tauri-mock";
import { invoke } from "../invoke";
import {
  parsePairingResult,
  parseTransferPeers,
  type TransferPeerOption,
} from "../utils/taskTransfer";
import type { useKannaStore } from "../stores/kanna";
import type { useToast } from "./useToast";
import {
  claimPendingIncomingTransfer,
  failPendingIncomingTransfer,
  fetchPendingIncomingTransfers,
  type PendingIncomingTransfer,
} from "../services/desktopServerClient";

interface UseAppTaskTransferOptions {
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  showPeerPicker: Ref<boolean>;
}

const TRANSFER_PEER_DISCOVERY_RETRY_MS = 250;
const TRANSFER_PEER_DISCOVERY_TIMEOUT_MS = 2500;

export function useAppTaskTransfer({
  db,
  store,
  toast,
  showPeerPicker,
}: UseAppTaskTransferOptions) {
  const peerPickerMode = ref<"push" | "pair">("push");
  const selectedTransferTaskId = ref<string | null>(null);
  const transferPeers = ref<TransferPeerOption[]>([]);
  const transferPeersLoading = ref(false);
  const transferPeerActionPending = ref(false);
  let transferPeerLoadRequestId = 0;

  function validatePendingIncomingTransferRow(row: PendingIncomingTransfer): string | null {
    if (!row.source_peer_id) return "missing source_peer_id";
    if (!row.source_task_id) return "missing source_task_id";
    if (!row.payload_json) return "missing payload_json";

    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== "object") return "payload_json did not decode to an object";
      const record = parsed as { task?: unknown; repo?: unknown };
      if (!record.task || typeof record.task !== "object") return "payload_json missing task";
      if (!record.repo || typeof record.repo !== "object") return "payload_json missing repo";
    } catch (error: unknown) {
      return `payload_json is invalid: ${error instanceof Error ? error.message : String(error)}`;
    }

    return null;
  }

  async function loadTransferPeers() {
    const requestId = ++transferPeerLoadRequestId;
    transferPeersLoading.value = true;
    try {
      const maxAttempts =
        Math.floor(TRANSFER_PEER_DISCOVERY_TIMEOUT_MS / TRANSFER_PEER_DISCOVERY_RETRY_MS) + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const raw = await invoke<unknown>("list_transfer_peers");
        const peers = parseTransferPeers(raw);
        if (requestId !== transferPeerLoadRequestId) {
          return;
        }
        if (peers.length > 0 || attempt === maxAttempts - 1) {
          transferPeers.value = peers;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, TRANSFER_PEER_DISCOVERY_RETRY_MS));
      }
    } catch (e: unknown) {
      console.error(
        "[App] failed to list transfer peers:",
        e instanceof Error ? e.message : String(e),
      );
      if (requestId === transferPeerLoadRequestId) {
        transferPeers.value = [];
      }
    } finally {
      if (requestId === transferPeerLoadRequestId) {
        transferPeersLoading.value = false;
      }
    }
  }

  async function warmTransferSidecar() {
    if (!isTauri) return;
    try {
      await invoke("list_transfer_peers");
    } catch (e: unknown) {
      console.error(
        "[App] transfer sidecar warmup failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  function openPeerPicker(taskId: string) {
    console.debug("[transfer] opening push-to-machine picker", { taskId });
    selectedTransferTaskId.value = taskId;
    peerPickerMode.value = "push";
    transferPeerActionPending.value = false;
    showPeerPicker.value = true;
    void loadTransferPeers();
  }

  function openPairPeerPicker() {
    console.debug("[transfer] opening pair-machine picker");
    selectedTransferTaskId.value = null;
    peerPickerMode.value = "pair";
    transferPeerActionPending.value = false;
    showPeerPicker.value = true;
    void loadTransferPeers();
  }

  function closePeerPicker() {
    showPeerPicker.value = false;
    selectedTransferTaskId.value = null;
    peerPickerMode.value = "push";
    transferPeerActionPending.value = false;
  }

  async function handlePeerSelected(peerId: string) {
    if (transferPeerActionPending.value) return;
    const taskId = selectedTransferTaskId.value;
    if (!taskId) return;
    const selectedPeer = transferPeers.value.find((peer) => peer.id === peerId);
    if (selectedPeer && !selectedPeer.trusted) {
      toast.error("Pair this peer before transferring a task.");
      return;
    }
    try {
      transferPeerActionPending.value = true;
      await store.pushTaskToPeer(taskId, peerId);
      closePeerPicker();
    } catch (e: unknown) {
      console.error("[App] task transfer push failed:", e);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      transferPeerActionPending.value = false;
    }
  }

  async function handlePairPeer(peerId: string) {
    if (transferPeerActionPending.value) return;
    try {
      transferPeerActionPending.value = true;
      console.debug("[transfer] pair-machine request started", { peerId });
      const result = parsePairingResult(await invoke("start_peer_pairing", { peerId }));
      console.debug("[transfer] pair-machine request completed", {
        peerId,
        pairedPeerId: result.peer.id,
        pairedPeerName: result.peer.name,
      });
      toast.info(`Paired with ${result.peer.name}. Verify code ${result.verificationCode}.`);
      closePeerPicker();
      await loadTransferPeers();
    } catch (e: unknown) {
      console.error("[App] peer pairing failed:", e);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      transferPeerActionPending.value = false;
    }
  }

  async function importPendingIncomingTransfers() {
    void db;
    let rows: PendingIncomingTransfer[];
    try {
      rows = await fetchPendingIncomingTransfers();
    } catch (error: unknown) {
      console.warn(
        "[App] failed to list pending incoming transfers:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    for (const row of rows) {
      const invalidReason = validatePendingIncomingTransferRow(row);
      if (invalidReason) {
        const reason = `pending incoming transfer is malformed: ${invalidReason}`;
        if (await failPendingIncomingTransfer(row.id, reason)) {
          console.warn("[App] disabled malformed pending incoming transfer:", { transferId: row.id, reason });
        }
        continue;
      }

      const claimed = await claimPendingIncomingTransfer(row.id);
      if (!claimed) {
        continue;
      }

      try {
        await store.approveIncomingTransfer(row.id);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        if (await failPendingIncomingTransfer(row.id, reason)) {
          console.warn("[App] failed to auto-import pending incoming transfer; marked failed:", {
            transferId: row.id,
            reason,
          });
        }
      }
    }
  }

  return {
    peerPickerMode,
    selectedTransferTaskId,
    transferPeers,
    transferPeersLoading,
    transferPeerActionPending,
    warmTransferSidecar,
    openPeerPicker,
    openPairPeerPicker,
    closePeerPicker,
    handlePeerSelected,
    handlePairPeer,
    importPendingIncomingTransfers,
  };
}
