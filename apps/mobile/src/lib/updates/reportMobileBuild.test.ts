import { describe, expect, it, vi } from "vitest";
import { reportMobileBuild } from "./reportMobileBuild";
import type { BuildIdentity } from "./buildIdentity";

const identity: BuildIdentity = {
  nativeVersion: "2.2.2", nativeBuild: "42", nativeSummary: "2.2.2 (42)",
  runtimeVersion: "2.2.2", environment: "staging", channel: "staging",
  source: { kind: "ota", label: "old-update", updateId: "old-update" }
};
describe("mobile build reporting", () => {
  it("reports installed identity with pairing credentials, without depending on push permission", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await reportMobileBuild("http://desktop", fetch, { deviceId: "phone", deviceSecret: "secret" }, () => identity);
    expect(fetch).toHaveBeenCalledWith("http://desktop/v1/mobile/build", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kanna-Device-Id": "phone", "X-Kanna-Device-Secret": "secret" },
      body: JSON.stringify({ environment: "staging", channel: "staging", runtimeVersion: "2.2.2", nativeVersion: "2.2.2", nativeBuild: "42", updateId: "old-update", source: "ota" })
    });
  });
  it("never presents Metro as an OTA-capable runtime and tolerates older desktops", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(reportMobileBuild("http://desktop", fetch, { deviceId: "phone", deviceSecret: "secret" }, () => ({ ...identity, source: { kind: "development", label: "Development bundle (Metro)" } }))).resolves.toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ runtimeVersion: null, updateId: null });
    warning.mockRestore();
  });
});
