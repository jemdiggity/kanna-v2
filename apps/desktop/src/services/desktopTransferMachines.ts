import type { DesktopCloudTransferMachine } from "./desktopCloudTaskIndex";
import type {
  DesktopAuthSession,
} from "./desktopAuth";
import type {
  DesktopCloudTransferIdentity,
} from "./desktopServerClient";

export interface LanTransferPeer {
  id: string;
  name: string;
  publicKey: string;
  endpoint: string;
  trusted: boolean;
  acceptingTransfers: boolean;
}

export interface TransferMachine {
  peerId: string;
  desktopId: string | null;
  name: string;
  publicKey: string;
  lanEndpoint: string | null;
  relayDesktopId: string | null;
  trustSource: "paired-lan" | "same-account-cloud";
  preferredTransport: "lan" | "cloud";
  cloudFallback: boolean;
}

export interface MergeTransferMachinesInput {
  currentDesktopId: string | null;
  lanPeers: LanTransferPeer[];
  cloudMachines: DesktopCloudTransferMachine[];
}

export interface ExternalTransferPeerInput {
  peerId: string;
  displayName: string;
  endpoint: string;
  publicKey: string;
  protocolVersion: number;
  acceptingTransfers: boolean;
}

export interface DesktopTransferMachineSyncDeps {
  getTransferIdentity(): Promise<DesktopCloudTransferIdentity>;
  putLocalIdentity(identity: DesktopCloudTransferIdentity): Promise<void>;
  resolveRelayUrl(): Promise<string | null>;
  ensureProxy(input: {
    peerId: string;
    desktopId: string;
    relayUrl: string;
    idToken: string;
  }): Promise<{ endpoint: string }>;
  removeProxy(input: { peerId: string }): Promise<void>;
  clearProxies(): Promise<void>;
  upsertExternalPeer(input: { peer: ExternalTransferPeerInput }): Promise<unknown>;
  removeExternalPeer(input: { peerId: string }): Promise<unknown>;
  clearExternalPeers(): Promise<unknown>;
}

export interface DesktopTransferMachineSync {
  getTransferMachines(): TransferMachine[];
  markSidecarReady(): Promise<void>;
  setCloudMachines(machines: DesktopCloudTransferMachine[]): Promise<void>;
  setLanPeers(peers: LanTransferPeer[]): void;
  setSignedInSession(
    session: DesktopAuthSession,
    currentDesktopId: string | null,
  ): Promise<void>;
  signOut(): Promise<void>;
  dispose(): Promise<void>;
}

export function createDesktopTransferMachineSync(
  deps: DesktopTransferMachineSyncDeps,
): DesktopTransferMachineSync {
  let generation = 0;
  let sidecarReady = false;
  let authSession: DesktopAuthSession | null = null;
  let currentDesktopId: string | null = null;
  let cloudMachines: DesktopCloudTransferMachine[] = [];
  let lanPeers: LanTransferPeer[] = [];
  let localIdentity: DesktopCloudTransferIdentity | null = null;
  let localIdentitySession = -1;
  let publishedIdentitySession = -1;
  let authSessionGeneration = 0;
  let activeCloudPeerIds = new Set<string>();
  let reconciliationTail = Promise.resolve();

  const isCurrent = (captured: number, capturedSession: number) =>
    captured === generation
    && capturedSession === authSessionGeneration
    && sidecarReady
    && authSession !== null;

  const reconcile = async (captured: number): Promise<void> => {
    const session = authSession;
    const capturedSession = authSessionGeneration;
    if (!sidecarReady || !session || captured !== generation) return;

    if (!localIdentity || localIdentitySession !== capturedSession) {
      const resolvedIdentity = await deps.getTransferIdentity();
      if (
        authSessionGeneration !== capturedSession
        || authSession !== session
      ) {
        return;
      }
      localIdentity = resolvedIdentity;
      localIdentitySession = capturedSession;
    }
    if (publishedIdentitySession !== capturedSession) {
      await deps.putLocalIdentity(localIdentity);
      if (
        authSessionGeneration !== capturedSession
        || authSession !== session
      ) {
        return;
      }
      publishedIdentitySession = capturedSession;
    }
    if (!isCurrent(captured, capturedSession)) return;

    const eligible = mergeTransferMachines({
      currentDesktopId,
      lanPeers: [],
      cloudMachines,
    });
    const desiredCloudPeerIds = new Set(eligible.map((machine) => machine.peerId));

    for (const peerId of activeCloudPeerIds) {
      if (desiredCloudPeerIds.has(peerId)) continue;
      await Promise.all([
        deps.removeExternalPeer({ peerId }),
        deps.removeProxy({ peerId }),
      ]);
      activeCloudPeerIds.delete(peerId);
      if (!isCurrent(captured, capturedSession)) return;
    }

    const relayUrl = await deps.resolveRelayUrl();
    if (!isCurrent(captured, capturedSession) || !relayUrl) return;

    for (const machine of eligible) {
      const idToken = await session.getIdToken();
      if (!isCurrent(captured, capturedSession) || !idToken) return;
      const proxy = await deps.ensureProxy({
        peerId: machine.peerId,
        desktopId: machine.relayDesktopId!,
        relayUrl,
        idToken,
      });
      activeCloudPeerIds.add(machine.peerId);
      if (!isCurrent(captured, capturedSession)) {
        await deps.removeProxy({ peerId: machine.peerId }).catch(() => undefined);
        activeCloudPeerIds.delete(machine.peerId);
        return;
      }
      await deps.upsertExternalPeer({
        peer: {
          peerId: machine.peerId,
          displayName: machine.name,
          endpoint: proxy.endpoint,
          publicKey: machine.publicKey,
          protocolVersion: 1,
          acceptingTransfers: true,
        },
      });
      if (!isCurrent(captured, capturedSession)) {
        await Promise.all([
          deps.removeExternalPeer({ peerId: machine.peerId }).catch(() => undefined),
          deps.removeProxy({ peerId: machine.peerId }).catch(() => undefined),
        ]);
        activeCloudPeerIds.delete(machine.peerId);
        return;
      }
    }
  };

  const enqueueReconciliation = (captured: number): Promise<void> => {
    const result = reconciliationTail.then(() => reconcile(captured));
    reconciliationTail = result.catch(() => undefined);
    return result;
  };

  const enqueueClear = (): Promise<void> => {
    const result = reconciliationTail.then(async () => {
      await Promise.all([
        deps.clearExternalPeers(),
        deps.clearProxies(),
      ]);
      activeCloudPeerIds = new Set();
    });
    reconciliationTail = result.catch(() => undefined);
    return result;
  };

  return {
    getTransferMachines() {
      return mergeTransferMachines({ currentDesktopId, lanPeers, cloudMachines });
    },
    async markSidecarReady() {
      sidecarReady = true;
      const captured = ++generation;
      await enqueueReconciliation(captured);
    },
    async setCloudMachines(machines) {
      cloudMachines = machines ?? [];
      const captured = ++generation;
      await enqueueReconciliation(captured);
    },
    setLanPeers(peers) {
      lanPeers = peers;
    },
    setSignedInSession(session, desktopId) {
      authSession = session;
      currentDesktopId = desktopId;
      localIdentity = null;
      localIdentitySession = -1;
      publishedIdentitySession = -1;
      authSessionGeneration += 1;
      const captured = ++generation;
      const result = enqueueReconciliation(captured);
      void result.catch(() => undefined);
      return result;
    },
    async signOut() {
      generation += 1;
      authSessionGeneration += 1;
      authSession = null;
      currentDesktopId = null;
      cloudMachines = [];
      localIdentity = null;
      localIdentitySession = -1;
      publishedIdentitySession = -1;
      await enqueueClear();
    },
    async dispose() {
      sidecarReady = false;
      generation += 1;
      authSessionGeneration += 1;
      authSession = null;
      currentDesktopId = null;
      cloudMachines = [];
      localIdentity = null;
      localIdentitySession = -1;
      publishedIdentitySession = -1;
      await enqueueClear();
    },
  };
}

export function mergeTransferMachines({
  currentDesktopId,
  lanPeers,
  cloudMachines,
}: MergeTransferMachinesInput): TransferMachine[] {
  const eligibleCloud = new Map(
    cloudMachines
      .filter((machine) =>
        machine.desktopId !== currentDesktopId
        && machine.online
        && machine.protocolVersion === 1
        && machine.acceptingTransfers)
      .map((machine) => [machine.peerId, machine]),
  );
  const lanByPeer = new Map(
    lanPeers
      .filter((peer) => peer.acceptingTransfers)
      .map((peer) => [peer.id, peer]),
  );
  const machines: TransferMachine[] = [];

  for (const [peerId, cloud] of eligibleCloud) {
    const lan = lanByPeer.get(peerId);
    if (lan && lan.publicKey !== cloud.publicKey) {
      lanByPeer.delete(peerId);
      continue;
    }
    if (lan) lanByPeer.delete(peerId);
    machines.push({
      peerId,
      desktopId: cloud.desktopId,
      name: cloud.displayName,
      publicKey: cloud.publicKey,
      lanEndpoint: lan?.endpoint ?? null,
      relayDesktopId: cloud.desktopId,
      trustSource: "same-account-cloud",
      preferredTransport: lan ? "lan" : "cloud",
      cloudFallback: Boolean(lan),
    });
  }

  for (const peer of lanByPeer.values()) {
    if (!peer.trusted) continue;
    machines.push({
      peerId: peer.id,
      desktopId: null,
      name: peer.name,
      publicKey: peer.publicKey,
      lanEndpoint: peer.endpoint,
      relayDesktopId: null,
      trustSource: "paired-lan",
      preferredTransport: "lan",
      cloudFallback: false,
    });
  }

  return machines.sort((left, right) =>
    left.name.localeCompare(right.name) || left.peerId.localeCompare(right.peerId));
}

export function parseLanTransferPeers(value: unknown): LanTransferPeer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const peer = entry as Record<string, unknown>;
    const id = readString(peer.peer_id ?? peer.peerId ?? peer.id);
    const name = readString(peer.display_name ?? peer.displayName ?? peer.name);
    const publicKey = readString(peer.public_key ?? peer.publicKey);
    const endpoint = readString(peer.endpoint);
    const trusted = peer.trusted;
    const acceptingTransfers = peer.accepting_transfers ?? peer.acceptingTransfers;
    const pid = peer.pid;
    if (
      !id
      || !name
      || !publicKey
      || !endpoint
      || pid === 0
      || typeof trusted !== "boolean"
      || typeof acceptingTransfers !== "boolean"
    ) {
      return [];
    }
    return [{ id, name, publicKey, endpoint, trusted, acceptingTransfers }];
  });
}

export function filterPairableTransferPeerPayload(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((entry) =>
    !entry
    || typeof entry !== "object"
    || (entry as Record<string, unknown>).pid !== 0);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveCloudTransferRelayUrl(
  readEnv: (name: string) => Promise<string>,
  dev: boolean,
): Promise<string | null> {
  const [configured, port, cloudEnv] = await Promise.all([
    readEnv("KANNA_RELAY_URL"),
    readEnv("KANNA_RELAY_PORT"),
    readEnv("KANNA_CLOUD_ENV"),
  ]);
  if (configured.trim()) return configured.trim();
  if (port.trim()) return `ws://127.0.0.1:${port.trim()}`;
  if (cloudEnv.trim().toLowerCase() === "staging") {
    return "wss://relay-staging.kanna.build";
  }
  return dev ? null : "wss://relay.kanna.build";
}
