import { afterEach, describe, expect, it, vi } from "vitest";
import { assertOk, httpRequest } from "./client";

describe("http transport helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the default request timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await httpRequest("https://example.test/api");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("uses a configured request timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await httpRequest("https://example.test/api", { timeoutMs: 250 });

    expect(timeoutSpy).toHaveBeenCalledWith(250);
  });

  it("throws a provider-labeled status error", async () => {
    await expect(
      assertOk(new Response(null, { status: 429 }), "Example API")
    ).rejects.toThrow("Example API error 429");
  });

  it("can include response text in status errors", async () => {
    await expect(
      assertOk(new Response("rate limited", { status: 429 }), "Example API", {
        includeBody: true,
      })
    ).rejects.toThrow("Example API error 429: rate limited");
  });
});
