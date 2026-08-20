import type { TaskTerminalStatus } from "../state/sessionStore";
import {
  sliceTerminalOutput,
  terminalOutputLength,
  type TerminalOutputLike
} from "../state/terminalOutputBuffer";

export type TerminalMutation =
  | {
      kind: "none";
    }
  | {
      kind: "replace";
      output: TerminalOutputLike;
      status: TaskTerminalStatus;
    }
  /** The buffer grew upward: older scrollback arrived above what is loaded, so
   * it is rewritten without snapping the reader back to the bottom. */
  | {
      kind: "prepend";
      output: TerminalOutputLike;
      status: TaskTerminalStatus;
    }
  | {
      kind: "append";
      chunk: string;
    };

interface PlanTerminalMutationOptions {
  previousEpoch: number;
  previousOutput: TerminalOutputLike;
  previousStart: number;
  previousStatus: TaskTerminalStatus;
  nextEpoch: number;
  nextOutput: TerminalOutputLike;
  nextStart: number;
  nextStatus: TaskTerminalStatus;
  /** This revision is a scrollback splice, not a fresh terminal state. */
  nextPrependedScrollback?: boolean;
}

export function planTerminalMutation({
  previousEpoch,
  previousOutput,
  previousStart,
  previousStatus,
  nextEpoch,
  nextOutput,
  nextStart,
  nextStatus,
  nextPrependedScrollback = false
}: PlanTerminalMutationOptions): TerminalMutation {
  if (nextEpoch !== previousEpoch) {
    return {
      kind: nextPrependedScrollback ? "prepend" : "replace",
      output: nextOutput,
      status: nextStatus
    };
  }

  const previousOutputLength = terminalOutputLength(previousOutput);
  const nextOutputLength = terminalOutputLength(nextOutput);
  const previousEnd = previousStart + previousOutputLength;
  const nextEnd = nextStart + nextOutputLength;

  if (previousEnd === nextEnd) {
    if (nextOutputLength === 0 && nextStatus !== previousStatus) {
      return {
        kind: "replace",
        output: nextOutput,
        status: nextStatus
      };
    }

    return { kind: "none" };
  }

  if (previousOutputLength === 0) {
    return {
      kind: "replace",
      output: nextOutput,
      status: nextStatus
    };
  }

  if (previousEnd >= nextStart && previousEnd <= nextEnd) {
    return {
      kind: "append",
      chunk: sliceTerminalOutput(nextOutput, previousEnd - nextStart)
    };
  }

  return {
    kind: "replace",
    output: nextOutput,
    status: nextStatus
  };
}
