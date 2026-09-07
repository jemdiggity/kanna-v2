import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { localProcessFetch } from "./localProcessFetch";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe("localProcessFetch", () => {
  it("represents HTTP no-body statuses with a null Response body", async () => {
    const server = createServer((_request, response) => response.writeHead(204).end());
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");

    const response = await localProcessFetch(`http://127.0.0.1:${address.port}/`);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });
});
