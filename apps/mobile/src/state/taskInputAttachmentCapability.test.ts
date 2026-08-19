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
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }

  return {
    supported: store.getState().desktopSupportsTaskInputAttachments,
    invokeDesktop
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
