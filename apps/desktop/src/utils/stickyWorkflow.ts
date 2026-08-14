/**
 * The workflow a new task in this repo should default to.
 *
 * Sticky selection: the repo's most recently used workflow wins over the
 * workflow its `.kanna/config.json` configures, so repeated work in a repo
 * keeps the depth of review the operator last chose.
 *
 * `recentWorkflows` is newest-first and may name workflows the repo no longer
 * offers (renamed, deleted, or created against a different checkout), so the
 * first name that is still selectable wins rather than only the newest one.
 * Retired built-in names (`default`, `qa`, …) never reach here: the server
 * serves them from `/recent-workflows` already canonicalized to the current
 * built-in name, which is why a pre-rename row still sticks instead of being
 * skipped. With no usable recent name this falls back to the repo's
 * configured default.
 */
export function resolveStickyWorkflowDefault(
  availableWorkflows: readonly string[],
  recentWorkflows: readonly string[],
  configuredDefault: string | undefined,
): string | undefined {
  const available = new Set(availableWorkflows);
  return recentWorkflows.find((name) => available.has(name)) ?? configuredDefault;
}
