import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackClient } from "./client";

describe("SlackClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes an abort signal when posting a message", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await new SlackClient("token").postMessage("C123", "hello");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("passes an abort signal when fetching history", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true, messages: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await new SlackClient("token").fetchHistory("C123");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a configured timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await new SlackClient("token", { timeoutMs: 250 }).postMessage("C123", "hello");

    expect(timeoutSpy).toHaveBeenCalledWith(250);
  });
});
