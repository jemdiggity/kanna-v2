import { describe, expect, it, vi } from "vitest";
import { waitForSql } from "./serverSql";

describe("waitForSql", () => {
  it("surfaces a failed SQL read instead of treating it as no rows", async () => {
    const fetchClient = vi.fn(async () => new Response("local control credential required", {
      status: 403,
    }));

    await expect(waitForSql(
      "http://127.0.0.1:48120",
      "SELECT 1",
      [],
      () => false,
      "a row that already exists",
      1_000,
      fetchClient,
    )).rejects.toThrow("e2e sql failed (403): local control credential required");
    expect(fetchClient).toHaveBeenCalledOnce();
  });
});
