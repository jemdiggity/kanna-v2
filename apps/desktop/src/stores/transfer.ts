import {
  approveIncomingTaskTransfer,
  pushTaskToPeer as requestTaskPush,
  rejectIncomingTaskTransfer,
} from "../services/desktopServerClient";

/**
 * Transfer intents.
 *
 * Everything that used to be here — `pushTaskToPeer`, `finalizeOutgoingTransfer`,
 * `importTransferredResumeState`, `approveIncomingTransfer`,
 * `handleOutgoingTransferCommitted`, the repository acquisition, the `git
 * bundle`/`git clone`/`tar` shell-outs — now runs in `kanna-server`'s transfer
 * engine. It had to: a window can close mid-transfer, and on 2026-08-06 one did,
 * taking the finalization signal, the failure report and the commit
 * acknowledgment with it.
 *
 * What the renderer expresses is intent. Progress comes back through the
 * snapshot's `transfer_status`, which the sidebar already renders, so there is
 * no bespoke event protocol left between the two.
 */

export interface PushTaskTransferOptions {
  transport?: "lan" | "cloud";
  cloudFallback?: boolean;
  targetDesktopId?: string | null;
  /**
   * Distinguishes a deliberate re-push from a retried request. Two intents
   * carrying the same key are one intent; the engine's own eligibility read is
   * what stops two different intents racing into one transfer.
   */
  intentKey?: string;
}

export interface TransferApi {
  pushTaskToPeer: (
    taskId: string,
    peerId: string,
    options?: PushTaskTransferOptions,
  ) => Promise<void>;
  approveIncomingTransfer: (transferId: string) => Promise<void>;
  rejectIncomingTransfer: (transferId: string) => Promise<void>;
}

export function createTransferApi(): TransferApi {
  return {
    async pushTaskToPeer(taskId, peerId, options = {}) {
      await requestTaskPush(taskId, peerId, options);
    },
    async approveIncomingTransfer(transferId) {
      await approveIncomingTaskTransfer(transferId);
    },
    async rejectIncomingTransfer(transferId) {
      await rejectIncomingTaskTransfer(transferId);
    },
  };
}
