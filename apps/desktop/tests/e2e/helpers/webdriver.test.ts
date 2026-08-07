import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./startupOverlays", () => ({
  dismissStartupShortcutsModal: vi.fn(async () => {}),
}));

import { dismissStartupShortcutsModal } from "./startupOverlays";
import { WebDriverClient } from "./webdriver";

describe("WebDriverClient.createSession", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("dismisses startup shortcuts by default", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        return {
          json: async () => ({ value: { sessionId: "session-1" } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const client = new WebDriverClient();
    vi.spyOn(client, "waitForAppReady").mockResolvedValue();

    await client.createSession();

    expect(dismissStartupShortcutsModal).toHaveBeenCalledWith(client);
  });

  it("can preserve startup shortcuts when requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/session") && init?.method === "POST") {
        return {
          json: async () => ({ value: { sessionId: "session-2" } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const client = new WebDriverClient();
    vi.spyOn(client, "waitForAppReady").mockResolvedValue();

    await client.createSession({ dismissStartupShortcuts: false });

    expect(dismissStartupShortcutsModal).not.toHaveBeenCalled();
  });

  it("clears the readiness flags in the same script that reloads", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
      });
      if (url.endsWith("/session") && method === "POST") {
        return { json: async () => ({ value: { sessionId: "session-4" } }) } as Response;
      }
      if (url.endsWith("/execute/sync") && method === "POST") {
        return { json: async () => ({ value: null }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url} ${method}`);
    }));

    const client = new WebDriverClient();
    const waitForAppReady = vi.spyOn(client, "waitForAppReady").mockResolvedValue();
    await client.createSession({ dismissStartupShortcuts: false });

    await client.reload();

    // Clearing has to ride along with the reload call itself: otherwise
    // waitForAppReady can observe the outgoing page and return too early.
    const script = (requests
      .find((request) => request.url.endsWith("/execute/sync"))
      ?.body as { script?: string } | undefined)?.script ?? "";
    expect(script).toContain("window.__KANNA_E2E__.ready = false");
    expect(script).toContain("window.__KANNA_E2E__.startupOverlaysSettled = false");
    expect(script).toContain("location.reload()");
    expect(waitForAppReady).toHaveBeenCalledTimes(2);
    expect(dismissStartupShortcutsModal).toHaveBeenCalledWith(client);
  });

  it("drags one element to the upper half of another element with active mouse movement", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ url, method, body });

      if (url.endsWith("/session") && method === "POST") {
        return {
          json: async () => ({ value: { sessionId: "session-3" } }),
        } as Response;
      }
      if (url.endsWith("/element/source/rect") && method === "GET") {
        return {
          json: async () => ({ value: { x: 20, y: 100, width: 200, height: 24 } }),
        } as Response;
      }
      if (url.endsWith("/element/target/rect") && method === "GET") {
        return {
          json: async () => ({ value: { x: 20, y: 40, width: 200, height: 24 } }),
        } as Response;
      }
      if (url.endsWith("/execute/async") && method === "POST") {
        return {
          json: async () => ({ value: null }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url} ${method}`);
    }));

    const client = new WebDriverClient();
    vi.spyOn(client, "waitForAppReady").mockResolvedValue();
    await client.createSession({ dismissStartupShortcuts: false });

    await client.dragElementToElement("source", "target");

    const executeRequest = requests.find(
      (request) => request.url.endsWith("/execute/async") && request.method === "POST",
    );
    expect(executeRequest?.body).toMatchObject({
      script: expect.stringContaining("new MouseEvent"),
    });
    const script = (executeRequest?.body as { script?: string } | undefined)?.script ?? "";
    expect(script).toContain('"start":{"x":120,"y":112}');
    expect(script).toContain('"middle":{"x":120,"y":78}');
    expect(script).toContain('"end":{"x":120,"y":44}');
    expect(script).toContain('fire("mousemove", points.middle, 1)');
  });
});
