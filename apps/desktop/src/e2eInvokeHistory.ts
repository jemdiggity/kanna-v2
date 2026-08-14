import { redactE2EInvokeArgs } from "./e2eInvokeRedaction";

export interface E2EInvokeRecord {
  cmd: string;
  args?: unknown;
}

const invokeRecords: E2EInvokeRecord[] = [];
const invokeFailures = new Map<string, string[]>();
const invokeSuccesses = new Map<string, unknown[]>();

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
    invokeSuccesses.clear();
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
  succeedNext(cmd: string, value: unknown) {
    const successes = invokeSuccesses.get(cmd) ?? [];
    successes.push(cloneJson(value));
    invokeSuccesses.set(cmd, successes);
  },
  consumeFailure(cmd: string): string | null {
    const failures = invokeFailures.get(cmd);
    const message = failures?.shift() ?? null;
    if (failures?.length === 0) invokeFailures.delete(cmd);
    return message;
  },
  consumeSuccess(cmd: string): { matched: boolean; value: unknown } {
    const successes = invokeSuccesses.get(cmd);
    if (!successes || successes.length === 0) {
      return { matched: false, value: undefined };
    }
    const value = successes.shift();
    if (successes.length === 0) invokeSuccesses.delete(cmd);
    return { matched: true, value: cloneJson(value) };
  },
};
