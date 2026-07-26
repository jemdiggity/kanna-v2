import { describe, expect, it } from "vitest";

import {
  filterPairableTransferPeerPayload,
  mergeTransferMachines,
  type LanTransferPeer,
} from "./desktopTransferMachines";
import type { DesktopCloudTransferMachine } from "./desktopCloudTaskIndex";

const lanPeer = (overrides: Partial<LanTransferPeer> = {}): LanTransferPeer => ({
  id: "peer-b",
  name: "Mac B",
  publicKey: "key-b",
  endpoint: "192.168.1.2:4455",
  trusted: false,
  acceptingTransfers: true,
  ...overrides,
});

const cloudMachine = (
  overrides: Partial<DesktopCloudTransferMachine> = {},
): DesktopCloudTransferMachine => ({
  desktopId: "desktop-b",
  displayName: "Mac B",
  online: true,
  peerId: "peer-b",
  publicKey: "key-b",
  protocolVersion: 1,
  acceptingTransfers: true,
  ...overrides,
});

describe("mergeTransferMachines", () => {
  it("uses same-account trust for a matching LAN peer and keeps cloud fallback", () => {
    expect(mergeTransferMachines({
      currentDesktopId: "desktop-a",
      lanPeers: [lanPeer()],
      cloudMachines: [cloudMachine()],
    })).toEqual([expect.objectContaining({
      peerId: "peer-b",
      trustSource: "same-account-cloud",
      preferredTransport: "lan",
      relayDesktopId: "desktop-b",
      cloudFallback: true,
    })]);
  });

  it("excludes the current, offline, incompatible, and non-accepting cloud desktops", () => {
    expect(mergeTransferMachines({
      currentDesktopId: "desktop-a",
      lanPeers: [],
      cloudMachines: [
        cloudMachine({ desktopId: "desktop-a" }),
        cloudMachine({ desktopId: "desktop-offline", peerId: "peer-offline", online: false }),
        cloudMachine({ desktopId: "desktop-v2", peerId: "peer-v2", protocolVersion: 2 }),
        cloudMachine({
          desktopId: "desktop-disabled",
          peerId: "peer-disabled",
          acceptingTransfers: false,
        }),
      ],
    })).toEqual([]);
  });

  it("prefers cloud for an eligible cloud-only machine", () => {
    expect(mergeTransferMachines({
      currentDesktopId: "desktop-a",
      lanPeers: [],
      cloudMachines: [cloudMachine()],
    })).toEqual([{
      peerId: "peer-b",
      desktopId: "desktop-b",
      name: "Mac B",
      publicKey: "key-b",
      lanEndpoint: null,
      relayDesktopId: "desktop-b",
      trustSource: "same-account-cloud",
      preferredTransport: "cloud",
      cloudFallback: false,
    }]);
  });

  it("does not confer same-account trust when a LAN peer has a mismatched key", () => {
    expect(mergeTransferMachines({
      currentDesktopId: "desktop-a",
      lanPeers: [lanPeer({ publicKey: "different-key" })],
      cloudMachines: [cloudMachine()],
    })).toEqual([]);
  });

  it("keeps a durably paired LAN-only machine", () => {
    expect(mergeTransferMachines({
      currentDesktopId: "desktop-a",
      lanPeers: [lanPeer({ trusted: true })],
      cloudMachines: [],
    })).toEqual([expect.objectContaining({
      peerId: "peer-b",
      trustSource: "paired-lan",
      preferredTransport: "lan",
      relayDesktopId: null,
      cloudFallback: false,
    })]);
  });

  it("keeps session-scoped cloud peers out of Pair Machine", () => {
    expect(filterPairableTransferPeerPayload([
      { peer_id: "peer-lan", pid: 42 },
      { peer_id: "peer-cloud", pid: 0 },
      { peer_id: "peer-legacy" },
    ])).toEqual([
      { peer_id: "peer-lan", pid: 42 },
      { peer_id: "peer-legacy" },
    ]);
  });
});
