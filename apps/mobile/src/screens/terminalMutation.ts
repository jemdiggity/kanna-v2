import type { TaskTerminalStatus } from "../state/sessionStore";

export type TerminalMutation =
  | {
      kind: "none";
    }
  | {
      kind: "replace";
      output: string;
      status: TaskTerminalStatus;
    }
  | {
      kind: "append";
      chunk: string;
    };

interface PlanTerminalMutationOptions {
  previousEpoch: number;
  previousOutput: string;
  previousStart: number;
  previousStatus: TaskTerminalStatus;
  nextEpoch: number;
  nextOutput: string;
  nextStart: number;
  nextStatus: TaskTerminalStatus;
}

export function planTerminalMutation({
  previousEpoch,
  previousOutput,
  previousStart,
  previousStatus,
  nextEpoch,
  nextOutput,
  nextStart,
  nextStatus
}: PlanTerminalMutationOptions): TerminalMutation {
  if (nextEpoch !== previousEpoch) {
    return {
      kind: "replace",
      output: nextOutput,
      status: nextStatus
    };
  }

  const previousEnd = previousStart + previousOutput.length;
  const nextEnd = nextStart + nextOutput.length;

  if (previousEnd === nextEnd) {
    if (!nextOutput.trim() && nextStatus !== previousStatus) {
      return {
        kind: "replace",
        output: nextOutput,
        status: nextStatus
      };
    }

    return { kind: "none" };
  }

  if (!previousOutput.trim()) {
    return {
      kind: "replace",
      output: nextOutput,
      status: nextStatus
    };
  }

  if (previousEnd >= nextStart && previousEnd <= nextEnd) {
    return {
      kind: "append",
      chunk: nextOutput.slice(previousEnd - nextStart)
    };
  }

  return {
    kind: "replace",
    output: nextOutput,
    status: nextStatus
  };
}
