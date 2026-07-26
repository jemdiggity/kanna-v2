export interface E2EEventRecord {
  event: string;
  payload?: unknown;
}

const MAX_EVENT_RECORDS = 200;
const eventRecords: E2EEventRecord[] = [];

function cloneJson(value: unknown): unknown {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export const e2eEventHistory = {
  record(event: string, payload?: unknown) {
    eventRecords.push({ event, payload: cloneJson(payload) });
    if (eventRecords.length > MAX_EVENT_RECORDS) {
      eventRecords.splice(0, eventRecords.length - MAX_EVENT_RECORDS);
    }
  },
  clear() {
    eventRecords.length = 0;
  },
  getAll(): E2EEventRecord[] {
    return eventRecords.map((record) => ({
      event: record.event,
      payload: cloneJson(record.payload),
    }));
  },
};
