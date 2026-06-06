export interface E2EInvokeRecord {
  cmd: string;
  args?: unknown;
}

const invokeRecords: E2EInvokeRecord[] = [];

function cloneJson(value: unknown): unknown {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export const e2eInvokeHistory = {
  record(cmd: string, args?: unknown) {
    invokeRecords.push({ cmd, args: cloneJson(args) });
  },
  clear() {
    invokeRecords.length = 0;
  },
  getAll(): E2EInvokeRecord[] {
    return invokeRecords.map((record) => ({
      cmd: record.cmd,
      args: cloneJson(record.args),
    }));
  },
};
