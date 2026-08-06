import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildTransferImportSummary } from "./transferImportSummary";
import type { OutgoingTransferPayload } from "../utils/taskTransfer";

const listTransferPeersMock = vi.fn();

vi.mock("../invoke", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "list_transfer_peers") return listTransferPeersMock();
    throw new Error(`unexpected invoke: ${command}`);
  }),
}));

function payload(overrides: {
  sourcePeerId?: string;
  repoMode?: OutgoingTransferPayload["repo"]["mode"];
} = {}): OutgoingTransferPayload {
  return {
    target_peer_id: "peer-secondary",
    target_desktop_id: null,
    task: {
      cloud_task_id: "cloud-1",
      source_peer_id: overrides.sourcePeerId ?? "peer-primary",
      source_desktop_id: null,
      source_task_id: "task-source",
      prompt: "Keep going",
      stage: "in progress",
      branch: "task-source",
      pipeline: "no-review",
      display_name: null,
      base_ref: "origin/main",
      agent_type: "pty",
      agent_provider: "claude",
    },
    repo: {
      mode: overrides.repoMode ?? "bundle-repo",
      remote_url: null,
      path: null,
      name: "repo",
      default_branch: "main",
      bundle: null,
    },
    recovery: null,
  };
}

describe("buildTransferImportSummary", () => {
  beforeEach(() => {
    listTransferPeersMock.mockReset();
  });

  it("names the source machine from the peer registry and reports a restored session", async () => {
    listTransferPeersMock.mockResolvedValue([
      { peer_id: "peer-primary", display_name: "Primary", trusted: true, accepting_transfers: true },
    ]);

    expect(await buildTransferImportSummary(payload(), "session-1")).toEqual({
      sourceMachine: "Primary",
      repoMode: "bundle-repo",
      sessionRestored: true,
    });
  });

  it("reports that no session history was restored when the transfer carried none", async () => {
    listTransferPeersMock.mockResolvedValue([
      { peer_id: "peer-primary", display_name: "Primary", trusted: true, accepting_transfers: true },
    ]);

    expect(await buildTransferImportSummary(payload({ repoMode: "reuse-local" }), null)).toEqual({
      sourceMachine: "Primary",
      repoMode: "reuse-local",
      sessionRestored: false,
    });
  });

  // The peer registry lives in the transfer sidecar, which is not required for
  // an import to succeed. The summary is display only, so an unreachable or
  // forgetful registry degrades to the peer id rather than failing the import.
  it("falls back to the peer id when the registry is unreachable or has forgotten the peer", async () => {
    listTransferPeersMock.mockRejectedValue(new Error("sidecar is down"));
    expect((await buildTransferImportSummary(payload(), null)).sourceMachine).toBe("peer-primary");

    listTransferPeersMock.mockResolvedValue([]);
    expect((await buildTransferImportSummary(payload(), null)).sourceMachine).toBe("peer-primary");
  });
});
