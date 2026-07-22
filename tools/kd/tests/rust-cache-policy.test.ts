import { describe, expect, it } from "vitest";
import {
  KANACHE_REVISION,
  parseKanacheManifest,
  parseRustCacheMode,
  parseWorktreeList,
  rankDonors,
  resolveRustCacheEligibility,
  resolveKanachePaths
} from "../src/runtime/rust-cache-policy";

describe("rust cache policy", () => {
  it("enables Kanache by default and accepts the documented override values", () => {
    expect(parseRustCacheMode(undefined)).toEqual({ enabled: true });
    expect(parseRustCacheMode("  ")).toEqual({ enabled: true });
    expect(parseRustCacheMode("on")).toEqual({ enabled: true });
    expect(parseRustCacheMode("kanache")).toEqual({ enabled: true });
    expect(parseRustCacheMode("off")).toEqual({ enabled: false });
    expect(parseRustCacheMode("mystery")).toEqual({
      enabled: false,
      warning: "Unknown KANNA_RUST_CACHE value \"mystery\"; cache disabled."
    });
  });

  it.each([
    [{ mode: undefined, platform: "darwin", ci: undefined }, { enabled: true }],
    [{ mode: "on", platform: "darwin", ci: undefined }, { enabled: true }],
    [{ mode: "kanache", platform: "darwin", ci: "  " }, { enabled: true }],
    [
      { mode: "on", platform: "darwin", ci: "false" },
      { enabled: false, category: "disabled-in-ci" }
    ],
    [
      { mode: "on", platform: "linux", ci: undefined },
      { enabled: false, category: "unsupported-platform" }
    ],
    [
      { mode: "off", platform: "linux", ci: "true" },
      { enabled: false, category: "disabled" }
    ]
  ] as const)("resolves runtime eligibility for %o", (input, expected) => {
    expect(resolveRustCacheEligibility(input)).toEqual(expected);
  });

  it("preserves invalid-mode precedence over platform and CI gates", () => {
    expect(
      resolveRustCacheEligibility({ mode: "mystery", platform: "linux", ci: "true" })
    ).toEqual({
      enabled: false,
      category: "invalid-mode",
      warning: "Unknown KANNA_RUST_CACHE value \"mystery\"; cache disabled."
    });
  });

  it("pins the binary and event log below the Kanna cache root", () => {
    expect(resolveKanachePaths("/Users/tester")).toEqual({
      revision: KANACHE_REVISION,
      versionRoot: `/Users/tester/Library/Caches/kanna/tools/kanache/${KANACHE_REVISION}`,
      binary: `/Users/tester/Library/Caches/kanna/tools/kanache/${KANACHE_REVISION}/bin/kanache`,
      events: "/Users/tester/Library/Caches/kanna/kanache/events.jsonl"
    });
  });

  it("parses Git porcelain without accepting bare or prunable entries", () => {
    expect(
      parseWorktreeList(
        [
          "worktree /repo",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          "worktree /repo/.kanna-worktrees/task-one",
          "HEAD abc123",
          "detached",
          "",
          "worktree /missing",
          "HEAD abc123",
          "prunable gitdir file points to non-existent location",
          ""
        ].join("\n")
      )
    ).toEqual([
      { path: "/repo", head: "abc123" },
      { path: "/repo/.kanna-worktrees/task-one", head: "abc123" }
    ]);
  });

  it("accepts only Kanna dev manifests with no extra inputs", () => {
    const current = parseKanacheManifest(
      JSON.stringify({
        profiles: ["dev"],
        targets: ["aarch64-apple-darwin", "host"],
        extra_inputs: [],
        rust_build_inputs_blake3: "rust-input-identity",
        rust_build_input_exclusions: ["apps/desktop/src-tauri/binaries"],
        created_unix_nanos: 42
      })
    );
    expect(current).toMatchObject({
      targets: ["aarch64-apple-darwin", "host"],
      rustBuildInputsBlake3: "rust-input-identity",
      rustBuildInputExclusions: ["apps/desktop/src-tauri/binaries"]
    });
    expect(
      parseKanacheManifest(
        JSON.stringify({
          profiles: ["dev"],
          targets: ["aarch64-apple-darwin", "host"],
          extra_inputs: [],
          created_unix_nanos: 42
        })
      )
    ).toEqual({
      profiles: ["dev"],
      targets: ["aarch64-apple-darwin", "host"],
      extraInputs: [],
      createdUnixNanos: 42
    });
    expect(() =>
      parseKanacheManifest(
        JSON.stringify({
          profiles: ["release"],
          targets: ["host"],
          extra_inputs: [],
          created_unix_nanos: 1
        })
      )
    ).toThrow("profile dev");
    expect(() =>
      parseKanacheManifest(
        JSON.stringify({
          profiles: ["dev"],
          targets: ["host"],
          extra_inputs: [{ path: ".env" }],
          created_unix_nanos: 1
        })
      )
    ).toThrow("extra inputs");
  });

  it("prefers both layouts, then host, then explicit target, newest first", () => {
    expect(
      rankDonors(
        [
          {
            path: "/explicit",
            head: "abc",
            matchingMode: "head",
            manifest: {
              profiles: ["dev"],
              targets: ["aarch64-apple-darwin"],
              extraInputs: [],
              createdUnixNanos: 30
            }
          },
          {
            path: "/both-old",
            head: "abc",
            matchingMode: "head",
            manifest: {
              profiles: ["dev"],
              targets: ["aarch64-apple-darwin", "host"],
              extraInputs: [],
              createdUnixNanos: 10
            }
          },
          {
            path: "/host",
            head: "abc",
            matchingMode: "head",
            manifest: {
              profiles: ["dev"],
              targets: ["host"],
              extraInputs: [],
              createdUnixNanos: 40
            }
          },
          {
            path: "/both-new",
            head: "abc",
            matchingMode: "head",
            manifest: {
              profiles: ["dev"],
              targets: ["aarch64-apple-darwin", "host"],
              extraInputs: [],
              createdUnixNanos: 20
            }
          }
        ],
        "aarch64-apple-darwin"
      ).map((donor) => donor.path)
    ).toEqual(["/both-new", "/both-old", "/host", "/explicit"]);
  });

  it("breaks otherwise-equal donor rankings by path", () => {
    expect(
      rankDonors(
        ["/zeta", "/alpha"].map((path) => ({
          path,
          head: "abc",
          matchingMode: "head" as const,
          manifest: {
            profiles: ["dev"],
            targets: ["host"],
            extraInputs: [],
            createdUnixNanos: 10
          }
        })),
        "aarch64-apple-darwin"
      ).map((donor) => donor.path)
    ).toEqual(["/alpha", "/zeta"]);
  });
});
