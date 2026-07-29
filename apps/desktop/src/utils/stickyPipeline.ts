/**
 * The pipeline a new task in this repo should default to.
 *
 * Sticky selection: the repo's most recently used pipeline wins over the
 * pipeline its `.kanna/config.json` configures, so repeated work in a repo
 * keeps the depth of review the operator last chose.
 *
 * `recentPipelines` is newest-first and may name pipelines the repo no longer
 * offers (renamed, deleted, or created against a different checkout), so the
 * first name that is still selectable wins rather than only the newest one.
 * With no usable recent name this falls back to the repo's configured default.
 */
export function resolveStickyPipelineDefault(
  availablePipelines: readonly string[],
  recentPipelines: readonly string[],
  configuredDefault: string | undefined,
): string | undefined {
  const available = new Set(availablePipelines);
  return recentPipelines.find((name) => available.has(name)) ?? configuredDefault;
}
