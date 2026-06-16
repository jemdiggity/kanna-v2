import { describe, expect, it, vi } from "vitest";
import {
  assertProfileConnectionControlsReachable,
  assertProfileConnectionDisconnected,
  assertProfilePasswordCanRevealAndHide,
  openProfileConnectionSheet
} from "./profile-connection.e2e";

interface FakeElement {
  click: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
  isExisting: ReturnType<typeof vi.fn>;
  waitForDisplayed: ReturnType<typeof vi.fn>;
}

interface FakeWaitUntilOptions {
  timeoutMsg: string;
}

function createElement(exists = true): FakeElement {
  return {
    click: vi.fn(async () => undefined),
    getAttribute: vi.fn(async () => null),
    getText: vi.fn(async () => ""),
    isExisting: vi.fn(async () => exists),
    waitForDisplayed: vi.fn(async () => undefined)
  };
}

function createReachableControlsUi(
  overrides: Partial<{
    getConnectionTitle: ReturnType<typeof vi.fn>;
    getConnectionStatus: ReturnType<typeof vi.fn>;
    getConnectLocalButton: ReturnType<typeof vi.fn>;
    getEmailInput: ReturnType<typeof vi.fn>;
    getPasswordInput: ReturnType<typeof vi.fn>;
    getPasswordToggle: ReturnType<typeof vi.fn>;
    getSignInButton: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    getConnectionTitle: vi.fn(async () => createElement()),
    getConnectionStatus: vi.fn(async () => createElement()),
    getConnectLocalButton: vi.fn(async () => createElement()),
    getEmailInput: vi.fn(async () => createElement()),
    getPasswordInput: vi.fn(async () => createElement()),
    getPasswordToggle: vi.fn(async () => createElement()),
    getSignInButton: vi.fn(async () => createElement()),
    waitUntil: vi.fn(
      async (condition: () => Promise<boolean>, options: FakeWaitUntilOptions) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      }
    ),
    ...overrides
  };
}

describe("openProfileConnectionSheet", () => {
  it("opens the account sheet from the app top bar", async () => {
    const accountButton = createElement();
    const accountSheet = createElement();
    const ui = {
      getAccountButton: vi.fn(async () => accountButton),
      getAccountSheet: vi.fn(async () => accountSheet)
    };

    await openProfileConnectionSheet(ui);

    expect(accountButton.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(accountButton.click).toHaveBeenCalledTimes(1);
    expect(accountSheet.waitForDisplayed).toHaveBeenCalledWith({ timeout: 30_000 });
  });
});

describe("assertProfileConnectionControlsReachable", () => {
  it("waits for connection status, local connect, and email sign-in controls", async () => {
    const ui = createReachableControlsUi();

    await assertProfileConnectionControlsReachable(ui);

    expect(ui.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg:
          "Expected profile drawer connection controls and sign-in form to be reachable"
      })
    );
    expect(ui.getPasswordToggle).toHaveBeenCalled();
  });
});

describe("assertProfilePasswordCanRevealAndHide", () => {
  it("clicks the profile password toggle through native accessibility label states", async () => {
    let toggleLabel = "Show password";
    const passwordToggle = {
      ...createElement(),
      click: vi.fn(async () => {
        toggleLabel = toggleLabel === "Show password" ? "Hide password" : "Show password";
      }),
      getAttribute: vi.fn(async (attributeName: string) =>
        attributeName === "label" ? toggleLabel : null
      ),
      getText: vi.fn(async () => toggleLabel)
    };
    const ui = createReachableControlsUi({
      getPasswordToggle: vi.fn(async () => passwordToggle)
    });

    await assertProfilePasswordCanRevealAndHide(ui);

    expect(passwordToggle.click).toHaveBeenCalledTimes(2);
    expect(passwordToggle.getAttribute).toHaveBeenCalledWith("label");
    expect(passwordToggle.getText).not.toHaveBeenCalled();
    expect(ui.getPasswordToggle).toHaveBeenCalledTimes(5);
    expect(toggleLabel).toBe("Show password");
  });
});

describe("assertProfileConnectionDisconnected", () => {
  it("waits for the profile drawer to report the disconnected state", async () => {
    const ui = createReachableControlsUi({
      getConnectionTitle: vi.fn(async () => ({
        ...createElement(),
        getText: vi.fn(async () => "Not connected")
      }))
    });

    await assertProfileConnectionDisconnected(ui);

    expect(ui.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg: "Expected profile drawer connection status to be disconnected"
      })
    );
  });
});
