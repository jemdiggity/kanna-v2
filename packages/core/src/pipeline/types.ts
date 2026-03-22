export const SYSTEM_TAGS = ["done", "pr", "merge", "blocked"] as const;
export type SystemTag = (typeof SYSTEM_TAGS)[number];

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); }
  catch { return []; }
}

export function hasTag(item: { tags: string }, tag: string): boolean {
  return parseTags(item.tags).includes(tag);
}
