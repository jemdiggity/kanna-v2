import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRemoteCompanionFixture,
  navigateRemoteCompanionPage,
  parseCompanionEntryUrl,
  sanitizeRemoteCompanionSnapshotForDiagnostic,
} from "./remoteCompanion";

describe("remote companion E2E helper", () => {
  it("manages a complete visual companion fixture under one task worktree", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "kanna-desktop-companion-"));
    try {
      const fixture = await createRemoteCompanionFixture({
        worktreePath,
        sessionId: "desktop-e2e-session",
        choice: "layout-a",
        initialMarker: "Initial desktop companion",
        updatedMarker: "Updated desktop companion",
        recoveryMarker: "Recovered desktop companion",
      });

      await expect(fixture.document()).resolves.toContain(
        "Initial desktop companion",
      );
      await expect(fixture.asset()).resolves.toEqual(fixture.assetBytes);
      await fixture.publishUpdate();
      await expect(fixture.document()).resolves.toContain(
        "Updated desktop companion",
      );
      await fixture.publishRecoveryUpdate();
      await expect(fixture.document()).resolves.toContain(
        "Recovered desktop companion",
      );
      await fixture.stop();
      await expect(
        readFile(join(fixture.sessionRoot, "state", "server-stopped"), "utf8"),
      ).resolves.toBe("");
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });

  it("accepts only the exact random-subdomain loopback capability shape", () => {
    const value =
      `http://${"a".repeat(32)}.localhost:4312/?cap=${"b".repeat(32)}`;
    expect(parseCompanionEntryUrl(value)).toEqual({
      baseUrl: `http://${"a".repeat(32)}.localhost:4312`,
      entryUrl: value,
    });
    expect(() => parseCompanionEntryUrl(
      `http://127.0.0.1:4312/?cap=${"b".repeat(32)}`,
    )).toThrow("invalid companion entry URL");
    expect(() => parseCompanionEntryUrl(
      `https://${"a".repeat(32)}.localhost:4312/?cap=${"b".repeat(32)}`,
    )).toThrow("invalid companion entry URL");
  });

  it("never includes the one-time capability in timeout diagnostics", () => {
    const diagnostic = sanitizeRemoteCompanionSnapshotForDiagnostic({
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      sessionId: "session-1",
      revision: "revision-1",
      status: "available",
      entryUrl:
        `http://${"a".repeat(32)}.localhost:4312/?cap=${"b".repeat(32)}`,
    });

    expect(diagnostic).toEqual({
      ownerDesktopId: "desktop-1",
      ownerTaskId: "task-1",
      sessionId: "session-1",
      revision: "revision-1",
      status: "available",
      hasEntryUrl: true,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("cap=");
  });

  it("replaces raw navigation errors with a capability-free stable error", async () => {
    const secretUrl =
      `http://${"a".repeat(32)}.localhost:4312/?cap=${"b".repeat(32)}`;
    let caught: unknown = null;
    try {
      await navigateRemoteCompanionPage(async () => {
        throw new Error(`page.goto: net::ERR_FAILED at ${secretUrl}`);
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new Error("companion browser navigation failed"));
    const serialized = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain("cap=");
    expect(serialized).not.toContain("ERR_FAILED");
  });
});
