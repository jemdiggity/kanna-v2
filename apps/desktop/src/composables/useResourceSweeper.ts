import { onMounted, onUnmounted } from "vue"
import { invoke } from "@tauri-apps/api/core"
import type { DbHandle } from "@kanna/db"

export function useResourceSweeper(
  db: () => DbHandle | null,
  getPrefs: () => { suspendAfterMinutes: number; killAfterMinutes: number }
) {
  let intervalId: ReturnType<typeof setInterval> | null = null

  async function sweep() {
    const database = db()
    if (!database) return

    const prefs = getPrefs()
    try {
      // Get live sessions from daemon
      const sessions = await invoke<{ session_id: string; idle_seconds: number }[]>("list_sessions")

      for (const session of sessions) {
        const idleMinutes = session.idle_seconds / 60

        if (idleMinutes > prefs.killAfterMinutes) {
          await invoke("kill_session", { sessionId: session.session_id })
        } else if (idleMinutes > prefs.suspendAfterMinutes) {
          await invoke("signal_session", { sessionId: session.session_id, signal: "SIGTSTP" })
        }
      }

      // Clean up old merged/closed items (older than 3 days)
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
      const oldItems = await database.select<{ id: string; branch: string; repo_path: string }>(
        `SELECT pi.id, pi.branch, r.path as repo_path FROM pipeline_item pi
         JOIN repo r ON pi.repo_id = r.id
         WHERE pi.stage IN ('merged', 'closed')
         AND pi.updated_at < ?`,
        [threeDaysAgo]
      )

      for (const item of oldItems) {
        if (item.branch) {
          try {
            const worktreePath = `${item.repo_path}/.kanna-worktrees/${item.branch}`
            await invoke("git_worktree_remove", { repoPath: item.repo_path, path: worktreePath })
          } catch {
            // Worktree may already be removed
          }
        }
        await database.execute("DELETE FROM pipeline_item WHERE id = ?", [item.id])
      }
    } catch (e) {
      console.error("Resource sweep failed:", e)
    }
  }

  onMounted(() => {
    intervalId = setInterval(sweep, 60000)
  })

  onUnmounted(() => {
    if (intervalId) clearInterval(intervalId)
  })

  return { sweep }
}
