import type { PipelineItem } from "../types/kanna";

/**
 * Builds a stable fingerprint of the local open-task set for deciding whether a
 * cloud reconcile (publish) is needed. The desktop polls cloud tasks every
 * second to display peers' work; it must NOT re-publish its own snapshot on
 * every tick (that wrote `users/{uid}` once per second). Reconcile only when
 * this fingerprint changes.
 *
 * Deliberately excludes high-frequency, non-structural fields:
 * - `activity` (working/unread/idle) and `activity_changed_at` flip constantly
 *   while an agent runs and would otherwise re-trigger a full republish.
 * - `updated_at` changes on every row touch.
 *
 * Includes the structural fields that change what a peer should see: stage, PR,
 * branch, base ref, display name, and open/closed membership.
 */
export function computeTaskSnapshotFingerprint(items: readonly PipelineItem[]): string {
  return items
    .filter((item) => item.closed_at === null)
    .map((item) =>
      JSON.stringify([
        item.id,
        item.repo_id,
        item.stage,
        item.pr_number,
        item.pr_url,
        item.branch,
        item.base_ref,
        item.display_name,
      ]),
    )
    .sort()
    .join("\n");
}
