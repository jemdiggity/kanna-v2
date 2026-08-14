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
      failureCount: 2,
      responses: [
        { success: true },
        {
          success: false,
          error: {
            code: "messaging/registration-token-not-registered",
            message: "Requested entity was not found."
          }
        },
        {
          success: false,
          error: {
            code: "messaging/mismatched-credential",
            message: "Permission 'cloudmessaging.messages.create' denied on resource projects/kanna-staging; diagnostic-id=do-not-expose"
          }
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
        },
        {
          data: () => ({ token: "fcm-current-with-missing-iam" }),
          ref: { delete: vi.fn(async () => ({ writeTime: null })) }
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
      failedCount: 2,
      failureReasons: [
        {
          providerCode: "messaging/mismatched-credential",
          category: "relayPermission",
          count: 1,
          message: "The relay service account cannot send Firebase Cloud Messaging messages in this environment. Grant roles/firebasecloudmessaging.admin to the relay VM service account."
        },
        {
          providerCode: "messaging/registration-token-not-registered",
          category: "invalidToken",
          count: 1,
          message: "The registered push token is invalid or expired and was removed. Reopen the matching mobile app environment to register a current token."
        }
      ]
    });

    expect(limit).toHaveBeenCalledWith(500);
    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: ["fcm-current", "fcm-stale", "fcm-current-with-missing-iam"],
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

  it.each([
    ["messaging/mismatched-credential", "Sender ID mismatch.", "firebaseProjectMismatch"],
    ["messaging/third-party-auth-error", "APNs rejected the credential.", "apnsCredentials"],
    ["messaging/invalid-argument", "Invalid payload.", "payload"],
    ["messaging/quota-exceeded", "Quota exhausted.", "rateLimit"],
    ["messaging/server-unavailable", "Backend unavailable.", "temporary"],
    ["messaging/new-provider-code", "Provider diagnostic with token-like text.", "provider"]
  ])("classifies %s without exposing the raw provider message", async (
    code,
    message,
    category
  ) => {
    const { diagnoseMessagingFailure } = await import("./mobileNotifications.js");
    const reason = diagnoseMessagingFailure({ code, message });
    expect(reason).toMatchObject({ providerCode: code, category, count: 1 });
    expect(reason.message).not.toContain(message);
  });
});
