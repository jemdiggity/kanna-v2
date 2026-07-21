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

import { showTaskActionMenu } from "./taskActionMenu";

describe("showTaskActionMenu", () => {
  beforeEach(() => {
    nativeMocks.actionSheet.mockReset();
    nativeMocks.alert.mockReset();
    nativeMocks.platform.OS = "ios";
  });

  it("shows task actions with close marked destructive", () => {
    showTaskActionMenu(vi.fn());

    expect(nativeMocks.actionSheet).toHaveBeenCalledWith(
      {
        title: "Task Actions",
        options: ["View Diff", "Advance Stage", "Close Task", "Cancel"],
        cancelButtonIndex: 3,
        destructiveButtonIndex: 2
      },
      expect.any(Function)
    );
  });

  it.each([
    [0, "view-diff"],
    [1, "advance-stage"],
    [2, "close-task"]
  ] as const)("maps iOS index %s to %s", (index, action) => {
    const onSelect = vi.fn();
    showTaskActionMenu(onSelect);
    const callback = nativeMocks.actionSheet.mock.calls[0]![1] as (
      buttonIndex: number
    ) => void;

    callback(index);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(action);
  });

  it.each([3, 99])("ignores cancel or invalid iOS index %s", (index) => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    showTaskActionMenu(onSelect, onDismiss);
    const callback = nativeMocks.actionSheet.mock.calls[0]![1] as (
      buttonIndex: number
    ) => void;

    callback(index);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows equivalent task actions off iOS", () => {
    nativeMocks.platform.OS = "android";
    const onSelect = vi.fn();

    showTaskActionMenu(onSelect);

    expect(nativeMocks.alert).toHaveBeenCalledWith(
      "Task Actions",
      undefined,
      [
        expect.objectContaining({ text: "View Diff" }),
        expect.objectContaining({ text: "Advance Stage" }),
        expect.objectContaining({ text: "Close Task", style: "destructive" }),
        expect.objectContaining({ text: "Cancel", style: "cancel" })
      ],
      expect.objectContaining({ cancelable: true })
    );

    const actions = nativeMocks.alert.mock.calls[0]![2]!;
    actions[0]!.onPress?.();
    actions[1]!.onPress?.();
    actions[2]!.onPress?.();
    expect(onSelect.mock.calls).toEqual([
      ["view-diff"],
      ["advance-stage"],
      ["close-task"]
    ]);
  });

  it("routes Android cancellation through the dismiss callback", () => {
    nativeMocks.platform.OS = "android";
    const onDismiss = vi.fn();

    showTaskActionMenu(vi.fn(), onDismiss);

    const actions = nativeMocks.alert.mock.calls[0]![2]!;
    actions[3]!.onPress?.();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
