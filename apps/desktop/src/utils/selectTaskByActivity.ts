export interface SelectableTask {
  id: string;
  activity: "working" | "unread" | "idle" | null;
  created_at: string;
}

export type TaskSelectionMode = "oldest" | "newest";
export type TaskSelectionActivity = NonNullable<SelectableTask["activity"]>;

export function selectTaskByActivity<T extends SelectableTask>(
  items: readonly T[],
  mode: TaskSelectionMode,
  activity: TaskSelectionActivity,
  anchorCreatedAt?: string | null,
): T | null {
  const matches = items.filter((item) => item.activity === activity);
  if (matches.length === 0) return null;

  const compare =
    mode === "oldest"
      ? (a: string, b: string) => a < b
      : (a: string, b: string) => a > b;

  if (anchorCreatedAt) {
    const relativeMatches = matches.filter((item) =>
      mode === "oldest"
        ? item.created_at < anchorCreatedAt
        : item.created_at > anchorCreatedAt,
    );
    if (relativeMatches.length > 0) {
      const relativeCompare =
        mode === "oldest"
          ? (a: string, b: string) => a > b
          : (a: string, b: string) => a < b;
      return relativeMatches.reduce((selected, candidate) =>
        relativeCompare(candidate.created_at, selected.created_at) ? candidate : selected,
      );
    }
  }

  return matches.reduce((selected, candidate) =>
    compare(candidate.created_at, selected.created_at) ? candidate : selected,
  );
}
