import { VALID_TRANSITIONS, type Stage, type ValidTransition } from "./types.js";

export function canTransition(from: Stage, to: Stage): boolean {
  return VALID_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

export function getTransition(
  from: Stage,
  to: Stage
): ValidTransition | undefined {
  return VALID_TRANSITIONS.find((t) => t.from === from && t.to === to);
}
