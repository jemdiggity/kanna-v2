import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localProcessFetch } from "./localProcessFetch";

/**
 * The whole point of this client is a *negative* property — the headers it does
 * not send — so the test asserts against a real socket rather than a mock. A
 * mocked `request` would happily keep passing after undici's behaviour changed
 * underneath it, which is the failure this file exists to catch.
 */
describe("localProcessFetch", () => {
  let server: Server;
  let baseUrl = "";
  let received: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.statusCode = 201;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test server port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("sends no fetch-metadata headers, so kanna-server reads it as a local process", async () => {
    received = [];
    await localProcessFetch(`${baseUrl}/v1/status`);

    const [call] = received;
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/v1/status");
    for (const header of ["sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "sec-fetch-user", "origin"]) {
      expect(call.headers, `${header} would classify this call as browser-originated`)
        .not.toHaveProperty(header);
    }
  });

  it("documents the contrast: Node's global fetch does attach fetch metadata", async () => {
    received = [];
    await fetch(`${baseUrl}/v1/status`);

    expect(Object.keys(received[0].headers)).toContain("sec-fetch-mode");
  });

  it("round-trips method, headers, body, status, and response headers", async () => {
    received = [];
    const response = await localProcessFetch(`${baseUrl}/v1/tasks?limit=2`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kanna-test": "1" },
      body: JSON.stringify({ prompt: "hello" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ ok: true });

    const [call] = received;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/v1/tasks?limit=2");
    expect(call.headers["x-kanna-test"]).toBe("1");
    expect(call.body).toBe(JSON.stringify({ prompt: "hello" }));
  });

  it("passes a 204 through instead of throwing on the Response constructor", async () => {
    received = [];
    const noContentServer = createServer((request, response) => {
      request.resume();
      response.statusCode = 204;
      response.end();
    });
    await new Promise<void>((resolve) => noContentServer.listen(0, "127.0.0.1", resolve));
    const address = noContentServer.address();
    if (!address || typeof address === "string") throw new Error("no port");

    try {
      const response = await localProcessFetch(
        `http://127.0.0.1:${address.port}/v1/tasks/abc/actions/close`,
        { method: "POST" },
      );
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      await expect(response.text()).resolves.toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => {
        noContentServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses a non-http URL rather than silently falling back", async () => {
    await expect(localProcessFetch("https://127.0.0.1/v1/status")).rejects.toThrow(
      /only supports http URLs/,
    );
  });
});
