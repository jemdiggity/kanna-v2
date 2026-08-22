import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../api/types";
import {
  parseNotificationTaskTarget,
  pushRegistrationUrl,
  pushUnregistrationUrl,
  resolveNotificationTaskId,
  startMobilePushNotifications
} from "./mobilePush";

describe("mobile push notifications", () => {
  it("registers the FCM token with the authenticated relay and follows refreshes", async () => {
    let refreshToken: ((token: string) => void) | null = null;
    const stopRefresh = vi.fn();
    const stopOpened = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sdk = {
      requestPermission: vi.fn(async () => 1),
      getToken: vi.fn(async () => "fcm-token-1"),
      onTokenRefresh: vi.fn((listener: (token: string) => void) => {
        refreshToken = listener;
        return stopRefresh;
      }),
      getInitialNotification: vi.fn(async () => null),
      onNotificationOpened: vi.fn(() => stopOpened)
    };

    const stop = await startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => "firebase-id-token",
      onTaskOpen: vi.fn(),
      relayUrl: "wss://relay-staging.kanna.build",
      fetchImpl,
      sdk
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://relay-staging.kanna.build/push/register",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          idToken: "firebase-id-token",
          deviceId: "mobile-device-1",
          deviceToken: "fcm-token-1"
        })
      })
    );

    refreshToken?.("fcm-token-2");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        idToken: "firebase-id-token",
        deviceId: "mobile-device-1",
        deviceToken: "fcm-token-2"
      })
    );

    stop();
    expect(stopRefresh).toHaveBeenCalledOnce();
    expect(stopOpened).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls[2]).toEqual([
      "https://relay-staging.kanna.build/push/unregister",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          idToken: "firebase-id-token",
          deviceId: "mobile-device-1",
          deviceToken: "fcm-token-2"
        })
      })
    ]);
  });

  it("re-registers the current FCM token on every app launch", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const tokens = ["fcm-before-reinstall", "fcm-after-reinstall"];

    for (const token of tokens) {
      await startMobilePushNotifications({
        deviceId: "mobile-device-1",
        getIdToken: async () => "firebase-id-token",
        onTaskOpen: vi.fn(),
        relayUrl: "wss://relay-staging.kanna.build",
        fetchImpl,
        sdk: {
          requestPermission: vi.fn(async () => 1),
          getToken: vi.fn(async () => token),
          onTokenRefresh: vi.fn(() => () => undefined),
          getInitialNotification: vi.fn(async () => null),
          onNotificationOpened: vi.fn(() => () => undefined)
        }
      });
    }

    expect(fetchImpl.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify({
        idToken: "firebase-id-token",
        deviceId: "mobile-device-1",
        deviceToken: "fcm-before-reinstall"
      }),
      JSON.stringify({
        idToken: "firebase-id-token",
        deviceId: "mobile-device-1",
        deviceToken: "fcm-after-reinstall"
      })
    ]);
  });

  it("accepts only the versioned task hint and ignores unknown payloads", () => {
    expect(parseNotificationTaskTarget({
      data: {
        kannaNotificationVersion: "1",
        kind: "task",
        desktopId: "desktop-1",
        taskId: "task-1"
      }
    })).toEqual({
      desktopId: "desktop-1",
      taskId: "task-1"
    });
    expect(parseNotificationTaskTarget({
      data: {
        kannaNotificationVersion: "2",
        kind: "task",
        desktopId: "desktop-1",
        taskId: "task-1"
      }
    })).toBeNull();
    expect(parseNotificationTaskTarget({
      data: { unexpected: "safe to ignore" }
    })).toBeNull();
  });

  it("resolves a desktop-local task hint to the cloud display identity", () => {
    const tasks = [{
      id: "cloud:desktop-1:repo-1:task-1",
      ownerDesktopId: "desktop-1",
      ownerLocalTaskId: "task-1"
    }] as TaskSummary[];

    expect(resolveNotificationTaskId({
      desktopId: "desktop-1",
      taskId: "task-1"
    }, tasks)).toBe("cloud:desktop-1:repo-1:task-1");
    expect(resolveNotificationTaskId({
      desktopId: "desktop-2",
      taskId: "task-1"
    }, tasks)).toBeNull();
  });

  it("derives registration HTTP endpoints only from supported relay URLs", () => {
    expect(pushRegistrationUrl("ws://127.0.0.1:9080"))
      .toBe("http://127.0.0.1:9080/push/register");
    expect(pushUnregistrationUrl("wss://relay-staging.kanna.build"))
      .toBe("https://relay-staging.kanna.build/push/unregister");
    expect(pushRegistrationUrl("file:///tmp/relay")).toBeNull();
  });
});
