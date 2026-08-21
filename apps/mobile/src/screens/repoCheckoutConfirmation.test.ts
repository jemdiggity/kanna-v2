import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmRepoCheckout } from "./repoCheckoutConfirmation";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() }
}));

describe("confirmRepoCheckout", () => {
  beforeEach(() => {
    vi.mocked(Alert.alert).mockClear();
  });

  it("names the repository and machine and does nothing until confirmed", () => {
    const onConfirm = vi.fn();
    confirmRepoCheckout(
      {
        action: "create-task",
        status: "offered",
        repoId: "git:hash-kanji",
        repoName: "kanji-kongbu",
        desktopId: "desktop-studio",
        desktopName: "Mac Studio"
      },
      onConfirm
    );

    expect(Alert.alert).toHaveBeenCalledWith(
      "Check out kanji-kongbu on Mac Studio?",
      expect.stringContaining("credentials configured on that machine"),
      expect.any(Array)
    );
    expect(onConfirm).not.toHaveBeenCalled();

    const buttons = vi.mocked(Alert.alert).mock.calls[0]?.[2];
    buttons?.find((button) => button.text === "Check Out")?.onPress?.();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
