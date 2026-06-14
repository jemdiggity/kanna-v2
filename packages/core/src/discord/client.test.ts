import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordClient } from "./client";

describe("DiscordClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes an abort signal when posting through a webhook", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await new DiscordClient({ webhookUrl: "https://discord.test/webhook" }).postMessage("hello");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("passes an abort signal when posting with a bot token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "1" }));
    vi.stubGlobal("fetch", fetchMock);

    await new DiscordClient({ botToken: "token", channelId: "C123" }).postMessage("hello");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes an abort signal when fetching messages", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);

    await new DiscordClient({ botToken: "token", channelId: "C123" }).fetchMessages();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a configured timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", fetchMock);

    await new DiscordClient({
      webhookUrl: "https://discord.test/webhook",
      timeoutMs: 250,
    }).postMessage("hello");

    expect(timeoutSpy).toHaveBeenCalledWith(250);
  });
});
