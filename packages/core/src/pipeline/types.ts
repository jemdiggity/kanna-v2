export type Stage = "queued" | "in_progress" | "needs_review" | "merged" | "closed";

export const VALID_TRANSITIONS = [
  { from: "queued", to: "in_progress", label: "kn:wip" },
  { from: "in_progress", to: "needs_review", label: "kn:pr-ready" },
  { from: "needs_review", to: "merged" },
  { from: "needs_review", to: "closed" },
  { from: "in_progress", to: "closed" },
  { from: "queued", to: "closed" },
] as const;

export type ValidTransition = (typeof VALID_TRANSITIONS)[number];
