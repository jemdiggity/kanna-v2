import { describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../api/types";
import {
  createAccountPushRegistrationCoordinator,
  createAnonymousPushBindingCoordinator,
  parseNotificationTaskTarget,
  pushRegistrationUrl,
  pushUnregistrationUrl,
  resolveNotificationTaskId,
  startMobilePushNotifications
} from "./mobilePush";

function requestBody(call: readonly unknown[] | undefined): Record<string, string> {
  const init = call?.[1] as { body?: unknown } | undefined;
  return JSON.parse(String(init?.body)) as Record<string, string>;
}

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
      expect.objectContaining({ method: "POST" })
    );
    expect(requestBody(fetchImpl.mock.calls[0])).toEqual({
      idToken: "firebase-id-token",
      deviceId: "mobile-device-1",
      deviceToken: "fcm-token-1",
      registrationId: expect.any(String)
    });

    refreshToken?.("fcm-token-2");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const refreshed = requestBody(fetchImpl.mock.calls[1]);
    expect(refreshed).toEqual({
      idToken: "firebase-id-token",
      deviceId: "mobile-device-1",
      deviceToken: "fcm-token-2",
      registrationId: expect.any(String)
    });
    expect(refreshed.registrationId).not.toBe(
      requestBody(fetchImpl.mock.calls[0]).registrationId
    );

    stop();
    expect(stopRefresh).toHaveBeenCalledOnce();
    expect(stopOpened).toHaveBeenCalledOnce();
    expect(stopResponse).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      "https://relay-staging.kanna.build/push/unregister"
    );
    // The unregister names the registration it retires, so the relay can
    // ignore it if a newer registration of this device has landed since.
    expect(requestBody(fetchImpl.mock.calls[2])).toEqual({
      idToken: "firebase-id-token",
      deviceId: "mobile-device-1",
      deviceToken: "fcm-token-2",
      registrationId: refreshed.registrationId
    });
  });

  it("keeps the newer same-token lifecycle registered when the older deferred cleanup runs", async () => {
    // The 2026-09-03 staging loss: the push effect re-ran with the same FCM
    // token while the previous run's register was still in flight. App.tsx
    // defers that run's cleanup until start resolves; its stale lease must not
    // clear the newer run's desire when both starts coalesce onto one request.
    const relayRegistrations = new Map<string, string>();
    let resolveFirstRegister: (() => void) | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (url.endsWith("/push/register")) {
        await new Promise<void>((resolve) => {
          resolveFirstRegister = resolve;
        });
        relayRegistrations.set(body.registrationId, body.deviceToken);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      relayRegistrations.delete(body.registrationId);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const coordinator = createAccountPushRegistrationCoordinator({
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const sdk = {
      setNotificationHandler: vi.fn(),
      requestPermission: vi.fn(async () => 1),
      getToken: vi.fn(async () => "fcm-same-token"),
      onTokenRefresh: vi.fn(() => () => undefined),
      getInitialNotification: vi.fn(async () => null),
      onNotificationOpened: vi.fn(() => () => undefined),
      onNotificationResponse: vi.fn(() => () => undefined)
    };
    const start = () => startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => "firebase-id-token",
      onTaskOpen: vi.fn(),
      relayUrl: "wss://relay-staging.kanna.build",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      accountRegistrationCoordinator: coordinator,
      sdk
    });
    const beginEffectRun = () => {
      let disposed = false;
      let stop = () => undefined;
      const started = start().then((cleanup) => {
        if (disposed) cleanup();
        else stop = cleanup;
      });
      return {
        dispose() {
          disposed = true;
          stop();
        },
        started
      };
    };

    const firstRun = beginEffectRun();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    firstRun.dispose();
    const secondRun = beginEffectRun();
    await vi.waitFor(() => expect(sdk.getToken).toHaveBeenCalledTimes(2));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFirstRegister?.();
    await Promise.all([firstRun.started, secondRun.started]);

    const liveRegistration = requestBody(fetchImpl.mock.calls[0]);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://relay-staging.kanna.build/push/register"
    ]);
    expect([...relayRegistrations.entries()]).toEqual([
      [liveRegistration.registrationId, "fcm-same-token"]
    ]);
    expect(coordinator.applied("wss://relay-staging.kanna.build", "mobile-device-1")).toEqual({
      deviceToken: "fcm-same-token",
      registrationId: liveRegistration.registrationId
    });

    secondRun.dispose();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(requestBody(fetchImpl.mock.calls[1]).registrationId).toBe(
      liveRegistration.registrationId
    );
    expect(relayRegistrations.size).toBe(0);
  });

  it("retries a failed re-registration instead of remembering the device as registered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const statuses = [503, 401, 200];
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: statuses.shift() ?? 200 }));
    const getIdToken = vi.fn(async (forceRefresh?: boolean) =>
      forceRefresh ? "firebase-id-token-fresh" : "firebase-id-token");
    const coordinator = createAccountPushRegistrationCoordinator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelayMs: () => 0
    });

    await startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken,
      onTaskOpen: vi.fn(),
      relayUrl: "wss://relay-staging.kanna.build",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      accountRegistrationCoordinator: coordinator,
      sdk: {
        setNotificationHandler: vi.fn(),
        requestPermission: vi.fn(async () => 1),
        getToken: vi.fn(async () => "fcm-token-1"),
        onTokenRefresh: vi.fn(() => () => undefined),
        getInitialNotification: vi.fn(async () => null),
        onNotificationOpened: vi.fn(() => () => undefined),
        onNotificationResponse: vi.fn(() => () => undefined)
      }
    });

    // The first attempt was refused, so nothing is believed registered yet.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(coordinator.applied("wss://relay-staging.kanna.build", "mobile-device-1")).toBeNull();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(coordinator.applied("wss://relay-staging.kanna.build", "mobile-device-1")).toEqual({
        deviceToken: "fcm-token-1",
        registrationId: requestBody(fetchImpl.mock.calls[2]).registrationId
      }));
    // A 401 forces a fresh id token on the next attempt.
    expect(getIdToken.mock.calls.at(-1)).toEqual([true]);
    expect(requestBody(fetchImpl.mock.calls[2]).idToken).toBe("firebase-id-token-fresh");
  });

  it("retries an unregister with a fresh id token and gives up after the configured attempts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unregisterStatuses = [500, 200];
    const fetchImpl = vi.fn(async (url: string) =>
      new Response(null, {
        status: url.endsWith("/push/unregister") ? unregisterStatuses.shift() ?? 500 : 200
      }));
    const getIdToken = vi.fn(async (forceRefresh?: boolean) =>
      forceRefresh ? "firebase-id-token-fresh" : "firebase-id-token");
    const coordinator = createAccountPushRegistrationCoordinator({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelayMs: () => 0,
      maxUnregisterAttempts: 2
    });
    const relayUrl = "wss://relay-staging.kanna.build";

    const firstRegistration = coordinator.register({
      relayUrl,
      deviceId: "mobile-device-1",
      deviceToken: "fcm-token-1",
      getIdToken
    });
    await firstRegistration.settled;
    await coordinator.unregister(firstRegistration.lease);
    await vi.waitFor(() => expect(coordinator.applied(relayUrl, "mobile-device-1")).toBeNull());
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      `https://relay-staging.kanna.build/push/register`,
      `https://relay-staging.kanna.build/push/unregister`,
      `https://relay-staging.kanna.build/push/unregister`
    ]);
    expect(requestBody(fetchImpl.mock.calls[1]).idToken).toBe("firebase-id-token");
    expect(requestBody(fetchImpl.mock.calls[2]).idToken).toBe("firebase-id-token-fresh");

    // A relay that stays down: the local record is dropped after the bound so
    // the worker does not spin, and the next registration replaces the row.
    const secondRegistration = coordinator.register({
      relayUrl,
      deviceId: "mobile-device-1",
      deviceToken: "fcm-token-2",
      getIdToken
    });
    await secondRegistration.settled;
    await coordinator.unregister(secondRegistration.lease);
    await vi.waitFor(() => expect(coordinator.applied(relayUrl, "mobile-device-1")).toBeNull());
    expect(fetchImpl.mock.calls.filter((call) => call[0].endsWith("/push/unregister"))).toHaveLength(4);
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

    expect(fetchImpl.mock.calls.map((call) => requestBody(call))).toEqual([
      {
        idToken: "firebase-id-token",
        deviceId: "mobile-device-1",
        deviceToken: "fcm-before-reinstall",
        registrationId: expect.any(String)
      },
      {
        idToken: "firebase-id-token",
        deviceId: "mobile-device-1",
        deviceToken: "fcm-after-reinstall",
        registrationId: expect.any(String)
      }
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
        setNotificationHandler: vi.fn(),
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
        onNotificationOpened: vi.fn(() => () => undefined),
        onNotificationResponse: vi.fn(() => () => undefined)
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
    coordinator.begin([pairing]);
    await coordinator.revoke(pairing);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({
        desktopPubKey: "desktop-public-key",
        deviceId: "mobile-device-1",
        cert: pairing.pushPairingCert
      })
    }));
  });

  it("keeps the anonymous binding through sign-in and sign-out transitions", async () => {
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
        signature: "desktop-signature"
      }
    };
    const sdk = {
      setNotificationHandler: vi.fn(),
      requestPermission: vi.fn(async () => 1),
      getToken: vi.fn(async () => "transition-token"),
      onTokenRefresh: vi.fn(() => () => undefined),
      getInitialNotification: vi.fn(async () => null),
      onNotificationOpened: vi.fn(() => () => undefined),
      onNotificationResponse: vi.fn(() => () => undefined)
    };
    const start = (idToken: string | null) => startMobilePushNotifications({
      deviceId: "mobile-device-1",
      getIdToken: async () => idToken,
      onTaskOpen: vi.fn(),
      relayUrl: "wss://relay-staging.kanna.build",
      anonymousPairings: [pairing],
      anonymousBindingCoordinator: coordinator,
      fetchImpl,
      sdk
    });

    const stopSignedOut = await start(null);
    expect(fetchImpl.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      ["https://relay-staging.kanna.build/push/pairings", "POST"]
    ]);
    stopSignedOut();

    const stopSignedIn = await start("firebase-id-token");
    expect(fetchImpl.mock.calls.slice(1, 3).map((call) => [call[0], call[1]?.method])).toEqual([
      ["https://relay-staging.kanna.build/push/register", "POST"],
      ["https://relay-staging.kanna.build/push/pairings", "POST"]
    ]);
    stopSignedIn();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(fetchImpl.mock.calls[3]).toEqual([
      "https://relay-staging.kanna.build/push/unregister",
      expect.objectContaining({ method: "POST" })
    ]);

    const stopSignedOutAgain = await start(null);
    expect(fetchImpl.mock.calls[4]).toEqual([
      "https://relay-staging.kanna.build/push/pairings",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("transition-token")
      })
    ]);
    stopSignedOutAgain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("revokes a pairing before FCM token initialization", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
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
    const coordinator = createAnonymousPushBindingCoordinator(fetchImpl);
    coordinator.begin([pairing]);

    await coordinator.revoke(pairing);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://relay-staging.kanna.build/push/pairings",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({
          desktopPubKey: "desktop-public-key",
          deviceId: "mobile-device-1",
          cert: pairing.pushPairingCert
        })
      })
    );
  });

  it("rejects a refused revocation so pairing trust remains retriable", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 409 }));
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
        signature: "stale-certificate"
      }
    };
    const coordinator = createAnonymousPushBindingCoordinator(fetchImpl);
    coordinator.begin([pairing]);

    await expect(coordinator.revoke(pairing))
      .rejects.toThrow("Anonymous push pairing revocation failed (409).");
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
        setNotificationHandler: vi.fn(),
        requestPermission: vi.fn(async () => 1),
        getToken,
        onTokenRefresh: vi.fn(() => () => undefined),
        getInitialNotification: vi.fn(async () => null),
        onNotificationOpened: vi.fn(() => () => undefined),
        onNotificationResponse: vi.fn(() => () => undefined)
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
