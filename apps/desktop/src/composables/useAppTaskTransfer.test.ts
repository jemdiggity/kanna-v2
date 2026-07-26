import { computed, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TransferMachine } from "../services/desktopTransferMachines";
import type { WorkspaceTask } from "../workspace/types";
import { invoke } from "../invoke";
import { useAppTaskTransfer } from "./useAppTaskTransfer";

vi.mock("../invoke", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function cloudMachine(overrides: Partial<TransferMachine> = {}): TransferMachine {
  return {
    peerId: "peer-cloud",
    desktopId: "desktop-cloud",
    name: "Cloud Mac",
    publicKey: "cloud-key",
    lanEndpoint: null,
    relayDesktopId: "desktop-cloud",
    trustSource: "same-account-cloud",
    preferredTransport: "cloud",
    cloudFallback: false,
    ...overrides,
  };
}

function remoteTask(): WorkspaceTask {
  return {
    id: "cloud:task-source",
    logicalTaskKey: "task-source",
    localTaskId: null,
    remoteTaskIds: ["cloud:task-source"],
    repoKey: "cloud:repo",
    item: { id: "cloud:task-source" } as never,
    owner: { kind: "remote", id: "desktop-source" },
    sources: [],
    reachability: "reachable",
    capabilities: {
      canPullFromMachine: true,
    } as never,
    terminal: {
      kind: "cloud",
      remoteRef: {
        ownerDesktopId: "desktop-source",
        ownerLocalTaskId: "task-source",
        transferPeerId: "peer-source",
        preferredTransferTransport: "cloud",
      },
    },
  };
}

function createController(machines: TransferMachine[] = []) {
  const store = {
    pushTaskToPeer: vi.fn(async () => {}),
    approveIncomingTransfer: vi.fn(async () => ""),
  };
  const toast = {
    error: vi.fn(),
    info: vi.fn(),
  };
  const controller = useAppTaskTransfer({
    db: {} as never,
    store: store as never,
    toast: toast as never,
    showPeerPicker: ref(false),
    transferMachines: computed(() => machines),
  });
  return { controller, store, toast };
}

describe("useAppTaskTransfer", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  it("offers same-account cloud machines without requiring LAN pairing", async () => {
    const { controller } = createController([cloudMachine()]);

    controller.openPeerPicker("task-local");
    await vi.waitFor(() => expect(controller.transferPeersLoading.value).toBe(false));

    expect(controller.transferPeers.value).toEqual([{
      id: "peer-cloud",
      name: "Cloud Mac",
      subtitle: "Cloud",
      trusted: true,
      acceptingTransfers: true,
    }]);
  });

  it("keeps Pair Machine limited to untrusted LAN peers", async () => {
    invokeMock.mockResolvedValue([{
      peer_id: "peer-lan",
      name: "Nearby Mac",
      endpoint: "127.0.0.1:43100",
      public_key: "lan-key",
      trusted: false,
      accepting_transfers: true,
    }]);
    const { controller } = createController([cloudMachine()]);

    controller.openPairPeerPicker();
    await vi.waitFor(() => expect(controller.transferPeersLoading.value).toBe(false));

    expect(controller.transferPeers.value).toEqual([{
      id: "peer-lan",
      name: "Nearby Mac",
      subtitle: "not paired",
      trusted: false,
      acceptingTransfers: true,
    }]);
  });

  it("passes route and desktop identity to one push while ignoring duplicate clicks", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const machine = cloudMachine({
      preferredTransport: "lan",
      cloudFallback: true,
      lanEndpoint: "127.0.0.1:43100",
    });
    const { controller, store } = createController([machine]);
    store.pushTaskToPeer.mockImplementation(() => pending);

    controller.openPeerPicker("task-local");
    await vi.waitFor(() => expect(controller.transferPeersLoading.value).toBe(false));
    expect(controller.transferPeers.value[0]?.subtitle).toBe("Nearby · Cloud");
    const first = controller.handlePeerSelected("peer-cloud");
    const duplicate = controller.handlePeerSelected("peer-cloud");

    expect(store.pushTaskToPeer).toHaveBeenCalledTimes(1);
    expect(store.pushTaskToPeer).toHaveBeenCalledWith("task-local", "peer-cloud", {
      transport: "lan",
      cloudFallback: true,
      targetDesktopId: "desktop-cloud",
    });
    release();
    await Promise.all([first, duplicate]);
  });

  it("requests one pull from the exact remote owner route while pending", async () => {
    let release!: () => void;
    const pending = new Promise<unknown>((resolve) => { release = () => resolve({ requestId: "pull-1" }); });
    invokeMock.mockImplementation((command) =>
      command === "request_task_pull" ? pending : Promise.resolve([]));
    const { controller } = createController();
    const task = remoteTask();

    const first = controller.pullSelectedWorkspaceTask(task);
    const duplicate = controller.pullSelectedWorkspaceTask(task);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("request_task_pull", {
      targetPeerId: "peer-source",
      sourceTaskId: "task-source",
      transport: "cloud",
    });
    release();
    await Promise.all([first, duplicate]);
  });
});
