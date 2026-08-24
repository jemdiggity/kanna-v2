import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../api/types";
import {
  createAnonymousPushBindingCoordinator,
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
    const stopResponse = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const onTaskOpen = vi.fn();
    const sdk = {
      setNotificationHandler: vi.fn(),
      requestPermission: vi.fn(async () => 1),
      getToken: vi.fn(async () => "fcm-token-1"),
      onTokenRefresh: vi.fn((listener: (token: string) => void) => {
        refreshToken = listener;
        return stopRefresh;
      }),
      getInitialNotification: vi.fn(async () => null),
      onNotificationOpened: vi.fn(() => stopOpened),
      onNotificationResponse: vi.fn(() => stopResponse)
    };

    const stop = await startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => "firebase-id-token",
      onTaskOpen,
      relayUrl: "wss://relay-staging.kanna.build",
      fetchImpl,
      sdk
    });

    expect(sdk.setNotificationHandler).toHaveBeenCalledOnce();
    const handler = sdk.setNotificationHandler.mock.calls[0]?.[0];
    await expect(handler?.handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false
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
    expect(stopResponse).toHaveBeenCalledOnce();
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
          setNotificationHandler: vi.fn(),
          requestPermission: vi.fn(async () => 1),
          getToken: vi.fn(async () => token),
          onTokenRefresh: vi.fn(() => () => undefined),
          getInitialNotification: vi.fn(async () => null),
          onNotificationOpened: vi.fn(() => () => undefined),
          onNotificationResponse: vi.fn(() => () => undefined)
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

  it("registers, rotates, and revokes a signed-out phone's paired FCM token", async () => {
    let refreshToken: ((token: string) => void) | null = null;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const onTaskOpen = vi.fn();
    const pairing = {
      desktopId: "desktop-1",
      desktopPushIdentity: {
        publicKey: "desktop-public-key",
        relayUrl: "wss://relay-staging.kanna.build",
        environment: "staging"
      },
      pushPairingCert: {
        deviceId: "mobile-device-1",
        issuedAt: 1_000,
        expiresAt: 2_000,
        signature: "desktop-signature"
      }
    };
    const stop = await startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => null,
      onTaskOpen,
      relayUrl: "wss://relay-staging.kanna.build",
      anonymousPairings: [pairing],
      fetchImpl,
      sdk: {
        requestPermission: vi.fn(async () => 1),
        getToken: vi.fn(async () => "anonymous-token-1"),
        onTokenRefresh: vi.fn((listener: (token: string) => void) => {
          refreshToken = listener;
          return () => undefined;
        }),
        getInitialNotification: vi.fn(async () => ({
          data: {
            kannaNotificationVersion: "1",
            kind: "task",
            desktopId: "desktop-public-key",
            taskId: "task-1"
          }
        })),
        onNotificationOpened: vi.fn(() => () => undefined)
      }
    });

    expect(onTaskOpen).toHaveBeenCalledWith({
      desktopId: "desktop-1",
      taskId: "task-1"
    });

    expect(fetchImpl.mock.calls[0]).toEqual([
      "https://relay-staging.kanna.build/push/pairings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          desktopPubKey: "desktop-public-key",
          deviceId: "mobile-device-1",
          fcmToken: "anonymous-token-1",
          cert: pairing.pushPairingCert
        })
      })
    ]);
    refreshToken?.("anonymous-token-2");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("anonymous-token-2")
    }));

    stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const coordinator = createAnonymousPushBindingCoordinator(fetchImpl);
    const generation = coordinator.begin([pairing]);
    coordinator.rememberToken(generation, "anonymous-token-2");
    await coordinator.revoke(pairing);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: "DELETE",
      body: expect.stringContaining("anonymous-token-2")
    }));
  });

  it("serializes removal before certificate replacement so stale cleanup cannot win", async () => {
    let resolveDelete: (() => void) | null = null;
    const bindings = new Map<string, string>();
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        desktopPubKey: string;
        deviceId: string;
        cert: { signature: string };
      };
      const key = `${body.desktopPubKey}:${body.deviceId}`;
      requests.push(`${init.method}:${body.cert.signature}`);
      if (init.method === "DELETE") {
        await new Promise<void>((resolve) => {
          resolveDelete = resolve;
        });
        bindings.delete(key);
      } else {
        bindings.set(key, body.cert.signature);
      }
      return new Response(null, { status: 200 });
    });
    const oldPairing = {
      desktopId: "desktop-1",
      desktopPushIdentity: {
        publicKey: "desktop-public-key",
        relayUrl: "wss://relay-staging.kanna.build",
        environment: "staging"
      },
      pushPairingCert: {
        deviceId: "mobile-device-1",
        issuedAt: 1_000,
        expiresAt: 2_000,
        signature: "old-certificate"
      }
    };
    const replacement = {
      ...oldPairing,
      pushPairingCert: {
        ...oldPairing.pushPairingCert,
        expiresAt: 3_000,
        signature: "new-certificate"
      }
    };
    const coordinator = createAnonymousPushBindingCoordinator(fetchImpl);
    const firstGeneration = coordinator.begin([oldPairing]);
    await coordinator.register(firstGeneration, "fcm-current");

    const removal = coordinator.revoke(oldPairing);
    await vi.waitFor(() => expect(resolveDelete).not.toBeNull());
    const replacementGeneration = coordinator.begin([replacement]);
    const refresh = coordinator.register(replacementGeneration, "fcm-current");
    resolveDelete?.();
    await Promise.all([removal, refresh]);

    expect(requests).toEqual([
      "POST:old-certificate",
      "DELETE:old-certificate",
      "POST:new-certificate"
    ]);
    expect(bindings.get("desktop-public-key:mobile-device-1"))
      .toBe("new-certificate");
  });

  it("ignores an obsolete effect registration and never revokes on effect cleanup", async () => {
    let resolveOldToken: ((token: string) => void) | null = null;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const coordinator = createAnonymousPushBindingCoordinator(fetchImpl);
    const pairing = {
      desktopId: "desktop-1",
      desktopPushIdentity: {
        publicKey: "desktop-public-key",
        relayUrl: "wss://relay-staging.kanna.build",
        environment: "staging"
      },
      pushPairingCert: {
        deviceId: "mobile-device-1",
        issuedAt: 1_000,
        expiresAt: 2_000,
        signature: "current-certificate"
      }
    };
    const start = (getToken: () => Promise<string>) => startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => null,
      onTaskOpen: vi.fn(),
      relayUrl: "wss://relay-staging.kanna.build",
      anonymousPairings: [pairing],
      anonymousBindingCoordinator: coordinator,
      fetchImpl,
      sdk: {
        requestPermission: vi.fn(async () => 1),
        getToken,
        onTokenRefresh: vi.fn(() => () => undefined),
        getInitialNotification: vi.fn(async () => null),
        onNotificationOpened: vi.fn(() => () => undefined)
      }
    });
    const obsolete = start(() => new Promise((resolve) => {
      resolveOldToken = resolve;
    }));
    await vi.waitFor(() => expect(resolveOldToken).not.toBeNull());
    const currentStop = await start(async () => "current-token");
    resolveOldToken?.("obsolete-token");
    const obsoleteStop = await obsolete;
    obsoleteStop();
    currentStop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: "POST",
      body: expect.stringContaining("current-token")
    }));
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

  it("opens task targets from launch, background, and foreground notification taps", async () => {
    let onOpened: ((message: { data?: Record<string, unknown> }) => void) | null = null;
    let onResponse: ((message: { data?: Record<string, unknown> }) => void) | null = null;
    const onTaskOpen = vi.fn();
    const initialTarget = {
      kannaNotificationVersion: "1",
      kind: "task",
      desktopId: "desktop-initial",
      taskId: "task-initial"
    };
    await startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => "firebase-id-token",
      onTaskOpen,
      relayUrl: "wss://relay-staging.kanna.build",
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })),
      sdk: {
        setNotificationHandler: vi.fn(),
        requestPermission: vi.fn(async () => 1),
        getToken: vi.fn(async () => "fcm-token"),
        onTokenRefresh: vi.fn(() => () => undefined),
        getInitialNotification: vi.fn(async () => ({ data: initialTarget })),
        onNotificationOpened: vi.fn((listener) => {
          onOpened = listener;
          return () => undefined;
        }),
        onNotificationResponse: vi.fn((listener) => {
          onResponse = listener;
          return () => undefined;
        })
      }
    });

    expect(onTaskOpen).toHaveBeenCalledWith({
      desktopId: "desktop-initial",
      taskId: "task-initial"
    });
    onOpened?.({
      data: {
        kannaNotificationVersion: "1",
        kind: "task",
        desktopId: "desktop-running",
        taskId: "task-running"
      }
    });
    expect(onTaskOpen).toHaveBeenLastCalledWith({
      desktopId: "desktop-running",
      taskId: "task-running"
    });
    onResponse?.({
      data: {
        kannaNotificationVersion: "1",
        kind: "task",
        desktopId: "desktop-foreground",
        taskId: "task-foreground"
      }
    });
    expect(onTaskOpen).toHaveBeenLastCalledWith({
      desktopId: "desktop-foreground",
      taskId: "task-foreground"
    });
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
