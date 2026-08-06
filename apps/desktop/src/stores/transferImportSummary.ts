import { invoke } from "../invoke";
import { parseTransferPeers, type OutgoingTransferPayload } from "../utils/taskTransfer";

/**
 * Display-only provenance for a task that arrived by cross-machine transfer.
 * The server prints it into the destination PTY once, before the agent starts,
 * so an imported task announces where it came from instead of just appearing.
 *
 * The source PTY is deliberately never written to: it holds a live agent TUI,
 * and the transcript it ships is what the destination resumes from.
 */
export interface TransferImportSummary {
  sourceMachine: string | null;
  repoMode: string | null;
  sessionRestored: boolean;
}

/**
 * Peer display names live in the transfer sidecar's registry, not in the
 * transfer payload. Resolving one is best effort: an unreachable sidecar or an
 * unknown peer falls back to the peer id, which still identifies the machine.
 */
async function resolveSourceMachineName(peerId: string | null): Promise<string | null> {
  if (!peerId) return null;
  try {
    const peers = parseTransferPeers(await invoke<unknown>("list_transfer_peers"));
    return peers.find((peer) => peer.id === peerId)?.name ?? peerId;
  } catch (error: unknown) {
    console.debug("[store] failed to resolve transfer source machine name:", error);
    return peerId;
  }
}

export async function buildTransferImportSummary(
  payload: OutgoingTransferPayload,
  resumeSessionId: string | null,
): Promise<TransferImportSummary> {
  return {
    sourceMachine: await resolveSourceMachineName(payload.task.source_peer_id),
    repoMode: payload.repo.mode,
    sessionRestored: Boolean(resumeSessionId),
  };
}
