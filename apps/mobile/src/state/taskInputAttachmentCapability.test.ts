// Regression coverage for the composer's attachment gate, wired the way a
// real signed-in phone is wired.
//
// The gate was first read off the connection's `/v1/status`, which looks
// correct against a stub client and is wrong in production: `remoteTransport`
// short-circuits `getStatus()` to a synthetic "Kanna Cloud" record as soon as
// cloud tasks are wired, and that record describes no desktop, carries no
// capability marker, and therefore hid the attach control for every signed-in
// phone — including on LAN, against desktops that do advertise support.
//
// So these tests deliberately assemble the real transport rather than a client
// mock: `listCloudTasks` wired (the signed-in shape), a desktop answering
// `/v1/status` over `invokeDesktop`, the real `createKannaClient`, and the real
// controller. A gate that reads the connection instead of the task's own
// desktop fails here.
import { describe, expect, it, vi } from "vitest";
import type { MobileAuthSession } from "../lib/firebase/auth";
import type { TaskSummary } from "../lib/api/types";
import { createKannaClient } from "../lib/api/client";
import {
  createRemoteTransport,
  type RemoteDesktopInvocationRequest,
  type RemoteDesktopInvoker
} from "../lib/transports/remoteTransport";
import { createMobileController } from "./mobileController";
import { createSessionStore } from "./sessionStore";

const OWNER_DESKTOP = "desktop-owner";
const CLOUD_TASK_ID = "cloud-task-1";
const OWNER_LOCAL_TASK_ID = "local-task-1";

function cloudTask() {
  return {
    id: CLOUD_TASK_ID,
    repoId: "repo-1",
    repoName: "Repo One",
    title: "Look at this",
    stage: "in progress",
    agentType: "pty",
    activity: "idle",
    ownerDesktopId: OWNER_DESKTOP,
    ownerLocalTaskId: OWNER_LOCAL_TASK_ID,
    ownerOnline: true
  };
}

/**
 * A desktop that answers `/v1/status` with or without the attachment marker.
 * Everything else the bootstrap touches answers emptily.
 */
function createDesktopInvoker(
  taskInputAttachmentVersion: number | undefined
): ReturnType<typeof vi.fn<RemoteDesktopInvoker>> {
  return vi.fn<RemoteDesktopInvoker>(
    async ({ path }: RemoteDesktopInvocationRequest) => {
      if (path === "/v1/status") {
        return {
          state: "running",
          desktopId: OWNER_DESKTOP,
          desktopName: "Studio Mac",
          version: "0.0.69",
          environment: "production",
          serverVersion: "0.0.69",
          lanHost: "0.0.0.0",
          lanPort: 48120,
          pairingCode: null,
          ...(taskInputAttachmentVersion === undefined
            ? {}
            : { taskInputAttachmentVersion })
        };
      }
      if (path === "/v1/repos") {
        return [{ id: "repo-1", name: "Repo One" }];
      }
      return null;
    }
  );
}

/** Drain the microtask queue so relayed reads and their handlers resolve. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

async function openTaskWithDesktop(
  taskInputAttachmentVersion: number | undefined
): Promise<{
  supported: boolean;
  invokeDesktop: ReturnType<typeof createDesktopInvoker>;
}> {
  const invokeDesktop = createDesktopInvoker(taskInputAttachmentVersion);
  const transport = createRemoteTransport({
    listDesktopRecords: async () => [
      {
        desktopId: OWNER_DESKTOP,
        displayName: "Studio Mac",
        online: true,
        reachableViaRelay: true,
        connectionMode: "both" as const
      }
    ],
    getSelectedDesktopId: () => OWNER_DESKTOP,
    invokeDesktop,
    // The field that turns on the synthetic-status short circuit. Every
    // signed-in phone with a relay URL wires this, which is every environment.
    listCloudTasks: async () => [cloudTask()]
  });
  const store = createSessionStore();
  const controller = createMobileController(createKannaClient(transport), store);

  await controller.bootstrap();
  controller.openTask(CLOUD_TASK_ID);
  await settle();

  return {
    supported: store.getState().desktopSupportsTaskInputAttachments,
    invokeDesktop
  };
}

function signedInAuthSession(): MobileAuthSession {
  return {
    getState: vi.fn(() => ({
      status: "signedIn" as const,
      user: { uid: "user-1", email: "u@example.com", displayName: null }
    })),
    subscribe: vi.fn(() => () => undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    signInWithEmailPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue(null),
    notifyAuthExpired: vi.fn()
  };
}

describe("composer attachment gate against a real cloud-wired transport", () => {
  it("records support from the owning desktop, not the synthetic cloud status", async () => {
    const { supported, invokeDesktop } = await openTaskWithDesktop(1);

    expect(supported).toBe(true);
    // The status that decided it came from the desktop that will receive the
    // photo. `getStatus()` on this transport never leaves the phone.
    expect(invokeDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        desktopId: OWNER_DESKTOP,
        method: "GET",
        path: "/v1/status"
      })
    );
  });

  it("records no support when that desktop predates attachments", async () => {
    const { supported } = await openTaskWithDesktop(undefined);

    expect(supported).toBe(false);
  });
});

describe("attachment gate under repeated live cloud publications", () => {
  it("answers once per task and never drops the control back to hidden", async () => {
    // `startTaskView` is re-entered by every live cloud publication. Before it
    // was memoized, each re-entry cleared the flag to false and re-asked, so
    // the attach control unmounted and remounted on every republish — and when
    // publications outran the `/v1/status` round trip the newest read was
    // always superseded and the control never came back at all.
    const invokeDesktop = createDesktopInvoker(1);
    const transport = createRemoteTransport({
      listDesktopRecords: async () => [
        {
          desktopId: OWNER_DESKTOP,
          displayName: "Studio Mac",
          online: true,
          reachableViaRelay: true,
          connectionMode: "both" as const
        }
      ],
      getSelectedDesktopId: () => OWNER_DESKTOP,
      invokeDesktop,
      listCloudTasks: async () => [cloudTask()]
    });
    const client = createKannaClient(transport);
    const supportsSpy = vi.spyOn(client, "supportsTaskInputAttachments");
    const store = createSessionStore();
    let publish:
      | ((tasks: TaskSummary[], publication?: { cloudAuthoritative: boolean }) => void)
      | null = null;
    const controller = createMobileController(
      client,
      store,
      signedInAuthSession(),
      {
        subscribeCloudTasks: vi.fn((_uid, onUpdate) => {
          publish = onUpdate;
          return vi.fn();
        })
      }
    );

    await controller.bootstrap();
    // With the live subscription wired the task list arrives by publication,
    // not by polling, so the task has to exist before it can be opened.
    publish?.([cloudTask() as unknown as TaskSummary], {
      cloudAuthoritative: true
    });
    await settle();
    controller.openTask(CLOUD_TASK_ID);
    await settle();

    expect(store.getState().desktopSupportsTaskInputAttachments).toBe(true);
    const readsAfterOpen = supportsSpy.mock.calls.length;
    expect(readsAfterOpen).toBeGreaterThan(0);

    // Every republication of the same task list re-enters the reconciler.
    const flagsSeen: boolean[] = [];
    for (let republish = 0; republish < 10; republish += 1) {
      publish?.([cloudTask() as unknown as TaskSummary], {
        cloudAuthoritative: true
      });
      await settle();
      flagsSeen.push(store.getState().desktopSupportsTaskInputAttachments);
    }

    // One answer per (task, route): the republications add no reads...
    expect(supportsSpy.mock.calls.length).toBe(readsAfterOpen);
    // ...and the control never blinks out from under the composer.
    expect(flagsSeen).toEqual(Array.from({ length: 10 }, () => true));
  });
});
