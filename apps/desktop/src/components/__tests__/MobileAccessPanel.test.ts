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

  it("warns when the signed-in account has no registered push device and explains why", async () => {
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
        accountSignedIn: true,
        pushRegistration: {
          status: "noRegisteredDevices",
          registeredDeviceCount: 0,
          noDevicesReason: {
            code: "unregistered",
            message: "The mobile app unregistered the last push device at 2026-09-03T08:11:31.000Z. Open Kanna on the phone while signed in to register again.",
            retiredAt: "2026-09-03T08:11:31.000Z",
          },
        },
      },
    });

    const row = wrapper.get('[data-testid="mobile-access-push-registration"]');
    expect(row.attributes("data-status")).toBe("noRegisteredDevices");
    expect(row.text()).toContain("No phone is registered for push notifications");
    expect(wrapper.get('[data-testid="mobile-access-push-reason"]').text())
      .toContain("unregistered the last push device at 2026-09-03T08:11:31.000Z");
    expect(row.text().match(/Open Kanna/g)).toHaveLength(1);
    expect(wrapper.find('[data-testid="mobile-access-push-instruction"]').exists()).toBe(false);

    await wrapper.get('[data-testid="mobile-access-push-refresh"]').trigger("click");
    expect(wrapper.emitted("refresh-push-registration")).toHaveLength(1);
  });

  it("reports a registered phone and hides push status while signed out", () => {
    const registered = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
        accountSignedIn: true,
        pushRegistration: { status: "registered", registeredDeviceCount: 1 },
      },
    });
    const row = registered.get('[data-testid="mobile-access-push-registration"]');
    expect(row.attributes("data-status")).toBe("registered");
    expect(row.text()).toContain("reach 1 registered phone");
    expect(registered.find('[data-testid="mobile-access-push-instruction"]').exists()).toBe(false);

    const signedOut = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
        accountSignedIn: false,
        pushRegistration: { status: "noRegisteredDevices", registeredDeviceCount: 0 },
      },
    });
    expect(signedOut.find('[data-testid="mobile-access-push-registration"]').exists()).toBe(false);
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
