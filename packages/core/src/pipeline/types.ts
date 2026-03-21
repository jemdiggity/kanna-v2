export type Stage = "in_progress" | "pr" | "done";

export const VALID_TRANSITIONS = [
  { from: "in_progress", to: "pr" },
  { from: "in_progress", to: "done" },
  { from: "pr", to: "done" },
] as const;

export type ValidTransition = (typeof VALID_TRANSITIONS)[number];
