import { describe, expect, it } from "vitest";
import * as relayHarness from "./relay-harness";

describe("mobile relay harness helpers", () => {
  it("describes the real Markdown file and routed failure used by Appium", () => {
    expect(relayHarness.MOBILE_RELAY_FILE_PREVIEW_FIXTURE).toEqual({
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
      line: 8,
      missingLink: "docs/mobile-preview-missing.md",
      nonMarkdownLinks: [
        "apps/mobile/src/screens/TerminalWebView.tsx:42",
        "apps/mobile/package.json",
        "crates/daemon/src/lib.rs:9"
      ],
      path: "docs/mobile-file-preview.md",
      rawLink: "docs/mobile-file-preview.md:8",
      renderedLink: "docs/mobile-file-preview.md"
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
});
