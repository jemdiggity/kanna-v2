import { describe, expect, it, vi } from "vitest";
import type { MobileNotificationFrame } from "@kanna/stream-client";
import { startLanMobileNotifications } from "./lanNotifications";

vi.mock("react-native", () => ({
  AppState: { currentState: "active" }
}));

const notification: MobileNotificationFrame = {
  desktopId: "desktop-lan",
  title: "Agent needs attention",
  body: "Review the task",
  taskId: "task-1"
};

describe("LAN mobile notifications", () => {
  it("surfaces and buzzes in the foreground without scheduling a second notification", async () => {
    let receive: ((value: MobileNotificationFrame) => void) | null = null;
    const close = vi.fn();
    const onForeground = vi.fn();
    const buzz = vi.fn(async () => undefined);
    const schedule = vi.fn(async () => undefined);
    const stop = await startLanMobileNotifications({
      source: {
        observeMobileNotifications(listener) {
          receive = listener;
          return { close };
        }
      },
      getAppState: () => "active",
      onForeground,
      onTaskOpen: vi.fn(),
      sdk: sdk({ buzz, schedule })
    });

    if (!receive) throw new Error("notification listener was not installed");
    receive(notification);
    await Promise.resolve();

    expect(onForeground).toHaveBeenCalledWith(notification);
    expect(buzz).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
    stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it("schedules a local notification during the background grace window", async () => {
    let receive: ((value: MobileNotificationFrame) => void) | null = null;
    const schedule = vi.fn(async () => undefined);
    await startLanMobileNotifications({
      source: {
        observeMobileNotifications(listener) {
          receive = listener;
          return { close() {} };
        }
      },
      getAppState: () => "background",
      onForeground: vi.fn(),
      onTaskOpen: vi.fn(),
      sdk: sdk({ schedule })
    });

    if (!receive) throw new Error("notification listener was not installed");
    receive(notification);
    await Promise.resolve();
    expect(schedule).toHaveBeenCalledWith(notification);
  });
});

function sdk(overrides: {
  buzz?: () => Promise<void>;
  schedule?: (notification: MobileNotificationFrame) => Promise<void>;
}) {
  return {
    requestPermissions: async () => true,
    schedule: overrides.schedule ?? (async () => undefined),
    buzz: overrides.buzz ?? (async () => undefined),
    initialTaskTarget: async () => null,
    onTaskOpen: async () => () => undefined
  };
}
