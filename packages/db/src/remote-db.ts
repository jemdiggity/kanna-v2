import type { DbHandle } from "./queries.js";

/**
 * Remote DB handle that routes SQL queries through Tauri invoke
 * to kanna-server via the relay. Used on mobile where there's
 * no local SQLite database.
 */
export function createRemoteDbHandle(
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): DbHandle {
  return {
    async execute(
      query: string,
      bindValues?: unknown[],
    ): Promise<{ rowsAffected: number }> {
      const result = await invoke("db_execute", {
        query,
        bindValues: bindValues ?? [],
      });
      return result as { rowsAffected: number };
    },
    async select<T>(query: string, bindValues?: unknown[]): Promise<T[]> {
      const result = await invoke("db_select", {
        query,
        bindValues: bindValues ?? [],
      });
      return result as T[];
    },
  };
}
