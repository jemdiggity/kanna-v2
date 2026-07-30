import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("relay mobile notification delivery", () => {
  it("hands the minimal versioned payload to FCM and removes stale tokens", async () => {
    const deleteStale = vi.fn(async () => ({ writeTime: null }));
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true },
        {
          success: false,
          error: { code: "messaging/registration-token-not-registered" }
        }
      ]
    }));
    const get = vi.fn(async () => ({
      docs: [
        {
          data: () => ({ token: "fcm-current" }),
          ref: { delete: vi.fn(async () => ({ writeTime: null })) }
        },
        {
          data: () => ({ token: "fcm-stale" }),
          ref: { delete: deleteStale }
        }
      ]
    }));
    const limit = vi.fn(() => ({ get }));
    const pushDevices = { limit };
    const userDocument = {
      collection: vi.fn((name: string) => {
        expect(name).toBe("pushDevices");
        return pushDevices;
      })
    };
    const users = {
      doc: vi.fn((userId: string) => {
        expect(userId).toBe("operator-1");
        return userDocument;
      })
    };
    const collection = vi.fn((name: string) => {
      expect(name).toBe("users");
      return users;
    });
    vi.doMock("./firebase.js", () => ({
      getFirebaseServices: () => ({
        db: { collection },
        messaging: { sendEachForMulticast }
      })
    }));
    const { sendMobileNotification } = await import("./mobileNotifications.js");

    await expect(sendMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification: {
        title: "Staging shipped",
        body: "The staging build is ready.",
        taskId: "task-1"
      }
    })).resolves.toEqual({
      acceptedCount: 1,
      failedCount: 1
    });

    expect(limit).toHaveBeenCalledWith(500);
    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ["fcm-current", "fcm-stale"],
      notification: {
        title: "Staging shipped",
        body: "The staging build is ready."
      },
      data: {
        kannaNotificationVersion: "1",
        kind: "task",
        desktopId: "desktop-1",
        taskId: "task-1"
      },
      apns: {
        payload: {
          aps: {
            sound: "default"
          }
        }
      }
    });
    expect(deleteStale).toHaveBeenCalledOnce();
  });

  it("rejects malformed payloads before they reach Firebase", async () => {
    const { parseMobileNotification } = await import("./mobileNotifications.js");
    expect(() => parseMobileNotification({
      title: "",
      body: "Needs input"
    })).toThrow("notification.title must be a non-empty string");
  });
});
