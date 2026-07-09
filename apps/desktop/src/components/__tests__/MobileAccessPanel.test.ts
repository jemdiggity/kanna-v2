// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import MobileAccessPanel from "../MobileAccessPanel.vue";

describe("MobileAccessPanel", () => {
  it("shows the desktop name and a start pairing action", () => {
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: null,
      },
    });

    expect(wrapper.text()).toContain("Studio Mac");
    expect(wrapper.get('button[type="button"]').text()).toMatch(/start pairing/i);
  });

  it("exposes stable selectors for the desktop pairing E2E", () => {
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: "123456",
      },
    });

    expect(wrapper.get('[data-testid="mobile-access-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="mobile-access-status"]').text()).toBe("Online");
    expect(wrapper.get('[data-testid="mobile-access-pairing-code"]').text()).toBe("123456");
    expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toMatch(/start pairing/i);
  });
});
