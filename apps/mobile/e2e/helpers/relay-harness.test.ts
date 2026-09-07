import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as relayHarness from "./relay-harness";

describe("mobile relay harness helpers", () => {
  it("defines deterministic retained history behind a bounded PTY window", () => {
    const fixture = (
      relayHarness as typeof relayHarness & {
        MOBILE_RELAY_PTY_HISTORY_FIXTURE?: {
          maxEncodedChars: number;
          minEncodedChars: number;
          minRetainedScrollbackLines: number;
          sentinel: string;
        };
      }
    ).MOBILE_RELAY_PTY_HISTORY_FIXTURE;

    expect(fixture).toBeDefined();
    expect(fixture?.maxEncodedChars).toBeLessThan(1_000_000);
    expect(fixture?.minRetainedScrollbackLines).toBeGreaterThan(8_000);
    expect(fixture?.sentinel).toMatch(/MOBILE.*SNAPSHOT/);
  });

  it("does not compare encoded snapshots across terminal geometries", () => {
    expect(relayHarness.mobileRelayTerminalGeometryExpectation({
      taskId: "task-1",
      sentinel: "MOBILE_PTY_SNAPSHOT_SENTINEL",
      expectedCols: 80,
      expectedRows: 48,
      minDecodedBytes: 5_517,
    })).toEqual({
      cols: 80,
      minEncodedChars: relayHarness.MOBILE_RELAY_PTY_HISTORY_FIXTURE.minEncodedChars,
      rows: 48,
      sentinel: "MOBILE_PTY_SNAPSHOT_SENTINEL",
    });
  });

  it("uses the publisher's stable cloud task identity instead of the legacy fallback", () => {
    expect(relayHarness.publishedCloudTaskId(
      { cloudTaskId: { stringValue: " stable-task-id " } },
      "cloud:desktop:repo:local",
    )).toBe("stable-task-id");
    expect(relayHarness.publishedCloudTaskId(
      undefined,
      "cloud:desktop:repo:local",
    )).toBe("cloud:desktop:repo:local");
  });

  it("counts exact multiline child-PTY inputs in the NUL-delimited ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-mobile-inputs-"));
    const tracePath = join(root, "inputs");
    try {
      const input = "Persisted relay approval.\n\nPreserve the relay fixture.";
      await writeFile(tracePath, `${input}\0other\0${input}\0`, "utf8");
      expect(relayHarness.scriptedInputTraceCount(tracePath, input)).toBe(2);
      expect(relayHarness.scriptedInputTraceCount(tracePath, "other")).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("describes unique, ambiguous, and Markdown mentions used by Appium", () => {
    expect(relayHarness.MOBILE_RELAY_FILE_PREVIEW_FIXTURE).toEqual({
      ambiguousBarePath: "shared.ts",
      ambiguousCanonicalPaths: [
        "fixtures/a/shared.ts",
        "fixtures/b/shared.ts"
      ],
      content: [
        "# Mobile Relay Preview",
        "",
        "Rendered through the authenticated owner relay.",
        "",
        "```ts",
        'const relayStatus: string = "connected";',
        "```",
        "TARGET RAW LINE"
      ].join("\n"),
      expectedHeading: "Mobile Relay Preview",
      expectedHighlightedToken: "const",
      expectedHighlightedTokenClass: "hljs-keyword",
      expectedRenderedText: "Rendered through the authenticated owner relay.",
      expectedRawLine: "TARGET RAW LINE",
      expectedCanonicalRowOrder: [
        "fixtures/unique/TaskScreen.tsx",
        "fixtures/a/shared.ts",
        "fixtures/b/shared.ts",
        "docs/spec.md"
      ],
      line: 7,
      mentionedCount: 3,
      mentionedLinks: [
        "docs/spec.md",
        "TaskScreen.tsx:7",
        "shared.ts",
        "TaskScreen.tsx:7"
      ],
      missingLink: "docs/mobile-preview-missing.md",
      path: "docs/spec.md",
      rawLink: "TaskScreen.tsx:7",
      renderedLink: "docs/spec.md",
      uniqueBarePath: "TaskScreen.tsx",
      uniqueCanonicalPath: "fixtures/unique/TaskScreen.tsx",
      uniqueContent: [
        "export function relayFixture() {",
        "  const status = \"connected\";",
        "  return status;",
        "}",
        "",
        "// Mentioned by bare filename.",
        "TARGET RAW LINE"
      ].join("\n")
    });
  });

  it("builds a hybrid Expo environment with cloud forcing disabled", () => {
    const buildEnv = (
      relayHarness as typeof relayHarness & {
        mobileRelayExpoEnv?: (
          harness: {
            ports: { auth: number; firestore: number; relay: number };
          },
          options: { forceCloud: boolean }
        ) => Record<string, string>;
      }
    ).mobileRelayExpoEnv;

    expect(buildEnv).toBeTypeOf("function");
    if (!buildEnv) return;

    expect(
      buildEnv(
        { ports: { auth: 9099, firestore: 8080, relay: 8787 } },
        { forceCloud: false }
      )
    ).toMatchObject({
      EXPO_PUBLIC_KANNA_FORCE_CLOUD: "0",
      EXPO_PUBLIC_KANNA_RELAY_URL: "ws://127.0.0.1:8787",
      EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_PORT: "9099",
      EXPO_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_PORT: "8080"
    });
  });
  it("defines relay source order opposite the required Tasks-tab creation order", () => {
    expect(relayHarness.relayTaskOrderingFixture("repo-ordering")).toEqual({
      sourceOrderTaskIds: [
        "cloud:mobile-relay-ordering-desktop:repo-ordering:mobile-relay-ordering-older",
        "cloud:mobile-relay-ordering-desktop:repo-ordering:mobile-relay-ordering-newer",
      ],
      expectedVisualOrderTaskIds: [
        "cloud:mobile-relay-ordering-desktop:repo-ordering:mobile-relay-ordering-newer",
        "cloud:mobile-relay-ordering-desktop:repo-ordering:mobile-relay-ordering-older",
      ],
    });
  });
  it("creates real pairing sessions and drives debug-only failure controls", async () => {
    const pairing = {
      code: "ABC123",
      pairingPayload: "pairing-payload",
      desktopId: "desktop-e2e",
      desktopName: "E2E Desktop",
      lanHost: "0.0.0.0",
      lanPort: 48120,
      expiresAtUnixMs: Date.now() + 60_000
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pairing), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lanHttpEnabled: true,
        pairingSessionExpired: true
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        lanHttpEnabled: false,
        pairingSessionExpired: false
      }), { status: 200 }));

    await expect(relayHarness.createHarnessPairingSession(
      "http://127.0.0.1:48120",
      fetchImpl
    )).resolves.toEqual(pairing);
    await relayHarness.updateHarnessMobileMachineControls(
      "http://127.0.0.1:48120",
      { expirePairingSession: true },
      fetchImpl
    );
    await relayHarness.updateHarnessMobileMachineControls(
      "http://127.0.0.1:48120",
      { lanHttpEnabled: false },
      fetchImpl
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:48120/v1/pairing/sessions",
      { method: "POST" }
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:48120/v1/e2e/mobile-machine-controls",
      expect.objectContaining({ body: JSON.stringify({ expirePairingSession: true }) })
    );
  });

  it("manages the active visual companion entirely inside the scripted worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-mobile-companion-"));
    const task = { taskId: "task-1", worktreePath: root };
    try {
      await relayHarness.seedMobileRelayCompanion(task);
      const fixture = relayHarness.MOBILE_RELAY_COMPANION_FIXTURE;
      const sessionRoot = join(
        root,
        ".superpowers",
        "brainstorm",
        fixture.sessionId
      );
      expect(await readFile(join(sessionRoot, "state", "server-info"), "utf8"))
        .toBe("{}");
      expect(await readFile(join(sessionRoot, "content", "screen.html"), "utf8"))
        .toContain(fixture.initialMarker);

      await relayHarness.invalidateMobileRelayCompanion(task);
      expect((await readFile(join(sessionRoot, "content", "screen.html"))).byteLength)
        .toBeGreaterThan(1024 * 1024);

      await relayHarness.replaceMobileRelayCompanion(task);
      expect(await readFile(join(sessionRoot, "content", "screen.html"), "utf8"))
        .toContain(fixture.updatedMarker);

      await writeFile(
        join(sessionRoot, "state", "events"),
        `${JSON.stringify({ type: "click", choice: fixture.choice })}\n`,
        "utf8"
      );
      await expect(relayHarness.readMobileRelayCompanionEvents(task))
        .resolves.toEqual([{ type: "click", choice: fixture.choice }]);

      await relayHarness.stopMobileRelayCompanion(task);
      expect(await readFile(join(sessionRoot, "state", "server-stopped"), "utf8"))
        .toBe("");
      await relayHarness.resumeMobileRelayCompanion(task);
      await expect(readFile(join(sessionRoot, "state", "server-stopped"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not define a relay-specific companion protocol or preview route", async () => {
    const source = await readFile(new URL("./relay-harness.ts", import.meta.url), "utf8");
    expect(source).not.toContain('type: "companion_');
    expect(source).not.toMatch(/\/v1\/(?:companion|preview)/);
  });
});
