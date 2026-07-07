import type { PipelineItem } from "../types/kanna";

export function isBlockerResolved(
  blocker: Pick<PipelineItem, "closed_at" | "stage" | "pr_url">,
): boolean {
  return blocker.closed_at != null || (blocker.stage === "pr" && blocker.pr_url != null);
}
