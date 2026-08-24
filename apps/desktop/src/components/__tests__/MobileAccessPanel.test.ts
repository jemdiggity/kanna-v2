// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import MobileAccessPanel from "../MobileAccessPanel.vue";

vi.mock("../../utils/pairingQr", () => ({
  renderPairingQr: vi.fn(async () => "data:image/png;base64,qr"),
}));

describe("MobileAccessPanel", () => {
  it("shows the desktop name and a start pairing action", () => {
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
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
        pairingPayload: null,
      },
    });

    expect(wrapper.get('[data-testid="mobile-access-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="mobile-access-status"]').text()).toBe("Online");
    expect(wrapper.get('[data-testid="mobile-access-pairing-code"]').text()).toBe("123456");
    expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toBe("Refresh");
  });

  it("renders the QR generated from the same session as the short code", async () => {
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: "ABC123",
        pairingPayload: "KANNA1:DESKTOP-1:ABC123",
      },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="mobile-access-pairing-qr"]').attributes("src"))
      .toBe("data:image/png;base64,qr");
    expect(wrapper.get('[data-testid="mobile-access-pairing-code"]').text())
      .toBe("ABC123");
  });

  it("stops displaying pairing credentials when the session expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00Z"));
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: "ABC123",
        pairingPayload: "KANNA1:DESKTOP-1:ABC123",
        expiresAtUnixMs: Date.now() + 1_000,
      },
    });

    await flushPromises();
    expect(wrapper.find('[data-testid="mobile-access-pairing-code"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toBe("Refresh");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper.find('[data-testid="mobile-access-pairing-code"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("No pairing session active");
    expect(wrapper.get('[data-testid="mobile-access-start-pairing"]').text()).toBe("Start pairing");
    vi.useRealTimers();
  });
});
