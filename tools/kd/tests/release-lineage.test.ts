import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composePostPromotionTrunkBody,
  composeStagingChannelBody,
  evaluateCandidateLineage,
  evaluatePromotionGate,
  evaluateSoak,
  evaluateStagingPublishGate,
  formatLineageResetBlock,
  formatPostPromotionTrunkBlock,
  isReleaseBranchName,
  parseLineageResetRecord,
  parsePostPromotionTrunkRecord,
  promotionAuthorizes,
  resetAuthorizes,
  type LineageResetRecord,
  type PostPromotionTrunkRecord,
  type StagingCandidate
} from "../src/runtime/release-lineage";
import { hasProductionTagForSeries, parseUnmergedReleaseCommits } from "../src/runtime/release";
import { DEFAULT_RELEASE_POLICY, parseReleasePolicy, readReleasePolicy } from "../src/runtime/release-policy";

const ACTIVE: StagingCandidate = {
  version: "0.1.0-staging.7",
  tag: "v0.1.0-staging.7",
  commit: "7777777777777777777777777777777777777777",
  sourceBranch: "main",
  publishedAt: "2026-07-01T00:00:00Z"
};

const RESET: LineageResetRecord = {
  resetAt: "2026-07-02T00:00:00Z",
  fromVersion: "0.1.0-staging.7",
  fromCommit: ACTIVE.commit,
  fromSourceBranch: "main",
  toBranch: "release/0.1",
  reason: "hotfix the 0.1 series"
};

const POST_PROMOTION: PostPromotionTrunkRecord = {
  resumedAt: "2026-08-17T03:00:00Z",
  promotedVersion: "0.1.0",
  promotedTag: "v0.1.0",
  promotedCommit: ACTIVE.commit ?? "",
  productionTagCommit: ACTIVE.commit ?? "",
  newCommit: "8888888888888888888888888888888888888888",
  newBranch: "main"
};

function gate(overrides: Partial<Parameters<typeof evaluateStagingPublishGate>[0]> = {}) {
  return evaluateStagingPublishGate({
    proposedSourceBranch: "main",
    proposedCommit: "8888888888888888888888888888888888888888",
    active: ACTIVE,
    relationship: "descendant",
    activeProductionTagExists: false,
    activeMetadataError: null,
    reset: null,
    postPromotion: null,
    ...overrides
  });
}

describe("staging publish gate", () => {
  it("allows a descendant or a rebuild of the same commit", () => {
    expect(gate().allowed).toBe(true);
    expect(gate({ relationship: "same-commit" }).allowed).toBe(true);
  });

  it("allows the first publish onto an empty channel", () => {
    expect(gate({ active: null, relationship: "unknown" }).allowed).toBe(true);
  });

  it("refuses divergence, rollback, and unresolvable histories", () => {
    expect(gate({ relationship: "diverged" }).reason).toMatch(/share only an older merge base/);
    expect(gate({ relationship: "behind" }).reason).toMatch(/Refusing to roll the staging channel back/);
    expect(gate({ relationship: "unknown" }).reason).toMatch(/git could not resolve one of the commits/);
    expect(gate({ relationship: "diverged" }).allowed).toBe(false);
  });

  it("freezes main publishes while an unpromoted release-branch candidate is active", () => {
    const frozen = gate({ active: { ...ACTIVE, sourceBranch: "release/0.1" } });
    expect(frozen.allowed).toBe(false);
    expect(frozen.frozenBy).toBe("release/0.1");
    expect(frozen.reason).toMatch(/staging is frozen to that branch/);
  });

  it("waives that freeze when a recorded reset authorizes the next main publish", () => {
    const resetToMain: LineageResetRecord = {
      ...RESET,
      fromSourceBranch: "release/0.1",
      toBranch: "main"
    };
    const waived = gate({
      active: { ...ACTIVE, sourceBranch: "release/0.1" },
      reset: resetToMain
    });
    expect(waived).toMatchObject({
      allowed: true,
      waivedByReset: true,
      frozenBy: null,
      reason: null
    });
  });

  it("lifts the freeze once the candidate's production version is released", () => {
    const thawed = gate({
      active: { ...ACTIVE, sourceBranch: "release/0.1" },
      activeProductionTagExists: true
    });
    expect(thawed.allowed).toBe(true);
  });

  it("allows only a recorded promoted divergence back to forward main", () => {
    const resumed = gate({
      active: { ...ACTIVE, sourceBranch: "release/0.1" },
      relationship: "diverged",
      activeProductionTagExists: true,
      postPromotion: POST_PROMOTION
    });
    expect(resumed).toMatchObject({ allowed: true, authorizedByPromotion: true, waivedByReset: false });

    expect(gate({ relationship: "diverged", activeProductionTagExists: true, postPromotion: null }).allowed).toBe(false);
    expect(
      gate({
        active: { ...ACTIVE, sourceBranch: "release/0.1" },
        relationship: "diverged",
        activeProductionTagExists: true,
        postPromotion: { ...POST_PROMOTION, promotedCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      }).allowed
    ).toBe(false);
  });

  it("keeps shipping the release branch itself during a freeze", () => {
    const branchShip = gate({
      active: { ...ACTIVE, sourceBranch: "release/0.1" },
      proposedSourceBranch: "release/0.1"
    });
    expect(branchShip.allowed).toBe(true);
  });

  it("refuses to move a channel whose active candidate cannot be read", () => {
    const blind = gate({ activeMetadataError: "prerelease v0.1.0-staging.7 could not be read from GitHub" });
    expect(blind.allowed).toBe(false);
    expect(blind.reason).toMatch(/Cannot verify staging lineage/);
  });

  it("waives exactly the reset it recorded, and nothing else", () => {
    const authorized = gate({ relationship: "diverged", proposedSourceBranch: "release/0.1", reset: RESET });
    expect(authorized.allowed).toBe(true);
    expect(authorized.waivedByReset).toBe(true);

    expect(gate({ relationship: "diverged", proposedSourceBranch: "release/0.2", reset: RESET }).allowed).toBe(false);
    expect(
      gate({
        relationship: "diverged",
        proposedSourceBranch: "release/0.1",
        reset: { ...RESET, fromVersion: "0.1.0-staging.6" }
      }).allowed
    ).toBe(false);
  });
});

describe("lineage reset records", () => {
  it("round-trips a reset record through the channel body", () => {
    const body = composeStagingChannelBody("Pointer-only desktop staging updater channel.", RESET);
    expect(parseLineageResetRecord(body)).toEqual(RESET);
  });

  it("reads the newest record when several resets are recorded", () => {
    const older = composeStagingChannelBody("Pointer-only desktop staging updater channel.", RESET);
    const newer = composeStagingChannelBody(older, { ...RESET, resetAt: "2026-08-01T00:00:00Z", reason: "newer" });
    expect(parseLineageResetRecord(newer)?.reason).toBe("newer");
    expect(newer).toContain("hotfix the 0.1 series");
  });

  it("returns null for a body with no record", () => {
    expect(parseLineageResetRecord("Pointer-only desktop staging updater channel.")).toBeNull();
  });

  it("tolerates a record written without a resolvable commit", () => {
    const body = formatLineageResetBlock({ ...RESET, fromCommit: null, fromSourceBranch: null });
    expect(parseLineageResetRecord(body)).toMatchObject({ fromCommit: null, fromSourceBranch: null });
  });

  it("matches a version with or without its leading v", () => {
    expect(resetAuthorizes(RESET, { fromVersion: "v0.1.0-staging.7", toBranch: "release/0.1" })).toBe(true);
    expect(resetAuthorizes(null, { fromVersion: "0.1.0-staging.7", toBranch: "release/0.1" })).toBe(false);
  });
});

describe("post-promotion trunk records", () => {
  it("round-trips a resumption record and keeps earlier audit history", () => {
    const resetBody = composeStagingChannelBody("Pointer-only desktop staging updater channel.", RESET);
    const body = composePostPromotionTrunkBody(resetBody, POST_PROMOTION);
    expect(parsePostPromotionTrunkRecord(body)).toEqual(POST_PROMOTION);
    expect(parseLineageResetRecord(body)).toEqual(RESET);
    expect(formatPostPromotionTrunkBlock(POST_PROMOTION)).toContain("Promoted-Tag: v0.1.0");
  });

  it("matches every endpoint of the recorded transition", () => {
    expect(
      promotionAuthorizes(POST_PROMOTION, {
        fromVersion: ACTIVE.version,
        fromCommit: ACTIVE.commit,
        toCommit: POST_PROMOTION.newCommit,
        toBranch: "main"
      })
    ).toBe(true);
    expect(
      promotionAuthorizes(POST_PROMOTION, {
        fromVersion: ACTIVE.version,
        fromCommit: ACTIVE.commit,
        toCommit: POST_PROMOTION.newCommit,
        toBranch: "release/0.2"
      })
    ).toBe(false);
  });
});

describe("candidate lineage", () => {
  const candidate: StagingCandidate = {
    version: "0.1.0-staging.8",
    tag: "v0.1.0-staging.8",
    commit: "8888888888888888888888888888888888888888",
    sourceBranch: "release/0.1",
    publishedAt: "2026-07-03T00:00:00Z"
  };
  const previous = { version: ACTIVE.version, tag: ACTIVE.tag, commit: ACTIVE.commit };

  it("treats a first candidate as valid", () => {
    const lineage = evaluateCandidateLineage({ candidate, previous: null, relationship: "descendant", reset: null, postPromotion: null });
    expect(lineage).toMatchObject({ relationship: "initial", valid: true });
  });

  it("marks an unauthorized divergence invalid", () => {
    const lineage = evaluateCandidateLineage({ candidate, previous, relationship: "diverged", reset: null, postPromotion: null });
    expect(lineage.valid).toBe(false);
    expect(lineage.authorizedByReset).toBe(false);
  });

  it("marks a recorded divergence valid", () => {
    const lineage = evaluateCandidateLineage({ candidate, previous, relationship: "diverged", reset: RESET, postPromotion: null });
    expect(lineage.valid).toBe(true);
    expect(lineage.authorizedByReset).toBe(true);
    expect(lineage.detail).toContain("authorized by the recorded lineage reset");
  });

  it("marks a recorded post-promotion trunk divergence valid", () => {
    const mainCandidate = { ...candidate, sourceBranch: "main" };
    const lineage = evaluateCandidateLineage({
      candidate: mainCandidate,
      previous,
      relationship: "diverged",
      reset: null,
      postPromotion: POST_PROMOTION
    });
    expect(lineage).toMatchObject({ valid: true, authorizedByReset: false, authorizedByPromotion: true });
    expect(lineage.detail).toContain("resumed trunk");
  });

  it("fails closed on an unresolvable comparison", () => {
    const lineage = evaluateCandidateLineage({ candidate, previous, relationship: "unknown", reset: RESET, postPromotion: null });
    expect(lineage.valid).toBe(false);
  });
});

describe("soak evaluation", () => {
  const nowMs = Date.parse("2026-07-03T00:00:00Z");

  it("measures elapsed hours from the publication time", () => {
    const soak = evaluateSoak({ requiredHours: 24, publishedAt: "2026-07-01T00:00:00Z", nowMs });
    expect(soak).toMatchObject({ elapsedHours: 48, satisfied: true, overridden: false });
  });

  it("blocks inside the window and records an explicit override", () => {
    const blocked = evaluateSoak({ requiredHours: 24, publishedAt: "2026-07-02T20:00:00Z", nowMs });
    expect(blocked.satisfied).toBe(false);
    const overridden = evaluateSoak({
      requiredHours: 24,
      publishedAt: "2026-07-02T20:00:00Z",
      nowMs,
      overrideReason: "named human asked for it"
    });
    expect(overridden).toMatchObject({ satisfied: true, overridden: true, overrideReason: "named human asked for it" });
  });

  it("fails closed when the publication time is unreadable", () => {
    expect(evaluateSoak({ requiredHours: 24, publishedAt: null, nowMs }).satisfied).toBe(false);
    expect(evaluateSoak({ requiredHours: 24, publishedAt: "not a date", nowMs }).elapsedHours).toBeNull();
  });

  it("treats a zero window as no gate", () => {
    expect(evaluateSoak({ requiredHours: 0, publishedAt: null, nowMs }).satisfied).toBe(true);
  });

  it("ignores a blank override reason", () => {
    const soak = evaluateSoak({ requiredHours: 24, publishedAt: null, nowMs, overrideReason: "   " });
    expect(soak).toMatchObject({ satisfied: false, overrideReason: null });
  });
});

describe("promotion gate", () => {
  const lineage = evaluateCandidateLineage({
    candidate: { ...ACTIVE, version: "1.2.4-staging.3", tag: "v1.2.4-staging.3" },
    previous: { version: "1.2.4-staging.2", tag: "v1.2.4-staging.2", commit: "aaaa" },
    relationship: "descendant",
    reset: null,
    postPromotion: null
  });
  const soak = evaluateSoak({
    requiredHours: 24,
    publishedAt: "2026-07-01T00:00:00Z",
    nowMs: Date.parse("2026-07-03T00:00:00Z")
  });

  it("allows a candidate that clears every gate", () => {
    const gateResult = evaluatePromotionGate({
      rcTag: "v1.2.4-staging.3",
      rcVersion: "1.2.4-staging.3",
      mechanical: { pushBranch: "main", reason: null },
      lineage,
      soak
    });
    expect(gateResult).toEqual({ allowed: true, blockers: [] });
  });

  it("reports every failing gate rather than the first", () => {
    const gateResult = evaluatePromotionGate({
      rcTag: "v1.2.4-staging.3",
      rcVersion: "1.2.4-staging.3",
      mechanical: { pushBranch: null, reason: "origin/main has advanced past v1.2.4-staging.3." },
      lineage: { ...lineage, valid: false, detail: "diverged" },
      soak: { ...soak, satisfied: false, elapsedHours: 3 }
    });
    expect(gateResult.allowed).toBe(false);
    expect(gateResult.blockers).toHaveLength(3);
    expect(gateResult.blockers[2]).toMatch(/--override-soak/);
  });
});

describe("release branch names", () => {
  it("recognizes only release/X.Y", () => {
    expect(isReleaseBranchName("release/1.3")).toBe(true);
    expect(isReleaseBranchName("main")).toBe(false);
    expect(isReleaseBranchName("release/1.3.1")).toBe(false);
    expect(isReleaseBranchName(null)).toBe(false);
  });
});

describe("release-only commit detection", () => {
  it("reports branch commits with no patch-equivalent on main", () => {
    const output = [
      "1111111111111111111111111111111111111111 fix: only on the branch",
      "3333333333333333333333333333333333333333 fix: also only on the branch"
    ].join("\n");
    expect(parseUnmergedReleaseCommits(output)).toEqual([
      { sha: "1111111111111111111111111111111111111111", subject: "fix: only on the branch" },
      { sha: "3333333333333333333333333333333333333333", subject: "fix: also only on the branch" }
    ]);
  });

  it("returns nothing for a fully backported branch", () => {
    expect(parseUnmergedReleaseCommits("")).toEqual([]);
    expect(parseUnmergedReleaseCommits("\n  \n")).toEqual([]);
  });
});

describe("released-series detection", () => {
  // `git ls-remote --tags origin 'v0.1.*'` expands the pattern with a leading
  // wildcard that crosses path separators, so it returns every staging
  // prerelease in the series as well. Treating non-empty output as "released"
  // would classify every series worth abandoning as already shipped.
  const stagingOnly = [
    "aaaa\trefs/tags/v0.1.0-staging.7",
    "bbbb\trefs/tags/v0.1.0-staging.8",
    "cccc\trefs/tags/v0.1.0-staging.8^{}"
  ].join("\n");

  it("does not treat staging prereleases as a released series", () => {
    expect(stagingOnly.trim().length).toBeGreaterThan(0);
    expect(hasProductionTagForSeries(stagingOnly, { major: 0, minor: 1 })).toBe(false);
  });

  it("recognizes a real production tag, including its peeled ref", () => {
    expect(hasProductionTagForSeries(`${stagingOnly}\ndddd\trefs/tags/v0.1.0`, { major: 0, minor: 1 })).toBe(true);
    expect(hasProductionTagForSeries("dddd\trefs/tags/v0.1.3^{}", { major: 0, minor: 1 })).toBe(true);
  });

  it("ignores tags from other series and empty output", () => {
    expect(hasProductionTagForSeries("dddd\trefs/tags/v0.2.0", { major: 0, minor: 1 })).toBe(false);
    expect(hasProductionTagForSeries("", { major: 0, minor: 1 })).toBe(false);
  });
});

describe("release policy", () => {
  it("defaults to a 24 hour production soak", () => {
    expect(DEFAULT_RELEASE_POLICY).toEqual({ productionSoakHours: 24 });
    expect(parseReleasePolicy({}, "policy")).toEqual({ productionSoakHours: 24 });
  });

  it("accepts an explicit window, including zero", () => {
    expect(parseReleasePolicy({ productionSoakHours: 72 }, "policy").productionSoakHours).toBe(72);
    expect(parseReleasePolicy({ productionSoakHours: 0 }, "policy").productionSoakHours).toBe(0);
  });

  it("rejects unknown keys and invalid windows by name", () => {
    expect(() => parseReleasePolicy({ soakHours: 4 }, "release-policy.json")).toThrow(
      /release-policy\.json has unknown key "soakHours"/
    );
    expect(() => parseReleasePolicy({ productionSoakHours: -1 }, "release-policy.json")).toThrow(/non-negative/);
    expect(() => parseReleasePolicy({ productionSoakHours: "24" }, "release-policy.json")).toThrow(/non-negative/);
    expect(() => parseReleasePolicy([], "release-policy.json")).toThrow(/must contain a JSON object/);
  });

  it("reads the repository file and falls back to defaults when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "kd-release-policy-"));
    try {
      expect(readReleasePolicy(root)).toEqual({ productionSoakHours: 24 });
      await writeFile(join(root, "release-policy.json"), '{"$schema":"./release-policy.schema.json","productionSoakHours":48}\n');
      expect(readReleasePolicy(root)).toEqual({ productionSoakHours: 48 });
      await writeFile(join(root, "release-policy.json"), "{ nope\n");
      expect(() => readReleasePolicy(root)).toThrow(/is not valid JSON/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ships a repository policy that matches the documented default", () => {
    expect(readReleasePolicy(join(__dirname, "..", "..", "..")).productionSoakHours).toBe(24);
  });
});
