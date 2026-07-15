import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  actionSheet: vi.fn(),
  alert: vi.fn(),
  platform: { OS: "ios" }
}));

vi.mock("react-native", () => ({
  ActionSheetIOS: {
    showActionSheetWithOptions: nativeMocks.actionSheet
  },
  Alert: {
    alert: nativeMocks.alert
  },
  Platform: nativeMocks.platform
}));

import { showTaskQuickReplyMenu } from "./taskQuickReplyMenu";
import { TASK_QUICK_REPLIES } from "./taskQuickReplies";

describe("showTaskQuickReplyMenu", () => {
  beforeEach(() => {
    nativeMocks.actionSheet.mockReset();
    nativeMocks.alert.mockReset();
    nativeMocks.platform.OS = "ios";
  });

  it("shows the iOS shortcut and derived cancel index", () => {
    showTaskQuickReplyMenu(vi.fn());

    expect(nativeMocks.actionSheet).toHaveBeenCalledWith(
      {
        title: "Quick Replies",
        options: ["SGTM. Proceed.", "Cancel"],
        cancelButtonIndex: 1
      },
      expect.any(Function)
    );
  });

  it("selects only a valid iOS quick-reply index", () => {
    const onSelect = vi.fn();
    showTaskQuickReplyMenu(onSelect);
    const callback = nativeMocks.actionSheet.mock.calls[0]![1] as (
      index: number
    ) => void;

    callback(0);
    callback(1);
    callback(99);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(TASK_QUICK_REPLIES[0]);
  });

  it("shows equivalent shortcut and cancel actions off iOS", () => {
    nativeMocks.platform.OS = "android";
    const onSelect = vi.fn();

    showTaskQuickReplyMenu(onSelect);

    expect(nativeMocks.alert).toHaveBeenCalledWith(
      "Quick Replies",
      undefined,
      [
        expect.objectContaining({ text: "SGTM. Proceed." }),
        { text: "Cancel", style: "cancel" }
      ]
    );

    const shortcutAction = nativeMocks.alert.mock.calls[0]![2]![0]!;
    shortcutAction.onPress?.();
    expect(onSelect).toHaveBeenCalledWith(TASK_QUICK_REPLIES[0]);
  });
});
