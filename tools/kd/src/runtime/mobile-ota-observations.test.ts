import { describe, expect, it, vi } from "vitest";
import { observeMobileDevices, observeRuntimePointers } from "./mobile-ota-observations";
import type { MobileOtaContext } from "./mobile-ota";

const device = (runtimeVersion = "2.2.2") => ({
  deviceId: "iphone", deviceName: "Owner's iPhone",
  build: { environment: "staging", channel: "staging", runtimeVersion,
    nativeVersion: "2.2.2", nativeBuild: "42", updateId: "old-update", source: "ota", reportedAtUnixMs: Date.now() }
});
function context(devices: unknown[], environment = "staging"): MobileOtaContext {
  return { repoRoot: ".", env: {}, runner: { run: vi.fn().mockImplementation(async (_command, args: string[]) => ({ exitCode: 0, stdout: JSON.stringify(args.at(-1)?.endsWith("/v1/status") ? { environment } : { desktopId: "owner-mac", devices }), stderr: "" })) } };
}
describe("OTA device observations", () => {
  it.each([
    ["staging", "staging", "http://127.0.0.1:48121"],
    ["production", "prod", "http://127.0.0.1:48120"]
  ] as const)("queries the %s desktop and respects the local URL override", async (environment, reported, defaultUrl) => {
    for (const override of [undefined, "http://localhost:49000/"]) {
      const ctx = context([], reported);
      ctx.env.KANNA_OTA_DEVICE_SERVER_URL = override;
      await observeMobileDevices(ctx, environment, environment, "2.2.3");
      const baseUrl = (override ?? defaultUrl).replace(/\/$/, "");
      expect(vi.mocked(ctx.runner.run).mock.calls.map(call => call[1].at(-1))).toEqual([
        `${baseUrl}/v1/status`, `${baseUrl}/v1/mobile/builds`
      ]);
    }
  });
  it.each(["prod", "dev"])("does not use a desktop reporting %s for staging device evidence", async (reported) => {
    const ctx = context([device("2.2.3")], reported);
    const result = await observeMobileDevices(ctx, "staging", "staging", "2.2.3", "old-update");
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain(`desktop at http://127.0.0.1:48121 reported environment ${reported}; expected staging; no devices counted`);
    expect(result.detail).not.toContain("Owner's iPhone");
    expect(ctx.runner.run).toHaveBeenCalledTimes(1);
  });
  it.each([
    { exitCode: 1, stdout: "", stderr: "offline" },
    { exitCode: 0, stdout: "not JSON", stderr: "" },
    { exitCode: 0, stdout: "{}", stderr: "" }
  ])("does not query inventory when status cannot establish the environment: %j", async (response) => {
    const ctx = context([device("2.2.3")]);
    vi.mocked(ctx.runner.run).mockResolvedValueOnce(response);
    const result = await observeMobileDevices(ctx, "staging", "staging", "2.2.3");
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("http://127.0.0.1:48121 reported environment UNKNOWN");
    expect(result.detail).toContain("no devices counted");
    expect(ctx.runner.run).toHaveBeenCalledTimes(1);
  });
  it("names drift when the published runtime cannot reach the owner's device", async () => {
    const result = await observeMobileDevices(context([device()]), "staging", "staging", "2.2.3", "new-update");
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("WARNING OTA DRIFT");
    expect(result.detail).toContain("cannot receive runtime 2.2.3");
    expect(result.detail).toContain("Reported runtimes: 2.2.2");
  });
  it("separates compatible from applied and continues warning about stranded devices in a mixed fleet", async () => {
    const result = await observeMobileDevices(context([device(), device("2.2.3")]), "staging", "staging", "2.2.3", "new-update");
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("application of the channel update is NOT confirmed");
    expect(result.detail).not.toContain("no recently observed");
    const applied = await observeMobileDevices(context([device("2.2.3")]), "staging", "staging", "2.2.3", "old-update");
    expect(applied.status).toBe("PASS");
    expect(applied.detail).toContain("Applied update confirmed");
  });
  it("does not count unknown, stale, development, or other-channel devices as evidence of reachability", async () => {
    for (const devices of [[], [{ ...device(), build: null }], [{ ...device(), build: { ...device().build, reportedAtUnixMs: Date.parse("2020-01-01") } }], [{ ...device(), build: { ...device().build, source: "development" } }], [{ ...device(), build: { ...device().build, environment: "prod", channel: "production" } }]]) {
      const result = await observeMobileDevices(context(devices), "staging", "staging", "2.2.2");
      expect(result.status).toBe("WARN");
      expect(result.detail).toContain("no recently observed");
    }
    const unavailable = context([]);
    unavailable.runner.run = vi.fn().mockRejectedValue(new Error("offline"));
    expect((await observeMobileDevices(unavailable, "staging", "staging", "2.2.3")).detail).toContain("reachability UNKNOWN");
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
