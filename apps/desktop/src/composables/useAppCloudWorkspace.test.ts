import { describe, expect, it, vi } from "vitest";

import {
  createDesktopTransferMachineSync,
  type DesktopTransferMachineSyncDeps,
} from "../services/desktopTransferMachines";
import type { DesktopCloudTransferMachine } from "../services/desktopCloudTaskIndex";
import type { DesktopAuthSession } from "../services/desktopAuth";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const machine = (
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

function session(token = "token-1"): DesktopAuthSession {
  return {
    initialize: vi.fn(),
    getState: vi.fn(() => ({ status: "signedOut" })),
    subscribe: vi.fn(() => () => undefined),
    signInWithEmailPassword: vi.fn(),
    signOut: vi.fn(),
    getIdToken: vi.fn(async () => token),
  };
}

function deps(calls: string[]): DesktopTransferMachineSyncDeps {
  return {
    getTransferIdentity: vi.fn(async () => {
      calls.push("get_transfer_identity");
      return {
        peerId: "peer-a",
        displayName: "Mac A",
        publicKey: "key-a",
        protocolVersion: 1,
        acceptingTransfers: true,
      };
    }),
    putLocalIdentity: vi.fn(async () => {
      calls.push("put_local_identity");
    }),
    resolveRelayUrl: vi.fn(async () => {
      calls.push("resolve_relay_url");
      return "wss://relay.test";
    }),
    ensureProxy: vi.fn(async ({ peerId }) => {
      calls.push(`ensure_proxy:${peerId}`);
      return { endpoint: `127.0.0.1:${peerId === "peer-b" ? "44551" : "44552"}` };
    }),
    removeProxy: vi.fn(async ({ peerId }) => {
      calls.push(`remove_proxy:${peerId}`);
    }),
    clearProxies: vi.fn(async () => {
      calls.push("clear_proxies");
    }),
    upsertExternalPeer: vi.fn(async ({ peer }) => {
      calls.push(`upsert_peer:${peer.peerId}`);
    }),
    removeExternalPeer: vi.fn(async ({ peerId }) => {
      calls.push(`remove_peer:${peerId}`);
    }),
    clearExternalPeers: vi.fn(async () => {
      calls.push("clear_external_peers");
    }),
  };
}

describe("cloud transfer machine auth lifecycle", () => {
  it("publishes local identity before registering signed-in cloud machines", async () => {
    const calls: string[] = [];
    const sync = createDesktopTransferMachineSync(deps(calls));
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");

    await sync.markSidecarReady();

    expect(calls).toEqual([
      "get_transfer_identity",
      "put_local_identity",
      "resolve_relay_url",
      "ensure_proxy:peer-b",
      "upsert_peer:peer-b",
    ]);
  });

  it("clears session-scoped peers and proxies on sign-out", async () => {
    const calls: string[] = [];
    const sync = createDesktopTransferMachineSync(deps(calls));
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");
    await sync.markSidecarReady();
    calls.length = 0;

    await sync.signOut();

    expect(calls).toEqual(["clear_external_peers", "clear_proxies"]);
    expect(sync.getTransferMachines()).toEqual([]);
  });

  it("discards stale async proxy results after the cloud machine generation changes", async () => {
    const calls: string[] = [];
    let resolveOldProxy: ((value: { endpoint: string }) => void) | null = null;
    const dependencies = deps(calls);
    dependencies.ensureProxy = vi.fn(async ({ peerId }) => {
      calls.push(`ensure_proxy:${peerId}`);
      if (peerId === "peer-b") {
        return await new Promise<{ endpoint: string }>((resolve) => {
          resolveOldProxy = resolve;
        });
      }
      return { endpoint: "127.0.0.1:44552" };
    });
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");
    const initial = sync.markSidecarReady();
    await vi.waitFor(() => expect(calls).toContain("ensure_proxy:peer-b"));

    const latest = sync.setCloudMachines([
      machine({ desktopId: "desktop-c", peerId: "peer-c", displayName: "Mac C", publicKey: "key-c" }),
    ]);
    resolveOldProxy?.({ endpoint: "127.0.0.1:44551" });
    await Promise.all([initial, latest]);

    expect(calls).not.toContain("upsert_peer:peer-b");
    expect(calls).toContain("remove_proxy:peer-b");
    expect(calls).toContain("upsert_peer:peer-c");
    expect(sync.getTransferMachines()).toEqual([
      expect.objectContaining({ peerId: "peer-c", preferredTransport: "cloud" }),
    ]);
  });

  it("removes absent peers even when the relay URL becomes unavailable", async () => {
    const calls: string[] = [];
    const dependencies = deps(calls);
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");
    await sync.markSidecarReady();
    calls.length = 0;
    vi.mocked(dependencies.resolveRelayUrl).mockResolvedValue(null);

    await sync.setCloudMachines([]);

    expect(calls).toContain("remove_peer:peer-b");
    expect(calls).toContain("remove_proxy:peer-b");
  });

  it("finishes stale same-peer cleanup before a newer generation installs that peer", async () => {
    const calls: string[] = [];
    const staleUpsert = deferred<void>();
    let upsertCount = 0;
    const dependencies = deps(calls);
    dependencies.upsertExternalPeer = vi.fn(async ({ peer }) => {
      upsertCount += 1;
      calls.push(`upsert_peer:${peer.peerId}:${upsertCount}`);
      if (upsertCount === 1) await staleUpsert.promise;
    });
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");
    const first = sync.markSidecarReady();
    await vi.waitFor(() => expect(calls).toContain("upsert_peer:peer-b:1"));

    const latest = sync.setCloudMachines([
      machine({ displayName: "Mac B renamed" }),
    ]);
    staleUpsert.resolve();
    await Promise.all([first, latest]);

    const secondEnsure = calls.lastIndexOf("ensure_proxy:peer-b");
    const lastRemoval = Math.max(
      calls.lastIndexOf("remove_proxy:peer-b"),
      calls.lastIndexOf("remove_peer:peer-b"),
    );
    expect(upsertCount).toBe(2);
    expect(lastRemoval).toBeLessThan(secondEnsure);
    expect(calls.at(-1)).toBe("upsert_peer:peer-b:2");
  });

  it("serializes sign-out clearing ahead of rapid re-sign-in registration", async () => {
    const calls: string[] = [];
    const clearPeers = deferred<void>();
    const clearProxies = deferred<void>();
    const dependencies = deps(calls);
    dependencies.clearExternalPeers = vi.fn(async () => {
      calls.push("clear_external_peers");
      await clearPeers.promise;
    });
    dependencies.clearProxies = vi.fn(async () => {
      calls.push("clear_proxies");
      await clearProxies.promise;
    });
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session("token-old"), "desktop-a");
    await sync.markSidecarReady();
    calls.length = 0;

    const signedOut = sync.signOut();
    await vi.waitFor(() => expect(calls).toContain("clear_proxies"));
    const signedIn = sync.setSignedInSession(session("token-new"), "desktop-a");
    const latest = sync.setCloudMachines([machine()]);
    expect(calls).not.toContain("ensure_proxy:peer-b");

    clearPeers.resolve();
    clearProxies.resolve();
    await Promise.all([signedOut, signedIn, latest]);

    expect(calls.indexOf("clear_proxies")).toBeLessThan(calls.lastIndexOf("ensure_proxy:peer-b"));
    expect(calls.at(-1)).toBe("upsert_peer:peer-b");
  });

  it("does not register peers until identity persistence succeeds and retries a failed PUT", async () => {
    const calls: string[] = [];
    const firstPut = deferred<void>();
    let putCount = 0;
    const dependencies = deps(calls);
    dependencies.putLocalIdentity = vi.fn(async () => {
      putCount += 1;
      calls.push(`put_local_identity:${putCount}`);
      if (putCount === 1) await firstPut.promise;
    });
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");
    const first = sync.markSidecarReady();
    await vi.waitFor(() => expect(calls).toContain("put_local_identity:1"));

    const retry = sync.setCloudMachines([machine({ displayName: "Mac B renamed" })]);
    expect(calls).not.toContain("ensure_proxy:peer-b");
    firstPut.reject(new Error("cloud settings unavailable"));
    await expect(first).rejects.toThrow("cloud settings unavailable");
    await retry;

    expect(putCount).toBe(2);
    expect(calls.indexOf("put_local_identity:2")).toBeLessThan(
      calls.indexOf("ensure_proxy:peer-b"),
    );
  });

  it("tracks partial registration so a later absent snapshot cleans every side effect", async () => {
    const calls: string[] = [];
    const dependencies = deps(calls);
    dependencies.upsertExternalPeer = vi.fn(async ({ peer }) => {
      calls.push(`upsert_peer:${peer.peerId}`);
      if (peer.peerId === "peer-c") throw new Error("sidecar rejected peer-c");
    });
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([
      machine(),
      machine({ desktopId: "desktop-c", peerId: "peer-c", publicKey: "key-c" }),
    ]);
    sync.setSignedInSession(session(), "desktop-a");

    await expect(sync.markSidecarReady()).rejects.toThrow("sidecar rejected peer-c");
    calls.length = 0;
    await sync.setCloudMachines([]);

    expect(calls).toEqual(expect.arrayContaining([
      "remove_peer:peer-b",
      "remove_proxy:peer-b",
      "remove_peer:peer-c",
      "remove_proxy:peer-c",
    ]));
  });

  it("drains pending reconciliation before disposal clears every session route", async () => {
    const calls: string[] = [];
    const pendingUpsert = deferred<void>();
    const dependencies = deps(calls);
    dependencies.upsertExternalPeer = vi.fn(async ({ peer }) => {
      calls.push(`upsert_peer:${peer.peerId}`);
      await pendingUpsert.promise;
    });
    const sync = createDesktopTransferMachineSync(dependencies);
    sync.setCloudMachines([machine()]);
    sync.setSignedInSession(session(), "desktop-a");
    const reconciliation = sync.markSidecarReady();
    await vi.waitFor(() => expect(calls).toContain("upsert_peer:peer-b"));

    const disposal = sync.dispose();
    expect(calls).not.toContain("clear_external_peers");
    pendingUpsert.resolve();
    await Promise.all([reconciliation, disposal]);

    const lastRegistration = calls.lastIndexOf("upsert_peer:peer-b");
    expect(calls.indexOf("clear_external_peers")).toBeGreaterThan(lastRegistration);
    expect(calls.indexOf("clear_proxies")).toBeGreaterThan(lastRegistration);
    expect(calls.slice(calls.indexOf("clear_proxies") + 1)).not.toEqual(
      expect.arrayContaining(["ensure_proxy:peer-b", "upsert_peer:peer-b"]),
    );
  });
});
