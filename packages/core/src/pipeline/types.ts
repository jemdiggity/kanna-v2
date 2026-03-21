export type Stage = "in_progress" | "pr" | "merge" | "done" | "blocked";

export const VALID_TRANSITIONS = [
  { from: "in_progress", to: "pr" },
  { from: "in_progress", to: "done" },
  { from: "in_progress", to: "merge" },
  { from: "pr", to: "done" },
  { from: "merge", to: "done" },
  { from: "blocked", to: "in_progress" },
  { from: "blocked", to: "done" },
] as const;

export type ValidTransition = (typeof VALID_TRANSITIONS)[number];
