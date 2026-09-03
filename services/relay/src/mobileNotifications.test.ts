import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("relay mobile notification delivery", () => {
  it("hands the minimal versioned payload to FCM and removes permanently rejected tokens", async () => {
    const currentRef = { id: "current" };
    const unregisteredRef = { id: "unregistered" };
    const invalidArgumentRef = { id: "invalid-argument" };
    const permissionRef = { id: "permission" };
    const storedTokens = new Map([
      [currentRef, "fcm-current"],
      [unregisteredRef, "fcm-stale"],
      [invalidArgumentRef, "fcm-disabled-apns"],
      [permissionRef, "fcm-current-with-missing-iam"]
    ]);
    const retiredRefs: { id: string }[] = [];
    const retiredRecords: Record<string, unknown>[] = [];
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 3,
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
            code: "messaging/invalid-argument",
            message: "APNs device token is disabled."
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
          ref: currentRef
        },
        {
          data: () => ({ token: "fcm-stale" }),
          ref: unregisteredRef
        },
        {
          data: () => ({ token: "fcm-disabled-apns" }),
          ref: invalidArgumentRef
        },
        {
          data: () => ({ token: "fcm-current-with-missing-iam" }),
          ref: permissionRef
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
    const transaction = {
      get: vi.fn(async (ref: { id: string }) => ({
        data: () => {
          const token = storedTokens.get(ref);
          return token ? { token } : undefined;
        }
      })),
      set: vi.fn((ref: { id: string }, record: Record<string, unknown>) => {
        retiredRefs.push(ref);
        retiredRecords.push(record);
        storedTokens.delete(ref);
      })
    };
    const runTransaction = vi.fn(async (
      callback: (value: typeof transaction) => Promise<boolean>
    ) => callback(transaction));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.doMock("./firebase.js", () => ({
      getFirebaseServices: () => ({
        db: { collection, runTransaction },
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
      failedCount: 3,
      targetedDeviceCount: 4,
      failureReasons: [
        {
          providerCode: "messaging/invalid-argument",
          category: "invalidToken",
          count: 1,
          message: "No valid device token — the rejected token was removed. Open the matching mobile app environment to re-register."
        },
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
          message: "No valid device token — the rejected token was removed. Open the matching mobile app environment to re-register."
        }
      ]
    });

    expect(limit).toHaveBeenCalledWith(500);
    expect(sendEachForMulticast).toHaveBeenCalledWith({
      tokens: [
        "fcm-current",
        "fcm-stale",
        "fcm-disabled-apns",
        "fcm-current-with-missing-iam"
      ],
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
    expect(runTransaction).toHaveBeenCalledTimes(2);
    expect(retiredRefs).toEqual([unregisteredRef, invalidArgumentRef]);
    // Retirement keeps an attributable record instead of deleting the row, so a
    // later zero-target delivery can say which provider code retired it and
    // from which desktop's delivery. The token itself is gone.
    expect(retiredRecords).toEqual([
      {
        deviceId: null,
        token: null,
        registrationId: null,
        updatedAt: expect.any(String),
        retiredAt: expect.any(String),
        retiredReason: "tokenRejected",
        retiredProviderCode: "messaging/registration-token-not-registered",
        retiredByDesktopId: "desktop-1"
      },
      {
        deviceId: null,
        token: null,
        registrationId: null,
        updatedAt: expect.any(String),
        retiredAt: expect.any(String),
        retiredReason: "tokenRejected",
        retiredProviderCode: "messaging/invalid-argument",
        retiredByDesktopId: "desktop-1"
      }
    ]);
    expect(JSON.stringify(retiredRecords)).not.toContain("fcm-");
  });

  it("explains a zero-target delivery from the retirement records without sending", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sendEachForMulticast = vi.fn();
    let docs: { data: () => Record<string, unknown>; ref: { id: string } }[] = [];
    const get = vi.fn(async () => ({ docs }));
    vi.doMock("./firebase.js", () => ({
      getFirebaseServices: () => ({
        db: {
          collection: () => ({
            doc: () => ({ collection: () => ({ limit: () => ({ get }) }) })
          }),
          runTransaction: vi.fn()
        },
        messaging: { sendEachForMulticast }
      })
    }));
    const { sendMobileNotification } = await import("./mobileNotifications.js");
    const notification = { title: "Blocked", body: "Needs a decision." };

    await expect(sendMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification
    })).resolves.toEqual({
      acceptedCount: 0,
      failedCount: 0,
      failureReasons: [],
      targetedDeviceCount: 0,
      noDevicesReason: {
        code: "neverRegistered",
        message: expect.stringContaining("has ever registered")
      }
    });

    docs = [
      {
        ref: { id: "older" },
        data: () => ({
          deviceId: "phone-old",
          token: null,
          registrationId: null,
          updatedAt: "2026-09-01T00:00:00.000Z",
          retiredAt: "2026-09-01T00:00:00.000Z",
          retiredReason: "unregistered"
        })
      },
      {
        ref: { id: "newer" },
        data: () => ({
          deviceId: "phone-new",
          token: null,
          registrationId: null,
          updatedAt: "2026-09-03T08:11:31.000Z",
          retiredAt: "2026-09-03T08:11:31.000Z",
          retiredReason: "tokenRejected",
          retiredProviderCode: "messaging/registration-token-not-registered",
          retiredByDesktopId: "desktop-2"
        })
      }
    ];
    await expect(sendMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification
    })).resolves.toMatchObject({
      targetedDeviceCount: 0,
      noDevicesReason: {
        code: "tokenRejected",
        retiredAt: "2026-09-03T08:11:31.000Z",
        providerCode: "messaging/registration-token-not-registered",
        retiredByDesktopId: "desktop-2"
      }
    });

    docs = [docs[0]!];
    await expect(sendMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification
    })).resolves.toMatchObject({
      noDevicesReason: { code: "unregistered", retiredAt: "2026-09-01T00:00:00.000Z" }
    });

    docs = [{ ref: { id: "live" }, data: () => ({ deviceId: "phone", token: "fcm-live" }) }];
    await expect(sendMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification,
      dryRun: true
    })).resolves.toEqual({
      acceptedCount: 0,
      failedCount: 0,
      failureReasons: [],
      targetedDeviceCount: 1
    });

    expect(sendEachForMulticast).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      "[push] No mobile push device targeted for desktop desktop-1 (neverRegistered)",
      "[push] No mobile push device targeted for desktop desktop-1 (tokenRejected)",
      "[push] No mobile push device targeted for desktop desktop-1 (unregistered)"
    ]);
  });

  it("does not evict a replacement registered while Firebase rejects the old token", async () => {
    const deviceRef = { id: "phone-1" };
    let storedToken = "fcm-old";
    const get = vi.fn(async () => ({
      docs: [{
        data: () => ({ token: storedToken }),
        ref: deviceRef
      }]
    }));
    const limit = vi.fn(() => ({ get }));
    const transaction = {
      get: vi.fn(async () => ({
        data: () => ({ token: storedToken })
      })),
      set: vi.fn(() => {
        storedToken = "";
      })
    };
    const runTransaction = vi.fn(async (
      callback: (value: typeof transaction) => Promise<boolean>
    ) => callback(transaction));
    const sendEachForMulticast = vi.fn(async () => {
      storedToken = "fcm-replacement";
      return {
        successCount: 0,
        failureCount: 1,
        responses: [{
          success: false,
          error: {
            code: "messaging/registration-token-not-registered",
            message: "Requested entity was not found."
          }
        }]
      };
    });
    vi.doMock("./firebase.js", () => ({
      getFirebaseServices: () => ({
        db: {
          collection: () => ({
            doc: () => ({
              collection: () => ({ limit })
            })
          }),
          runTransaction
        },
        messaging: { sendEachForMulticast }
      })
    }));
    const { sendMobileNotification } = await import("./mobileNotifications.js");

    await expect(sendMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification: {
        title: "Staging shipped",
        body: "The staging build is ready."
      }
    })).resolves.toMatchObject({
      failedCount: 1,
      failureReasons: [{ category: "invalidToken" }]
    });

    expect(transaction.get).toHaveBeenCalledWith(deviceRef);
    expect(transaction.set).not.toHaveBeenCalled();
    expect(storedToken).toBe("fcm-replacement");
  });

  it("rejects malformed payloads before they reach Firebase", async () => {
    const { parseMobileNotification } = await import("./mobileNotifications.js");
    expect(() => parseMobileNotification({
      title: "",
      body: "Needs input"
    })).toThrow("notification.title must be a non-empty string");
  });

  it("never exposes whole-call provider exceptions in logs or acknowledgements", async () => {
    const canarySecret = "ya29.distinctive-fake-provider-token-DO-NOT-LEAK";
    const send = vi.fn(async () => {
      throw new Error(
        `Firebase request rejected: Authorization: Bearer ${canarySecret}; project=kanna-secret-project`
      );
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const acknowledgements: unknown[] = [];
    const { publishMobileNotification } = await import("./mobileNotifications.js");

    await publishMobileNotification({
      userId: "operator-1",
      desktopId: "desktop-1",
      notification: {
        title: "Staging shipped",
        body: "The staging build is ready."
      },
      sendAck: (ack) => acknowledgements.push({
        type: "mobile_notification_ack",
        id: "notify-secret-rejection",
        ...ack
      })
    }, {
      send,
      createIncidentId: () => "incident-safe-123"
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[push] Mobile notification delivery failed for desktop desktop-1 (category=relayDependency, incident=incident-safe-123)"
    );
    expect(acknowledgements).toEqual([{
      type: "mobile_notification_ack",
      id: "notify-secret-rejection",
      ok: false,
      error: "mobile notification delivery failed (category=relayDependency, incident=incident-safe-123); retry later and inspect the matching environment's relay logs"
    }]);
    const emittedOutput = JSON.stringify({
      logs: warn.mock.calls,
      responses: acknowledgements
    });
    expect(emittedOutput).not.toContain(canarySecret);
    expect(emittedOutput).not.toContain("kanna-secret-project");
  });

  it.each([
    ["messaging/mismatched-credential", "Sender ID mismatch.", "firebaseProjectMismatch"],
    ["messaging/third-party-auth-error", "APNs rejected the credential.", "apnsCredentials"],
    ["messaging/invalid-argument", "APNs device token is disabled.", "invalidToken"],
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
