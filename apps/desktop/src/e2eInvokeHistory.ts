import { redactE2EInvokeArgs } from "./e2eInvokeRedaction";

export interface E2EInvokeRecord {
  cmd: string;
  args?: unknown;
}

const invokeRecords: E2EInvokeRecord[] = [];
const invokeFailures = new Map<string, string[]>();

function cloneJson(value: unknown): unknown {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export const e2eInvokeHistory = {
  record(cmd: string, args?: unknown) {
    invokeRecords.push({
      cmd,
      args: cloneJson(redactE2EInvokeArgs(cmd, args)),
    });
  },
  clear() {
    invokeRecords.length = 0;
    invokeFailures.clear();
  },
  getAll(): E2EInvokeRecord[] {
    return invokeRecords.map((record) => ({
      cmd: record.cmd,
      args: cloneJson(record.args),
    }));
  },
  failNext(cmd: string, message: string) {
    const failures = invokeFailures.get(cmd) ?? [];
    failures.push(message);
    invokeFailures.set(cmd, failures);
  },
  consumeFailure(cmd: string): string | null {
    const failures = invokeFailures.get(cmd);
    const message = failures?.shift() ?? null;
    if (failures?.length === 0) invokeFailures.delete(cmd);
    return message;
  },
};
