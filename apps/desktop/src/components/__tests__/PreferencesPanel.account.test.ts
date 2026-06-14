// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopAuthSession, DesktopAuthState } from "../../services/desktopAuth";

const authSession = {
  initialize: vi.fn(),
  getState: vi.fn(),
  subscribe: vi.fn(),
  signInWithEmailPassword: vi.fn(),
  signOut: vi.fn(),
  getIdToken: vi.fn(),
};

vi.mock("../../services/desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => authSession),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../invoke", () => ({
  invoke: vi.fn(async () => ({
    state: "stopped",
    desktopId: "desktop-current",
    desktopName: "Studio Mac",
  })),
}));

function signedOutSession(): DesktopAuthSession {
  let listener: ((state: DesktopAuthState) => void) | null = null;
  const session = authSession as unknown as DesktopAuthSession;
  authSession.initialize.mockResolvedValue(undefined);
  authSession.getState.mockReturnValue({ status: "signedOut" });
  authSession.subscribe.mockImplementation((next: (state: DesktopAuthState) => void) => {
    listener = next;
    next({ status: "signedOut" });
    return () => undefined;
  });
  authSession.signInWithEmailPassword.mockImplementation(async ({ email }) => {
    listener?.({
      status: "signedIn",
      user: { uid: "user-1", email, displayName: null },
    });
  });
  authSession.signOut.mockResolvedValue(undefined);
  authSession.getIdToken.mockResolvedValue("id-token");
  return session;
}

function mountPreferences() {
  return mount(PreferencesPanel, {
    props: {
      preferences: {
        suspendAfterMinutes: 5,
        killAfterMinutes: 30,
        ideCommand: "code",
        locale: "en",
        devLingerTerminals: false,
        defaultAgentProvider: "claude",
        appTheme: "dark",
        codeTheme: "match",
        agentMessageAppearance: "chat",
      },
    },
    global: {
      mocks: {
        $t: (key: string) => key,
      },
    },
  });
}

let PreferencesPanel: typeof import("../PreferencesPanel.vue").default;

describe("PreferencesPanel account sign-in", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    signedOutSession();
    PreferencesPanel = (await import("../PreferencesPanel.vue")).default;
  });

  it("signs in with email and password from the Account tab", async () => {
    const wrapper = mountPreferences();
    await flushPromises();

    await wrapper.get('[data-testid="preferences-account-tab"]').trigger("click");
    await wrapper.get('[data-testid="account-email"]').setValue("upvote.sieve.7t@icloud.com");
    await wrapper.get('[data-testid="account-password"]').setValue("password123");
    await wrapper.get('[data-testid="account-sign-in"]').trigger("submit");
    await flushPromises();

    expect(authSession.signInWithEmailPassword).toHaveBeenCalledWith({
      email: "upvote.sieve.7t@icloud.com",
      password: "password123",
    });
    expect(wrapper.text()).toContain("upvote.sieve.7t@icloud.com");
  });

  it("toggles password visibility on the Account tab", async () => {
    const wrapper = mountPreferences();
    await flushPromises();

    await wrapper.get('[data-testid="preferences-account-tab"]').trigger("click");
    const passwordInput = wrapper.get<HTMLInputElement>('[data-testid="account-password"]');

    expect(passwordInput.element.type).toBe("password");

    await wrapper.get('[data-testid="account-toggle-password"]').trigger("click");
    expect(passwordInput.element.type).toBe("text");

    await wrapper.get('[data-testid="account-toggle-password"]').trigger("click");
    expect(passwordInput.element.type).toBe("password");
  });

  it("shows the current desktop id on the Account tab", async () => {
    const wrapper = mountPreferences();
    await flushPromises();

    await wrapper.get('[data-testid="preferences-account-tab"]').trigger("click");

    expect(wrapper.text()).toContain("Desktop ID");
    expect(wrapper.text()).toContain("desktop-current");
  });
});
