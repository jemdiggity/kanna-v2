/**
 * Mock Tauri APIs for browser-mode development/testing.
 * When running outside the Tauri webview (e.g. via Playwright or plain browser),
 * this provides in-memory fallbacks so the app is fully interactive.
 */

export const isTauri = !!(window as any).__TAURI_INTERNALS__;

type Row = Record<string, unknown>;

// In-memory SQLite mock
const tables: Record<string, Row[]> = {};

function ensureTable(name: string) {
  if (!tables[name]) tables[name] = [];
}

function parseTableName(sql: string): string | null {
  const m = sql.match(/(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(\w+)/i);
  return m ? m[1] : null;
}

class MockDatabase {
  async execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }> {
    const table = parseTableName(query);
    if (!table) return { rowsAffected: 0 };
    ensureTable(table);

    const upper = query.trim().toUpperCase();

    if (upper.startsWith("CREATE TABLE")) {
      // No-op, table "exists" in memory
      return { rowsAffected: 0 };
    }

    if (upper.startsWith("INSERT")) {
      const vals = bindValues ?? [];
      // Very simplified: parse column names from INSERT INTO table (cols) VALUES (?)
      const colMatch = query.match(/\(([^)]+)\)\s*VALUES/i);
      if (colMatch) {
        const cols = colMatch[1].split(",").map((c) => c.trim());
        const row: Row = {};
        cols.forEach((col, i) => {
          row[col] = vals[i] ?? null;
        });
        // Handle OR IGNORE / OR REPLACE
        if (upper.includes("OR IGNORE") || upper.includes("OR REPLACE")) {
          const pk = cols[0]; // assume first col is PK
          const existing = tables[table].findIndex((r) => r[pk] === row[pk]);
          if (upper.includes("OR REPLACE") && existing >= 0) {
            tables[table][existing] = row;
          } else if (existing < 0) {
            tables[table].push(row);
          }
        } else {
          tables[table].push(row);
        }
      }
      return { rowsAffected: 1 };
    }

    // Handle pin/unpin updates — must be before generic UPDATE handler
    if (upper.startsWith("UPDATE") && query.includes("pinned = 1")) {
      const whereMatch = query.match(/WHERE\s+id\s*=\s*\?/i);
      if (whereMatch && bindValues) {
        const pinOrder = bindValues[0];
        const id = bindValues[1];
        for (const row of tables[table]) {
          if (row["id"] === id) {
            row["pinned"] = 1;
            row["pin_order"] = pinOrder;
            row["updated_at"] = new Date().toISOString();
          }
        }
        return { rowsAffected: 1 };
      }
    }

    if (upper.startsWith("UPDATE") && query.includes("pinned = 0")) {
      const whereMatch = query.match(/WHERE\s+id\s*=\s*\?/i);
      if (whereMatch && bindValues) {
        const id = bindValues[0];
        for (const row of tables[table]) {
          if (row["id"] === id) {
            row["pinned"] = 0;
            row["pin_order"] = null;
            row["updated_at"] = new Date().toISOString();
          }
        }
        return { rowsAffected: 1 };
      }
    }

    if (upper.startsWith("UPDATE") && query.includes("CASE")) {
      // Bulk reorder — best-effort for mock
      if (bindValues) {
        const n = Math.round(bindValues.length / 3);
        for (let i = 0; i < n; i++) {
          const id = bindValues[i * 2] as string;
          const order = bindValues[i * 2 + 1] as number;
          for (const row of tables[table]) {
            if (row["id"] === id) {
              row["pin_order"] = order;
              row["updated_at"] = new Date().toISOString();
            }
          }
        }
        return { rowsAffected: n };
      }
    }

    if (upper.startsWith("UPDATE")) {
      // Simplified: UPDATE table SET col = ? WHERE id = ?
      const setMatch = query.match(/SET\s+(.+?)\s+WHERE/i);
      const whereMatch = query.match(/WHERE\s+(\w+)\s*=\s*\?/i);
      if (setMatch && whereMatch && bindValues) {
        const setClauses = setMatch[1].split(",").map((s) => s.trim());
        const whereCol = whereMatch[1];
        const whereVal = bindValues[bindValues.length - 1];
        let affected = 0;
        for (const row of tables[table]) {
          if (row[whereCol] === whereVal) {
            let valIdx = 0;
            for (const clause of setClauses) {
              const eqMatch = clause.match(/(\w+)\s*=\s*(.+)/);
              if (eqMatch) {
                const col = eqMatch[1];
                const valExpr = eqMatch[2].trim();
                if (valExpr === "?") {
                  row[col] = bindValues[valIdx++];
                } else if (valExpr.includes("datetime")) {
                  row[col] = new Date().toISOString();
                }
              }
            }
            affected++;
          }
        }
        return { rowsAffected: affected };
      }
      return { rowsAffected: 0 };
    }

    if (upper.startsWith("DELETE")) {
      const whereMatch = query.match(/WHERE\s+(\w+)\s*=\s*\?/i);
      if (whereMatch && bindValues) {
        const col = whereMatch[1];
        const val = bindValues[0];
        const before = tables[table].length;
        tables[table] = tables[table].filter((r) => r[col] !== val);
        return { rowsAffected: before - tables[table].length };
      }
      return { rowsAffected: 0 };
    }

    return { rowsAffected: 0 };
  }

  async select<T>(query: string, bindValues?: unknown[]): Promise<T[]> {
    const table = parseTableName(query);
    if (!table) return [];
    ensureTable(table);

    const upper = query.trim().toUpperCase();
    let rows = [...tables[table]];

    // Simple WHERE col = ? filtering
    const whereMatch = query.match(/WHERE\s+(\w+)\s*=\s*\?/i);
    if (whereMatch && bindValues?.length) {
      const col = whereMatch[1];
      const val = bindValues[0];
      rows = rows.filter((r) => r[col] === val);
    }

    // WHERE col IS NOT NULL
    const notNullMatch = query.match(/WHERE\s+(\w+)\s+IS\s+NOT\s+NULL/i);
    if (notNullMatch) {
      const col = notNullMatch[1];
      rows = rows.filter((r) => r[col] != null);
    }

    // ORDER BY ... DESC
    if (upper.includes("ORDER BY") && upper.includes("DESC")) {
      rows.reverse();
    }

    return rows as T[];
  }
}

// Mock invoke for Tauri commands
const invokeHandlers: Record<string, (...args: any[]) => any> = {
  list_sessions: () => [],
  spawn_session: () => ({}),
  attach_session: () => ({}),
  detach_session: () => ({}),
  send_input: () => ({}),
  resize_session: () => ({}),
  signal_session: () => ({}),
  kill_session: () => ({}),
  git_diff: () => "",
  git_default_branch: () => "main",
  git_remote_url: () => "https://github.com/example/repo.git",
  git_worktree_add: () => ({}),
  git_worktree_remove: () => ({}),
  git_worktree_list: () => [],
  git_log: () => [],
  git_graph: () => [
    { hash: "abc1234567890", short_hash: "abc1234", message: "feat: add commit graph", author: "Dev", timestamp: Date.now() / 1000, parents: ["def5678901234"] },
    { hash: "def5678901234", short_hash: "def5678", message: "fix: resolve issue", author: "Dev", timestamp: Date.now() / 1000 - 3600, parents: ["ghi9012345678"] },
    { hash: "ghi9012345678", short_hash: "ghi9012", message: "initial commit", author: "Dev", timestamp: Date.now() / 1000 - 7200, parents: [] },
  ],
  git_push: () => ({}),
  file_exists: () => true,
  read_text_file: () => "",
  get_app_data_dir: () => "/tmp/kanna-mock-data",
  get_claude_usage: () => "",
  copy_file: () => ({}),
  remove_file: () => ({}),
  list_dir: () => [],
  read_dir_entries: () => [
    { name: "src", is_dir: true },
    { name: "components", is_dir: true },
    { name: "composables", is_dir: true },
    { name: "stores", is_dir: true },
    { name: "App.vue", is_dir: false },
    { name: "main.ts", is_dir: false },
  ],
  which_binary: () => "/usr/local/bin/claude",
  run_script: () => "",
  append_log: () => ({}),
  // Claude agent SDK commands
  create_agent_session: () => ({ session_id: "mock-session" }),
  send_agent_message: () => ({}),
  abort_agent_session: () => ({}),
  destroy_agent_session: () => ({}),
  // Test harness commands (mirror the Rust test-harness feature)
  test_list_agent_sessions: () => [],
  test_get_agent_session: () => ({ session_id: "", buffer_len: 0, finished: true }),
  test_peek_agent_buffer: () => [],
  test_daemon_connected: () => ({ connected: false }),
  test_daemon_sessions: () => ({ type: "SessionList", sessions: [] }),
  test_query_db: (_args: any) => {
    const table = _args?.query?.match(/FROM\s+(\w+)/i)?.[1];
    if (table && tables[table]) {
      return { columns: Object.keys(tables[table][0] ?? {}), rows: tables[table] };
    }
    return { columns: [], rows: [] };
  },
  test_state_snapshot: () => ({
    agent_sessions: [],
    daemon: { connected: false },
  }),
};

export function mockInvoke(cmd: string, args?: any): any {
  const handler = invokeHandlers[cmd];
  if (handler) return handler(args);
  console.warn(`[tauri-mock] unhandled invoke: ${cmd}`, args);
  return {};
}

let mockDb: MockDatabase | null = null;

export function getMockDatabase(): MockDatabase {
  if (!mockDb) mockDb = new MockDatabase();
  return mockDb;
}

// Mock listen — returns a no-op unlisten function
export function mockListen(_event: string, _handler: (event: any) => void): Promise<() => void> {
  return Promise.resolve(() => {});
}

// Mock dialog open — prompts via browser prompt()
export async function mockDialogOpen(_opts?: any): Promise<string | null> {
  return window.prompt("Enter directory path (browser mock):", "/Users/jeremyhale/Documents/work/jemdiggity/kanna");
}
