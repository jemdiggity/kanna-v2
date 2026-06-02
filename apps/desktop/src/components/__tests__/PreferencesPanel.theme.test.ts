// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreferencesPanel from "../PreferencesPanel.vue";

vi.mock("../../services/desktopAuthSdk", () => ({
  getConfiguredDesktopAuthSession: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    subscribe: vi.fn((next) => {
      next({ status: "signedOut" });
      return () => undefined;
    }),
  })),
}));

vi.mock("../../invoke", () => ({
  invoke: vi.fn(async () => ({ state: "stopped" })),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

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
      },
    },
    global: {
      mocks: {
        $t: (key: string) => key,
      },
    },
  });
}

describe("PreferencesPanel theme controls", () => {
  it("renders app and terminal/code theme selectors", () => {
    const wrapper = mountPreferences();

    const appTheme = wrapper.get('[data-testid="app-theme-select"]');
    const codeTheme = wrapper.get('[data-testid="code-theme-select"]');

    expect(appTheme.element).toHaveProperty("value", "dark");
    expect(codeTheme.element).toHaveProperty("value", "match");
    expect(wrapper.text()).toContain("preferences.theme");
    expect(wrapper.text()).toContain("preferences.codeTheme");
  });

  it("emits theme preference updates", async () => {
    const wrapper = mountPreferences();

    await wrapper.get('[data-testid="app-theme-select"]').setValue("light");
    await wrapper.get('[data-testid="code-theme-select"]').setValue("dark");

    expect(wrapper.emitted("update")).toContainEqual(["appTheme", "light"]);
    expect(wrapper.emitted("update")).toContainEqual(["codeTheme", "dark"]);
  });
});
