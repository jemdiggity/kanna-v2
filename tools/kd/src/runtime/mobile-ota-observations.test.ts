import { describe, expect, it, vi } from "vitest";
import { observeMobileDevices, observeRuntimePointers } from "./mobile-ota-observations";
import type { MobileOtaContext } from "./mobile-ota";

const device = (runtimeVersion = "2.2.2") => ({
  deviceId: "iphone", deviceName: "Owner's iPhone",
  build: { environment: "staging", channel: "staging", runtimeVersion,
    nativeVersion: "2.2.2", nativeBuild: "42", updateId: "old-update", source: "ota", reportedAtUnixMs: Date.now() }
});
function context(devices: unknown[]): MobileOtaContext {
  return { repoRoot: ".", env: {}, runner: { run: vi.fn().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ desktopId: "owner-mac", devices }), stderr: "" }) } };
}
describe("OTA device observations", () => {
  it("names drift when the published runtime cannot reach the owner's device", async () => {
    const result = await observeMobileDevices(context([device()]), "staging", "2.2.3", "new-update");
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("WARNING OTA DRIFT");
    expect(result.detail).toContain("cannot receive runtime 2.2.3");
    expect(result.detail).toContain("Reported runtimes: 2.2.2");
  });
  it("separates compatible from applied and continues warning about stranded devices in a mixed fleet", async () => {
    const result = await observeMobileDevices(context([device(), device("2.2.3")]), "staging", "2.2.3", "new-update");
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("application of the channel update is NOT confirmed");
    expect(result.detail).not.toContain("no recently observed");
    const applied = await observeMobileDevices(context([device("2.2.3")]), "staging", "2.2.3", "old-update");
    expect(applied.status).toBe("PASS");
    expect(applied.detail).toContain("Applied update confirmed");
  });
  it("does not count unknown, stale, development, or other-channel devices as evidence of reachability", async () => {
    for (const devices of [[], [{ ...device(), build: null }], [{ ...device(), build: { ...device().build, reportedAtUnixMs: Date.parse("2020-01-01") } }], [{ ...device(), build: { ...device().build, source: "development" } }], [{ ...device(), build: { ...device().build, environment: "prod", channel: "production" } }]]) {
      const result = await observeMobileDevices(context(devices), "staging", "2.2.2");
      expect(result.status).toBe("WARN");
      expect(result.detail).toContain("no recently observed");
    }
    const unavailable = context([]);
    unavailable.runner.run = vi.fn().mockRejectedValue(new Error("offline"));
    expect((await observeMobileDevices(unavailable, "staging", "2.2.3")).detail).toContain("reachability UNKNOWN");
  });
  it("lists historical runtime pointers and identifies those predating the newest pointer, even from an older checkout", async () => {
    const prefix = "gs://bucket/ota/ios/";
    const ctx = context([]);
    ctx.runner.run = vi.fn().mockImplementation(async (_command, args: string[]) => ({ exitCode: 0, stderr: "", stdout: args.includes("ls")
      ? `${prefix}2.2.2/channels/staging.json\n${prefix}2.2.3/channels/staging.json`
      : JSON.stringify({ currentUpdateId: args.at(-1)?.includes("2.2.2") ? "old" : "new", createdAt: args.at(-1)?.includes("2.2.2") ? "2026-09-02" : "2026-09-08" }) }));
    const result = await observeRuntimePointers(ctx, "bucket", "staging", "2.2.3");
    expect(result.detail).toContain("runtime 2.2.2: old; pointer published 2026-09-02 [STALE");
    expect(result.detail).toContain("runtime 2.2.3: new; pointer published 2026-09-08 [configured]");
    const olderCheckout = await observeRuntimePointers(ctx, "bucket", "staging", "2.2.2");
    expect(olderCheckout.detail).toContain("2026-09-02 [STALE: predates newest channel pointer] [configured]");
  });
});
