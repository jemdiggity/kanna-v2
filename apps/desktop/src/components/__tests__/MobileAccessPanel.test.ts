// @vitest-environment happy-dom

import { config, flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import MobileAccessPanel from "../MobileAccessPanel.vue";
import { MOBILE_INSTALL_LINKS } from "../../utils/mobileInstallLinks";

const qrMocks = vi.hoisted(() => ({
  renderPairingQr: vi.fn(async () => "data:image/png;base64,pairing-qr"),
  renderQrCode: vi.fn(async () => "data:image/png;base64,install-qr"),
}));
vi.mock("../../utils/pairingQr", () => ({
  renderPairingQr: qrMocks.renderPairingQr,
  renderQrCode: qrMocks.renderQrCode,
}));

config.global.mocks = { $t: (key: string) => key };

describe("MobileAccessPanel", () => {
  const originalInstallLinks = { ...MOBILE_INSTALL_LINKS };

  afterEach(() => {
    Object.assign(MOBILE_INSTALL_LINKS, originalInstallLinks);
    qrMocks.renderQrCode.mockResolvedValue("data:image/png;base64,install-qr");
  });
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
      .toBe("data:image/png;base64,pairing-qr");
    expect(wrapper.get('[data-testid="mobile-access-pairing-code"]').text())
      .toBe("ABC123");
  });

  it("renders the configured mobile install QR, link, and hint", async () => {
    MOBILE_INSTALL_LINKS.dev = "https://kanna.build/mobile";
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        environment: "development",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
      },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="mobile-access-install-qr"]').attributes("src"))
      .toBe("data:image/png;base64,install-qr");
    expect(wrapper.get('[data-testid="mobile-access-install-link"]').text())
      .toBe("https://kanna.build/mobile");
    expect(wrapper.text()).toContain("mobileAccess.installHint");
    expect(wrapper.find('[data-testid="mobile-access-install-unconfigured"]').exists()).toBe(false);
  });

  it("shows the honest fallback when the environment link is a placeholder", () => {
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        environment: "staging",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
      },
    });

    expect(wrapper.get('[data-testid="mobile-access-install-unconfigured"]').text())
      .toBe("mobileAccess.installUnconfigured");
    expect(wrapper.find('[data-testid="mobile-access-install-qr"]').exists()).toBe(false);
  });

  it("shows an error state when the configured install QR cannot render", async () => {
    MOBILE_INSTALL_LINKS.dev = "https://kanna.build/mobile";
    qrMocks.renderQrCode.mockRejectedValueOnce(new Error("render failed"));
    const wrapper = mount(MobileAccessPanel, {
      props: {
        desktopName: "Studio Mac",
        environment: "dev",
        serverStatus: "running",
        pairingCode: null,
        pairingPayload: null,
      },
    });

    await flushPromises();

    expect(wrapper.get('[data-testid="mobile-access-install-error"]').text())
      .toBe("mobileAccess.installQrError");
    expect(wrapper.find('[data-testid="mobile-access-install-qr"]').exists()).toBe(false);
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
