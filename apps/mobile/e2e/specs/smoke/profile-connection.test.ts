import { describe, expect, it, vi } from "vitest";
import {
  assertProfileConnectionControlsReachable,
  assertProfileConnectionDisconnected,
  openProfileConnectionSheet
} from "./profile-connection.e2e";

interface FakeElement {
  click: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
  isExisting: ReturnType<typeof vi.fn>;
  waitForDisplayed: ReturnType<typeof vi.fn>;
}

function createElement(exists = true): FakeElement {
  return {
    click: vi.fn(async () => undefined),
    getText: vi.fn(async () => ""),
    isExisting: vi.fn(async () => exists),
    waitForDisplayed: vi.fn(async () => undefined)
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
    const ui = {
      getConnectionStatus: vi.fn(async () => createElement()),
      getConnectionTitle: vi.fn(async () => createElement()),
      getConnectLocalButton: vi.fn(async () => createElement()),
      getEmailInput: vi.fn(async () => createElement()),
      getPasswordInput: vi.fn(async () => createElement()),
      getSignInButton: vi.fn(async () => createElement()),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await assertProfileConnectionControlsReachable(ui);

    expect(ui.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg:
          "Expected profile drawer connection controls and sign-in form to be reachable"
      })
    );
  });
});

describe("assertProfileConnectionDisconnected", () => {
  it("waits for the profile drawer to report the disconnected state", async () => {
    const ui = {
      getConnectionTitle: vi.fn(async () => ({
        ...createElement(),
        getText: vi.fn(async () => "Not connected")
      })),
      getConnectionStatus: vi.fn(async () => createElement()),
      getConnectLocalButton: vi.fn(async () => createElement()),
      getEmailInput: vi.fn(async () => createElement()),
      getPasswordInput: vi.fn(async () => createElement()),
      getSignInButton: vi.fn(async () => createElement()),
      waitUntil: vi.fn(async (condition: () => Promise<boolean>, options) => {
        if (await condition()) {
          return;
        }

        throw new Error(options.timeoutMsg);
      })
    };

    await assertProfileConnectionDisconnected(ui);

    expect(ui.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeoutMsg: "Expected profile drawer connection status to be disconnected"
      })
    );
  });
});
