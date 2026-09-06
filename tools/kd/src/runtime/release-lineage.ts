/**
 * The staging channel's lineage state machine.
 *
 * `desktop-staging` is a single pointer, so every staging publish moves one
 * shared channel. Mechanical alignment (the RC commit matches its promotion
 * branch tip) says nothing about whether the channel got there by moving
 * forward: v0.1.0-staging.8 was mechanically aligned to `release/0.1` while its
 * history had diverged from v0.1.0-staging.7 by ~640 commits, and the tooling
 * still called it promotable.
 *
 * Everything in this module is pure: callers resolve git/GitHub facts and pass
 * them in, so the same decisions run in `release status`, in `release ship
 * --staging` (including `--dry-run`), and in `release promote`.
 */

export type StagingLineageRelationship =
  | "initial"
  | "same-commit"
  | "descendant"
  | "behind"
  | "diverged"
  | "unknown";

export interface StagingCandidate {
  version: string;
  tag: string;
  commit: string | null;
  sourceBranch: string | null;
  publishedAt: string | null;
}

/**
 * A recorded, deliberate abandonment of the current staging lineage. Written to
 * the `desktop-staging` pointer release body by `kd release reset-staging`, and
 * consumed by the next staging publish that matches it.
 */
export interface LineageResetRecord {
  resetAt: string;
  fromVersion: string;
  fromCommit: string | null;
  fromSourceBranch: string | null;
  toBranch: string;
  reason: string;
}

/**
 * A deliberate move of an unreleased release branch to a newer main tip.
 * The record is written to the desktop-staging release and matched only by
 * the next candidate from this exact branch epoch.
 */
export interface LineageRecutRecord {
  recutId: string;
  recutAt: string;
  series: string;
  branch: string;
  oldTip: string;
  newTip: string;
  archiveTag: string;
  fromVersion: string | null;
  fromCommit: string | null;
  fromSourceBranch: string | null;
  priorEpoch: string;
  requester: string;
  reason: string;
}

export interface LineageRecutApplicationRecord {
  recutId: string;
  version: string;
  commit: string;
  appliedAt: string;
  tag: string;
}

/**
 * Audit evidence for the one ordinary divergence caused by the release-branch
 * model: after an RC is promoted, trunk may resume from the branch point even
 * though it cannot contain the branch's cherry-picked commit SHAs.
 */
export interface PostPromotionTrunkRecord {
  resumedAt: string;
  promotedVersion: string;
  promotedTag: string;
  promotedCommit: string;
  productionTagCommit: string;
  newCommit: string;
  newBranch: string;
}

export const LINEAGE_RESET_MARKER = "Lineage-Reset:";
export const LINEAGE_RECUT_MARKER = "Lineage-Recut:";
export const LINEAGE_RECUT_APPLIED_MARKER = "Lineage-Recut-Applied:";
export const POST_PROMOTION_TRUNK_MARKER = "Post-Promotion-Trunk-Resumption:";
export const STAGING_CHANNEL_BODY_HEADER = "Pointer-only desktop staging updater channel.";

export function isReleaseBranchName(branch: string | null | undefined): boolean {
  return typeof branch === "string" && /^release\/\d+\.\d+$/.test(branch.trim());
}

export function normalizeStagingVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

export function formatLineageResetBlock(record: LineageResetRecord): string {
  return [
    `${LINEAGE_RESET_MARKER} ${record.resetAt}`,
    `Reset-From: ${record.fromVersion} (${record.fromCommit ?? "unknown-commit"}) source ${record.fromSourceBranch ?? "unknown"}`,
    `Reset-To: ${record.toBranch}`,
    `Reset-Reason: ${record.reason}`
  ].join("\n");
}

export function formatLineageRecutBlock(record: LineageRecutRecord): string {
  return [
    `${LINEAGE_RECUT_MARKER} ${record.recutAt}`,
    `Recut-Id: ${record.recutId}`,
    `Recut-Series: ${record.series}`,
    `Recut-Branch: ${record.branch}`,
    `Recut-Old-Tip: ${record.oldTip}`,
    `Recut-New-Tip: ${record.newTip}`,
    `Recut-Archive-Tag: ${record.archiveTag}`,
    `Recut-From: ${record.fromVersion ?? "empty-channel"} (${record.fromCommit ?? "unknown-commit"}) source ${record.fromSourceBranch ?? "unknown"}`,
    `Recut-Prior-Epoch: ${record.priorEpoch}`,
    `Recut-Requester: ${record.requester}`,
    `Recut-Reason: ${record.reason}`
  ].join("\n");
}

export function formatLineageRecutApplicationBlock(record: LineageRecutApplicationRecord): string {
  return [
    `${LINEAGE_RECUT_APPLIED_MARKER} ${record.appliedAt}`,
    `Recut-Applied-Id: ${record.recutId}`,
    `Recut-Applied-Version: ${record.version}`,
    `Recut-Applied-Commit: ${record.commit}`,
    `Recut-Applied-Tag: ${record.tag}`
  ].join("\n");
}

export function formatPostPromotionTrunkBlock(record: PostPromotionTrunkRecord): string {
  return [
    `${POST_PROMOTION_TRUNK_MARKER} ${record.resumedAt}`,
    `Promoted-Version: ${record.promotedVersion}`,
    `Promoted-Tag: ${record.promotedTag}`,
    `Promoted-Commit: ${record.promotedCommit}`,
    `Production-Tag-Commit: ${record.productionTagCommit}`,
    `Resumed-To: ${record.newCommit} source ${record.newBranch}`
  ].join("\n");
}

/**
 * Reads the newest reset block. Blocks are prepended, so the first match is the
 * most recent reset and older blocks stay in the body as an audit trail.
 */
export function parseLineageResetRecord(body: string): LineageResetRecord | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(LINEAGE_RESET_MARKER));
  if (start < 0) return null;
  const resetAt = lines[start]?.trim().slice(LINEAGE_RESET_MARKER.length).trim() ?? "";
  const block = lines.slice(start + 1, start + 5).join("\n");
  const from = /^Reset-From:[ \t]*(\S+)[ \t]*\(([^)]*)\)[ \t]*source[ \t]*(\S+)[ \t]*$/m.exec(block);
  const to = /^Reset-To:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const reason = /^Reset-Reason:[ \t]*(.+?)[ \t]*$/m.exec(block);
  if (!from || !to || !resetAt) return null;
  const fromCommit = (from[2] ?? "").trim();
  const fromSourceBranch = (from[3] ?? "").trim();
  return {
    resetAt,
    fromVersion: normalizeStagingVersion(from[1] ?? ""),
    fromCommit: fromCommit && fromCommit !== "unknown-commit" ? fromCommit : null,
    fromSourceBranch: fromSourceBranch && fromSourceBranch !== "unknown" ? fromSourceBranch : null,
    toBranch: (to[1] ?? "").trim(),
    reason: reason?.[1]?.trim() ?? ""
  };
}

/** Reads the newest recut block, preserving older blocks below it. */
export function parseLineageRecutRecord(body: string): LineageRecutRecord | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(LINEAGE_RECUT_MARKER));
  if (start < 0) return null;
  const recutAt = lines[start]?.trim().slice(LINEAGE_RECUT_MARKER.length).trim() ?? "";
  const block = lines.slice(start + 1, start + 12).join("\n");
  const id = /^Recut-Id:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const series = /^Recut-Series:[ \t]*(\d+\.\d+)[ \t]*$/m.exec(block);
  const branch = /^Recut-Branch:[ \t]*(release\/\d+\.\d+)[ \t]*$/m.exec(block);
  const oldTip = /^Recut-Old-Tip:[ \t]*([0-9a-f]{40})[ \t]*$/im.exec(block);
  const newTip = /^Recut-New-Tip:[ \t]*([0-9a-f]{40})[ \t]*$/im.exec(block);
  const archiveTag = /^Recut-Archive-Tag:[ \t]*(recut\/release\/\d+\.\d+-\d+)[ \t]*$/m.exec(block);
  const from = /^Recut-From:[ \t]*(\S+)[ \t]*\(([^)]*)\)[ \t]*source[ \t]*(\S+)[ \t]*$/m.exec(block);
  const priorEpoch = /^Recut-Prior-Epoch:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const requester = /^Recut-Requester:[ \t]*(.+?)[ \t]*$/m.exec(block);
  const reason = /^Recut-Reason:[ \t]*(.+?)[ \t]*$/m.exec(block);
  if (!recutAt || !id?.[1] || !series?.[1] || !branch?.[1] || !oldTip?.[1] || !newTip?.[1] || !archiveTag?.[1] || !from?.[1] || !priorEpoch?.[1] || !requester?.[1] || !reason?.[1]) {
    return null;
  }
  const fromVersion = from[1] === "empty-channel" ? null : normalizeStagingVersion(from[1]);
  const fromCommit = from[2] !== "unknown-commit" ? from[2] : null;
  const fromSourceBranch = from[3] !== "unknown" ? from[3] : null;
  return {
    recutId: id[1],
    recutAt,
    series: series[1],
    branch: branch[1],
    oldTip: oldTip[1].toLowerCase(),
    newTip: newTip[1].toLowerCase(),
    archiveTag: archiveTag[1],
    fromVersion,
    fromCommit,
    fromSourceBranch,
    priorEpoch: priorEpoch[1].trim(),
    requester: requester[1].trim(),
    reason: reason[1].trim()
  };
}

export function parseLineageRecutApplicationRecord(body: string): LineageRecutApplicationRecord | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(LINEAGE_RECUT_APPLIED_MARKER));
  if (start < 0) return null;
  const appliedAt = lines[start]?.trim().slice(LINEAGE_RECUT_APPLIED_MARKER.length).trim() ?? "";
  const block = lines.slice(start + 1, start + 6).join("\n");
  const id = /^Recut-Applied-Id:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const version = /^Recut-Applied-Version:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const commit = /^Recut-Applied-Commit:[ \t]*([0-9a-f]{40})[ \t]*$/im.exec(block);
  const tag = /^Recut-Applied-Tag:[ \t]*(recut-applied\/\S+)[ \t]*$/m.exec(block);
  if (!appliedAt || !id?.[1] || !version?.[1] || !commit?.[1] || !tag?.[1]) return null;
  return {
    recutId: id[1],
    version: normalizeStagingVersion(version[1]),
    commit: commit[1].toLowerCase(),
    appliedAt,
    tag: tag[1]
  };
}

/** Reads the newest post-promotion trunk-resumption audit block. */
export function parsePostPromotionTrunkRecord(body: string): PostPromotionTrunkRecord | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(POST_PROMOTION_TRUNK_MARKER));
  if (start < 0) return null;
  const resumedAt = lines[start]?.trim().slice(POST_PROMOTION_TRUNK_MARKER.length).trim() ?? "";
  const block = lines.slice(start + 1, start + 6).join("\n");
  const version = /^Promoted-Version:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const tag = /^Promoted-Tag:[ \t]*(\S+)[ \t]*$/m.exec(block);
  const commit = /^Promoted-Commit:[ \t]*([0-9a-f]{40})[ \t]*$/im.exec(block);
  const tagCommit = /^Production-Tag-Commit:[ \t]*([0-9a-f]{40})[ \t]*$/im.exec(block);
  const resumed = /^Resumed-To:[ \t]*([0-9a-f]{40})[ \t]*source[ \t]*(\S+)[ \t]*$/im.exec(block);
  if (!resumedAt || !version?.[1] || !tag?.[1] || !commit?.[1] || !tagCommit?.[1] || !resumed?.[1] || !resumed[2]) return null;
  return {
    resumedAt,
    promotedVersion: normalizeStagingVersion(version[1]),
    promotedTag: tag[1],
    promotedCommit: commit[1].toLowerCase(),
    productionTagCommit: tagCommit[1].toLowerCase(),
    newCommit: resumed[1].toLowerCase(),
    newBranch: resumed[2]
  };
}

function composeStagingChannelAuditBlock(existingBody: string, block: string): string {
  const trimmed = existingBody.trim();
  const history = trimmed.length > 0 && trimmed !== STAGING_CHANNEL_BODY_HEADER
    ? trimmed.replace(new RegExp(`^${STAGING_CHANNEL_BODY_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "").trim()
    : "";
  return [STAGING_CHANNEL_BODY_HEADER, "", block, ...(history ? ["", history] : [])]
    .join("\n")
    .trimEnd() + "\n";
}

export function composeStagingChannelBody(existingBody: string, record: LineageResetRecord): string {
  return composeStagingChannelAuditBlock(existingBody, formatLineageResetBlock(record));
}

export function composeStagingChannelRecutBody(existingBody: string, record: LineageRecutRecord): string {
  return composeStagingChannelAuditBlock(existingBody, formatLineageRecutBlock(record));
}

export function composeStagingChannelRecutApplicationBody(existingBody: string, record: LineageRecutApplicationRecord): string {
  return composeStagingChannelAuditBlock(existingBody, formatLineageRecutApplicationBlock(record));
}

export function composePostPromotionTrunkBody(existingBody: string, record: PostPromotionTrunkRecord): string {
  return composeStagingChannelAuditBlock(existingBody, formatPostPromotionTrunkBlock(record));
}

/**
 * A reset authorizes exactly one non-linear move: the publish that leaves the
 * candidate it was recorded against, onto the branch it named. Once that
 * publish lands, the active candidate changes and the record stops matching, so
 * the authorization is single-use by construction rather than by bookkeeping.
 */
export function resetAuthorizes(
  reset: LineageResetRecord | null,
  args: { fromVersion: string; toBranch: string }
): boolean {
  if (!reset) return false;
  if (normalizeStagingVersion(reset.fromVersion) !== normalizeStagingVersion(args.fromVersion)) return false;
  return reset.toBranch === args.toBranch;
}

/**
 * A recut authorizes the next candidate built from the moved branch tip. The
 * candidate may include a later release-branch backport, but callers must
 * prove both that it is still the remote branch tip and that it descends from
 * the recorded cut tip before passing those facts here.
 */
export function recutAuthorizes(
  recut: LineageRecutRecord | null,
  args: {
    fromVersion: string;
    fromCommit: string | null;
    toCommit: string | null;
    toBranch: string | null;
    application?: LineageRecutApplicationRecord | null;
    toCommitRelationshipToNewTip?: StagingLineageRelationship;
    toCommitIsBranchTip?: boolean;
  }
): boolean {
  if (!recut || !args.fromCommit || !args.toCommit || !args.toBranch || !recut.fromVersion || !recut.fromCommit) return false;
  if (args.application?.recutId === recut.recutId) return false;
  if (args.toCommitIsBranchTip === false) return false;
  const reachesNewTip = args.toCommitRelationshipToNewTip === undefined
    ? recut.newTip.toLowerCase() === args.toCommit.toLowerCase()
    : args.toCommitRelationshipToNewTip === "same-commit" || args.toCommitRelationshipToNewTip === "descendant";
  return (
    normalizeStagingVersion(recut.fromVersion) === normalizeStagingVersion(args.fromVersion) &&
    recut.fromCommit.toLowerCase() === args.fromCommit.toLowerCase() &&
    reachesNewTip &&
    recut.branch === args.toBranch
  );
}

export function promotionAuthorizes(
  record: PostPromotionTrunkRecord | null,
  args: {
    fromVersion: string;
    fromCommit: string | null;
    toCommit: string | null;
    toBranch: string | null;
  }
): boolean {
  if (!record || !args.fromCommit || !args.toCommit || !args.toBranch) return false;
  const fromProductionVersion = normalizeStagingVersion(args.fromVersion).replace(/-staging\.\d+$/, "");
  return (
    normalizeStagingVersion(record.promotedVersion) === fromProductionVersion &&
    record.promotedTag === `v${fromProductionVersion}` &&
    record.promotedCommit.toLowerCase() === args.fromCommit.toLowerCase() &&
    record.newCommit.toLowerCase() === args.toCommit.toLowerCase() &&
    record.newBranch === args.toBranch
  );
}

export interface StagingPublishGateInput {
  /** `main` or `release/X.Y` — the branch the proposed RC is being built from. */
  proposedSourceBranch: string;
  proposedCommit: string;
  /** The candidate `desktop-staging` currently points at, or null for an empty channel. */
  active: StagingCandidate | null;
  /** How `proposedCommit` relates to `active.commit`, resolved by the caller from git. */
  relationship: StagingLineageRelationship;
  /** Whether the active candidate's production version has already been released. */
  activeProductionTagExists: boolean;
  /** Whether the active candidate's metadata could be resolved at all. */
  activeMetadataError: string | null;
  reset: LineageResetRecord | null;
  recut?: LineageRecutRecord | null;
  recutApplication?: LineageRecutApplicationRecord | null;
  /** Git-proven relationship from the recorded recut tip to the proposed commit. */
  recutDestinationRelationship?: StagingLineageRelationship;
  /** The proposed commit was checked against the freshly resolved branch tip. */
  recutDestinationIsBranchTip?: boolean;
  /** Present only after GitHub/tag identity and forward-trunk ancestry were verified. */
  postPromotion: PostPromotionTrunkRecord | null;
}

export interface StagingPublishGateDecision {
  allowed: boolean;
  reason: string | null;
  waivedByReset: boolean;
  authorizedByPromotion: boolean;
  authorizedByRecut: boolean;
  frozenBy: string | null;
}

const RESET_HINT = "kd release reset-staging --to <main|release/X.Y> --reason \"<why>\" --confirm-abandon <active-staging-version>";

export interface StagingFreezeDecision {
  active: boolean;
  branch: string | null;
  reason: string | null;
  waivedByReset: boolean;
  resetAuthorizesPublish: boolean;
}

export function evaluateStagingFreeze(
  input: Pick<
    StagingPublishGateInput,
    "proposedSourceBranch" | "active" | "activeProductionTagExists" | "reset"
  >
): StagingFreezeDecision {
  const active = input.active;
  const resetAuthorizesPublish = active
    ? resetAuthorizes(input.reset, {
        fromVersion: active.version,
        toBranch: input.proposedSourceBranch
      })
    : false;
  const branch = active?.sourceBranch ?? null;
  const wouldFreeze =
    active !== null &&
    isReleaseBranchName(branch) &&
    !input.activeProductionTagExists &&
    input.proposedSourceBranch === "main";

  if (!wouldFreeze) {
    return {
      active: false,
      branch: null,
      reason: null,
      waivedByReset: false,
      resetAuthorizesPublish
    };
  }

  if (resetAuthorizesPublish) {
    return {
      active: false,
      branch,
      reason:
        `${active.tag} is an unpromoted ${branch} release candidate, but the recorded staging lineage reset ` +
        "authorizes the next main staging publish, so the freeze is waived.",
      waivedByReset: true,
      resetAuthorizesPublish: true
    };
  }

  return {
    active: true,
    branch,
    reason:
      `${active.tag} is an unpromoted ${branch} release candidate, so staging is frozen to that branch. ` +
      `A main staging publish would repoint the single staging channel away from the RC mid-soak. ` +
      `Promote it (kd release promote ${active.version}), ship the next RC from ${branch}, ` +
      `or abandon the soak explicitly: ${RESET_HINT}.`,
    waivedByReset: false,
    resetAuthorizesPublish: false
  };
}

export function evaluateStagingPublishGate(input: StagingPublishGateInput): StagingPublishGateDecision {
  const active = input.active;

  // First, and before the empty-channel allowance: nothing below can be trusted
  // if the channel could not be read. A missing candidate with an error is a
  // channel we failed to read, not an empty one, and must never fall through to
  // "no active candidate, publish away".
  if (input.activeMetadataError) {
    return {
      allowed: false,
      waivedByReset: false,
      authorizedByPromotion: false,
      authorizedByRecut: false,
      frozenBy: null,
      reason:
        `Cannot verify staging lineage: ${active ? `the active candidate ${active.tag}` : "the staging channel"} ` +
        `could not be read (${input.activeMetadataError}). Refusing to move the channel blind. ` +
        `Retry once GitHub is reachable, restore the missing metadata, or abandon the lineage explicitly: ${RESET_HINT}.`
    };
  }

  if (!active) {
    return { allowed: true, reason: null, waivedByReset: false, authorizedByPromotion: false, authorizedByRecut: false, frozenBy: null };
  }

  const freeze = evaluateStagingFreeze({
    proposedSourceBranch: input.proposedSourceBranch,
    active,
    activeProductionTagExists: input.activeProductionTagExists,
    reset: input.reset
  });
  if (freeze.resetAuthorizesPublish) {
    return { allowed: true, reason: null, waivedByReset: true, authorizedByPromotion: false, authorizedByRecut: false, frozenBy: null };
  }

  if (freeze.active) {
    return {
      allowed: false,
      waivedByReset: false,
      authorizedByPromotion: false,
      authorizedByRecut: false,
      frozenBy: freeze.branch,
      reason: freeze.reason
    };
  }

  const authorizedByRecut = recutAuthorizes(input.recut ?? null, {
    fromVersion: active.version,
    fromCommit: active.commit,
    toCommit: input.proposedCommit,
    toBranch: input.proposedSourceBranch,
    application: input.recutApplication,
    toCommitRelationshipToNewTip: input.recutDestinationRelationship,
    toCommitIsBranchTip: input.recutDestinationIsBranchTip
  });

  switch (input.relationship) {
    case "same-commit":
    case "descendant":
      return { allowed: true, reason: null, waivedByReset: false, authorizedByPromotion: false, authorizedByRecut, frozenBy: null };
    case "behind":
      return {
        allowed: false,
        waivedByReset: false,
        authorizedByPromotion: false,
        authorizedByRecut: false,
        frozenBy: null,
        reason:
          `Refusing to roll the staging channel back. ${input.proposedCommit} is an ancestor of the active candidate ` +
          `${active.tag} (${active.commit ?? "unknown"}), so publishing it would move staging users backwards. ` +
          `Ship from a commit that contains ${active.tag}, repoint deliberately with ` +
          `kd release ship --staging --rollback-to <version>, or abandon the lineage: ${RESET_HINT}.`
      };
    case "diverged":
      if (
        input.activeProductionTagExists &&
        promotionAuthorizes(input.postPromotion, {
          fromVersion: active.version,
          fromCommit: active.commit,
          toCommit: input.proposedCommit,
          toBranch: input.proposedSourceBranch
        })
      ) {
        return {
          allowed: true,
          reason: null,
          waivedByReset: false,
          authorizedByPromotion: true,
          authorizedByRecut: false,
          frozenBy: null
        };
      }
      return {
        allowed: authorizedByRecut,
        waivedByReset: false,
        authorizedByPromotion: false,
        authorizedByRecut,
        frozenBy: null,
        reason: authorizedByRecut ? null :
          `Refusing to publish a staging candidate whose history diverged from the active channel. ` +
          `${input.proposedCommit} (${input.proposedSourceBranch}) and the active candidate ${active.tag} ` +
          `(${active.commit ?? "unknown"}, source ${active.sourceBranch ?? "unknown"}) share only an older merge base, ` +
          `so this build both adds and drops commits relative to what staging is running. ` +
          `Ship from a descendant of ${active.tag}, or abandon the lineage explicitly: ${RESET_HINT}.`
      };
    case "initial":
    case "unknown":
    default:
      return {
        allowed: false,
        waivedByReset: false,
        authorizedByPromotion: false,
        authorizedByRecut: false,
        frozenBy: null,
        reason:
          `Cannot compare ${input.proposedCommit} with the active candidate ${active.tag} ` +
          `(${active.commit ?? "unknown"}); git could not resolve one of the commits. ` +
          `Fetch the missing objects (git fetch --tags origin) and retry, or abandon the lineage: ${RESET_HINT}.`
      };
  }
}

export interface CandidateLineage {
  relationship: StagingLineageRelationship;
  previous: { version: string; tag: string; commit: string | null } | null;
  valid: boolean;
  authorizedByReset: boolean;
  authorizedByPromotion: boolean;
  authorizedByRecut: boolean;
  reset: LineageResetRecord | null;
  recut: LineageRecutRecord | null;
  recutApplication?: LineageRecutApplicationRecord | null;
  postPromotion: PostPromotionTrunkRecord | null;
  detail: string;
}

/**
 * Whether a candidate reached the channel by a legal move. A divergence is
 * valid only when a reset or verified post-promotion record authorized exactly
 * that move.
 */
export function evaluateCandidateLineage(args: {
  candidate: StagingCandidate;
  previous: { version: string; tag: string; commit: string | null } | null;
  relationship: StagingLineageRelationship;
  reset: LineageResetRecord | null;
  recut?: LineageRecutRecord | null;
  recutApplication?: LineageRecutApplicationRecord | null;
  recutDestinationRelationship?: StagingLineageRelationship;
  recutDestinationIsBranchTip?: boolean;
  postPromotion: PostPromotionTrunkRecord | null;
}): CandidateLineage {
  const { candidate, previous, relationship, reset, postPromotion } = args;
  const recut = args.recut ?? null;
  if (!previous) {
    return {
      relationship: "initial",
      previous: null,
      valid: true,
      authorizedByReset: false,
      authorizedByPromotion: false,
      authorizedByRecut: false,
      reset,
      recut,
      postPromotion,
      detail: `${candidate.tag} is the first staging candidate on this channel; there is no prior lineage to compare.`
    };
  }

  const authorizedByReset =
    (relationship === "diverged" || relationship === "behind") &&
    resetAuthorizes(reset, { fromVersion: previous.version, toBranch: candidate.sourceBranch ?? "" });
  const authorizedByPromotion =
    relationship === "diverged" &&
    promotionAuthorizes(postPromotion, {
      fromVersion: previous.version,
      fromCommit: previous.commit,
      toCommit: candidate.commit,
      toBranch: candidate.sourceBranch
    });
  const authorizedByRecut =
    (relationship === "same-commit" || relationship === "descendant" || relationship === "diverged") &&
    recutAuthorizes(recut, {
      fromVersion: previous.version,
      fromCommit: previous.commit,
      toCommit: candidate.commit,
      toBranch: candidate.sourceBranch,
      application: args.recutApplication,
      toCommitRelationshipToNewTip: args.recutDestinationRelationship,
      toCommitIsBranchTip: args.recutDestinationIsBranchTip
    });

  switch (relationship) {
    case "same-commit":
      return {
        relationship,
        previous,
        valid: true,
        authorizedByReset: false,
        authorizedByPromotion: false,
        authorizedByRecut,
        reset,
        recut,
        postPromotion,
        detail: `${candidate.tag} rebuilt the same commit as ${previous.tag}.`
      };
    case "descendant":
      return {
        relationship,
        previous,
        valid: true,
        authorizedByReset: false,
        authorizedByPromotion: false,
        authorizedByRecut,
        reset,
        recut,
        postPromotion,
        detail: `${candidate.tag} (${candidate.commit ?? "unknown"}) is a descendant of ${previous.tag} (${previous.commit ?? "unknown"}).`
      };
    case "behind":
      return {
        relationship,
        previous,
        valid: authorizedByReset,
        authorizedByReset,
        authorizedByPromotion: false,
        authorizedByRecut: false,
        reset,
        recut,
        postPromotion,
        detail: authorizedByReset
          ? `${candidate.tag} moved the channel backwards from ${previous.tag}, authorized by the recorded lineage reset of ${reset?.resetAt}.`
          : `${candidate.tag} (${candidate.commit ?? "unknown"}) is an ancestor of ${previous.tag} (${previous.commit ?? "unknown"}): the channel moved backwards with no recorded reset.`
      };
    case "diverged":
      return {
        relationship,
        previous,
        valid: authorizedByReset || authorizedByPromotion || authorizedByRecut,
        authorizedByReset,
        authorizedByPromotion,
        authorizedByRecut,
        reset,
        recut,
        postPromotion,
        detail: authorizedByReset
          ? `${candidate.tag} diverged from ${previous.tag}, authorized by the recorded lineage reset of ${reset?.resetAt}.`
          : authorizedByPromotion
          ? `${candidate.tag} resumed trunk after ${previous.tag} was promoted, authorized by the recorded post-promotion transition of ${postPromotion?.resumedAt}.`
          : `${candidate.tag} (${candidate.commit ?? "unknown"}) and ${previous.tag} (${previous.commit ?? "unknown"}) share only an older merge base: the channel moved non-linearly with no recorded authorization.`
      };
    case "initial":
    case "unknown":
    default:
      return {
        relationship: "unknown",
        previous,
        valid: false,
        authorizedByReset: false,
        authorizedByPromotion: false,
        authorizedByRecut: false,
        reset,
        recut,
        postPromotion,
        detail: `Could not compare ${candidate.tag} with ${previous.tag}; one of the commits is unavailable locally.`
      };
  }
}

export interface SoakEvaluation {
  requiredHours: number;
  elapsedHours: number | null;
  publishedAt: string | null;
  satisfied: boolean;
  overridden: boolean;
  overrideReason: string | null;
}

export function evaluateSoak(args: {
  requiredHours: number;
  publishedAt: string | null;
  nowMs: number;
  overrideReason?: string | null;
}): SoakEvaluation {
  const overrideReason = args.overrideReason?.trim() ? args.overrideReason.trim() : null;
  const publishedMs = args.publishedAt ? Date.parse(args.publishedAt) : Number.NaN;
  const elapsedHours = Number.isNaN(publishedMs)
    ? null
    : Math.round(Math.max(0, (args.nowMs - publishedMs) / 3_600_000) * 100) / 100;
  const met = args.requiredHours <= 0 ? true : elapsedHours !== null && elapsedHours >= args.requiredHours;
  return {
    requiredHours: args.requiredHours,
    elapsedHours,
    publishedAt: args.publishedAt,
    satisfied: met || overrideReason !== null,
    overridden: !met && overrideReason !== null,
    overrideReason
  };
}

export interface PromotionGateInput {
  rcTag: string;
  rcVersion: string;
  mechanical: { pushBranch: string | null; reason: string | null };
  lineage: CandidateLineage;
  soak: SoakEvaluation;
  /** Set when the candidate's series was deliberately abandoned. */
  abandonedSeries?: { branch: string; abandonedAt: string | null; reason: string | null } | null;
}

export interface PromotionGateDecision {
  allowed: boolean;
  blockers: string[];
}

export function evaluatePromotionGate(input: PromotionGateInput): PromotionGateDecision {
  const blockers: string[] = [];
  if (input.abandonedSeries) {
    blockers.push(
      `${input.abandonedSeries.branch} was abandoned` +
        `${input.abandonedSeries.abandonedAt ? ` on ${input.abandonedSeries.abandonedAt}` : ""}` +
        `${input.abandonedSeries.reason ? `: ${input.abandonedSeries.reason}` : "."} ` +
        "An abandoned series produces no production release; ship and promote the current series instead."
    );
  }
  if (!input.mechanical.pushBranch) {
    blockers.push(input.mechanical.reason ?? `${input.rcTag} is not at its promotion base.`);
  }
  if (!input.lineage.valid) {
    blockers.push(
      `${input.lineage.detail} Promoting it would ship a build that regresses the staging channel's own history. ` +
        `If that move was intended, record it with kd release reset-staging before shipping the candidate.`
    );
  }
  if (!input.soak.satisfied) {
    const elapsed = input.soak.elapsedHours;
    blockers.push(
      elapsed === null
        ? `${input.rcTag} has no readable publication time, so its ${input.soak.requiredHours}h soak cannot be verified. ` +
          `Override deliberately with kd release promote ${input.rcVersion} --override-soak "<reason>".`
        : `${input.rcTag} has soaked ${elapsed.toFixed(1)}h of the required ${input.soak.requiredHours}h. ` +
          `Wait, or override deliberately with kd release promote ${input.rcVersion} --override-soak "<reason>".`
    );
  }
  return { allowed: blockers.length === 0, blockers };
}
