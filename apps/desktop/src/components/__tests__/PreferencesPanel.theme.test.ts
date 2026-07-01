// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import PreferencesPanel from "../PreferencesPanel.vue";
import en from "../../i18n/locales/en.json";

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
        defaultAgentType: "pty",
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

describe("PreferencesPanel theme controls", () => {
  it("renders app, code, and agent message appearance selectors", () => {
    const wrapper = mountPreferences();

    const appTheme = wrapper.get('[data-testid="app-theme-select"]');
    const codeTheme = wrapper.get('[data-testid="code-theme-select"]');
    const appearance = wrapper.get('[data-testid="agent-message-appearance-select"]');

    expect(appTheme.element).toHaveProperty("value", "dark");
    expect(codeTheme.element).toHaveProperty("value", "match");
    expect(appearance.element).toHaveProperty("value", "chat");
    expect(wrapper.text()).toContain("preferences.theme");
    expect(wrapper.text()).toContain("preferences.codeTheme");
    expect(wrapper.text()).toContain("preferences.agentMessageAppearance");
  });

  it("emits theme and appearance preference updates", async () => {
    const wrapper = mountPreferences();

    await wrapper.get('[data-testid="app-theme-select"]').setValue("light");
    await wrapper.get('[data-testid="code-theme-select"]').setValue("dark");
    await wrapper.get('[data-testid="agent-message-appearance-select"]').setValue("terminal");

    expect(wrapper.emitted("update")).toContainEqual(["appTheme", "light"]);
    expect(wrapper.emitted("update")).toContainEqual(["codeTheme", "dark"]);
    expect(wrapper.emitted("update")).toContainEqual(["agentMessageAppearance", "terminal"]);
  });

  it("uses the requested provider and sdk choices for the default agent preference", () => {
    const wrapper = mountPreferences();
    const defaultAgentSelect = wrapper.get('[data-testid="default-agent-select"]');

    expect(en.preferences.defaultAgent).toBe("Default agent");
    expect(defaultAgentSelect.findAll("option").map((option) => option.text())).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
      "antigravity",
      "claude (sdk)",
      "codex (sdk)",
    ]);
  });

  it("emits provider and execution type when choosing an sdk default agent", async () => {
    const wrapper = mountPreferences();
    const defaultAgentSelect = wrapper.get('[data-testid="default-agent-select"]');

    await defaultAgentSelect.setValue("codex-sdk");

    expect(wrapper.emitted("update")).toContainEqual(["defaultAgentProvider", "codex"]);
    expect(wrapper.emitted("update")).toContainEqual(["defaultAgentType", "agent"]);
  });

  it("emits provider and execution type when switching between cli and sdk defaults", async () => {
    const wrapper = mountPreferences();
    const defaultAgentSelect = wrapper.get('[data-testid="default-agent-select"]');

    await defaultAgentSelect.setValue("opencode");
    await defaultAgentSelect.setValue("claude-sdk");

    expect(wrapper.emitted("update")).toContainEqual(["defaultAgentProvider", "opencode"]);
    expect(wrapper.emitted("update")).toContainEqual(["defaultAgentType", "pty"]);
    expect(wrapper.emitted("update")).toContainEqual(["defaultAgentProvider", "claude"]);
    expect(wrapper.emitted("update")).toContainEqual(["defaultAgentType", "agent"]);
  });
});
