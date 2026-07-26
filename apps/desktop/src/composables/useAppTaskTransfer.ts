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
  fetchIncomingTransferCleanupCandidates,
  fetchPendingIncomingTransfers,
  markIncomingTransferSidecarCleanupCompleted,
  renewIncomingTransferClaim,
  type PendingIncomingTransfer,
} from "../services/desktopServerClient";
import {
  filterPairableTransferPeerPayload,
  type TransferMachine,
} from "../services/desktopTransferMachines";
import type { WorkspaceTask } from "../workspace/types";

interface UseAppTaskTransferOptions {
  db: DbHandle;
  store: ReturnType<typeof useKannaStore>;
  toast: ReturnType<typeof useToast>;
  showPeerPicker: Ref<boolean>;
  transferMachines?: Readonly<Ref<TransferMachine[]>>;
  refreshCloudTransferRoute?: (peerId: string) => Promise<void>;
  onLanTransferPeersChanged?: (peers: unknown) => void;
}

const TRANSFER_PEER_DISCOVERY_RETRY_MS = 250;
const TRANSFER_PEER_DISCOVERY_TIMEOUT_MS = 2500;

export function useAppTaskTransfer({
  db,
  store,
  toast,
  showPeerPicker,
  transferMachines,
  refreshCloudTransferRoute,
  onLanTransferPeersChanged,
}: UseAppTaskTransferOptions) {
  const peerPickerMode = ref<"push" | "pair">("push");
  const selectedTransferTaskId = ref<string | null>(null);
  const transferPeers = ref<TransferPeerOption[]>([]);
  const transferPeersLoading = ref(false);
  const transferPeerActionPending = ref(false);
  let transferPeerLoadRequestId = 0;

  async function importIncomingTransfer(
    transferId: string,
    recovery: boolean,
  ): Promise<boolean> {
    const ownerToken = crypto.randomUUID();
    if (!await claimPendingIncomingTransfer(transferId, ownerToken, recovery)) {
      return false;
    }

    const renewal = window.setInterval(() => {
      void renewIncomingTransferClaim(transferId, ownerToken).then((renewed) => {
        if (!renewed) {
          console.warn("[App] incoming transfer claim lease was lost:", { transferId });
        }
      }).catch((error: unknown) => {
        console.warn("[App] failed to renew incoming transfer claim lease:", {
          transferId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 10_000);
    try {
      await store.approveIncomingTransfer(transferId, ownerToken);
      return true;
    } finally {
      window.clearInterval(renewal);
    }
  }

  function transferMachineOption(machine: TransferMachine): TransferPeerOption {
    const subtitle = machine.trustSource === "same-account-cloud"
      ? machine.preferredTransport === "lan"
        ? "Nearby · Cloud"
        : "Cloud"
      : "Nearby";
    return {
      id: machine.peerId,
      name: machine.name,
      subtitle,
      trusted: true,
      acceptingTransfers: true,
    };
  }

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
    const pickerMode = peerPickerMode.value;
    transferPeersLoading.value = true;
    try {
      const maxAttempts =
        Math.floor(TRANSFER_PEER_DISCOVERY_TIMEOUT_MS / TRANSFER_PEER_DISCOVERY_RETRY_MS) + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const raw = await invoke<unknown>("list_transfer_peers");
        onLanTransferPeersChanged?.(raw);
        const peers = pickerMode === "pair"
          ? parseTransferPeers(filterPairableTransferPeerPayload(raw))
          : transferMachines?.value?.map(transferMachineOption)
            ?? parseTransferPeers(raw).filter((peer) => peer.trusted);
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
      const peers = await invoke<unknown>("list_transfer_peers");
      onLanTransferPeersChanged?.(peers);
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
    const selectedMachine = transferMachines?.value?.find((machine) => machine.peerId === peerId);
    try {
      transferPeerActionPending.value = true;
      if (selectedMachine?.relayDesktopId && refreshCloudTransferRoute) {
        await refreshCloudTransferRoute(peerId);
      }
      if (selectedMachine) {
        await store.pushTaskToPeer(taskId, peerId, {
          transport: selectedMachine.preferredTransport,
          cloudFallback: selectedMachine.cloudFallback,
          targetDesktopId: selectedMachine.desktopId,
        });
      } else {
        await store.pushTaskToPeer(taskId, peerId);
      }
      closePeerPicker();
    } catch (e: unknown) {
      console.error("[App] task transfer push failed:", e);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      transferPeerActionPending.value = false;
    }
  }

  async function pullSelectedWorkspaceTask(task: WorkspaceTask): Promise<void> {
    if (transferPeerActionPending.value) return;
    const owner = task.terminal.remoteRef;
    if (
      !owner
      || !task.capabilities.canPullFromMachine
      || !owner.transferPeerId?.trim()
    ) {
      toast.error("Remote task owner is offline.");
      return;
    }
    transferPeerActionPending.value = true;
    try {
      if (
        owner.preferredTransferTransport === "cloud"
        && refreshCloudTransferRoute
      ) {
        await refreshCloudTransferRoute(owner.transferPeerId);
      }
      await invoke("request_task_pull", {
        targetPeerId: owner.transferPeerId,
        sourceTaskId: owner.ownerLocalTaskId,
        transport: owner.preferredTransferTransport,
      });
    } catch (e: unknown) {
      console.error("[App] task transfer pull failed:", e);
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
    async function cleanupTerminalIncomingTransfer(transferId: string): Promise<void> {
      try {
        await invoke("mark_incoming_transfer_ack_completed", { transferId });
        if (!await markIncomingTransferSidecarCleanupCompleted(transferId)) {
          throw new Error(`failed to mark sidecar cleanup completed: ${transferId}`);
        }
      } catch (error: unknown) {
        console.warn("[App] failed to clean up terminal incoming transfer reservation:", {
          transferId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const cleanupCandidates = await fetchIncomingTransferCleanupCandidates();
      for (const transferId of cleanupCandidates) {
        await cleanupTerminalIncomingTransfer(transferId);
      }
    } catch (error: unknown) {
      console.warn(
        "[App] failed to list incoming transfer cleanup candidates:",
        error instanceof Error ? error.message : String(error),
      );
    }

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
          await cleanupTerminalIncomingTransfer(row.id);
          console.warn("[App] disabled malformed pending incoming transfer:", { transferId: row.id, reason });
        }
        continue;
      }

      try {
        if (!await importIncomingTransfer(row.id, true)) {
          continue;
        }
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        if (await failPendingIncomingTransfer(row.id, reason)) {
          await cleanupTerminalIncomingTransfer(row.id);
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
    pullSelectedWorkspaceTask,
    importIncomingTransfer,
    importPendingIncomingTransfers,
  };
}
