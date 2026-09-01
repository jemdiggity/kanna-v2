import type { TaskSummary } from "./types";
import { displayTaskId } from "./taskIdentity";

/** Task ids are cross-system identifiers, so partial-id matching is literal. */
export function taskMatchesSearchQuery(
  task: TaskSummary,
  query: string
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  // Collection transports historically treat an empty query as "list all";
  // the Search screen's controller still clears its results before calling.
  if (!normalizedQuery) return true;

  return [
    displayTaskId(task),
    task.title,
    task.waitingPromptSnippet
  ].some(
    (field) => field?.toLowerCase().includes(normalizedQuery) === true
  );
}
