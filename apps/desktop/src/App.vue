<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { isTauri, getMockDatabase } from "./tauri-mock";
import { invoke } from "./invoke";
import { listen } from "./listen";
import type { DbHandle, PipelineItem } from "@kanna/db";
import { listPipelineItems, updatePipelineItemStage, updatePipelineItemActivity, getSetting, setSetting } from "@kanna/db";
import { parseRepoConfig, type Stage } from "@kanna/core";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import ImportRepoModal from "./components/ImportRepoModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.vue";
import FilePickerModal from "./components/FilePickerModal.vue";
import FilePreviewModal from "./components/FilePreviewModal.vue";
import DiffModal from "./components/DiffModal.vue";
import ShellModal from "./components/ShellModal.vue";
import CommandPaletteModal from "./components/CommandPaletteModal.vue";
import { useRepo } from "./composables/useRepo";
import { usePipeline } from "./composables/usePipeline";
import { usePreferences } from "./composables/usePreferences";
import { useKeyboardShortcuts, type ActionName } from "./composables/useKeyboardShortcuts";
import { useResourceSweeper } from "./composables/useResourceSweeper";

const db = ref<DbHandle | null>(null);

const { repos, selectedRepoId, refresh: refreshRepos, importRepo } = useRepo(db);
const { items, selectedItemId, loadItems, transition, createItem, spawnPtySession, startPrAgent, selectedItem, pinItem, unpinItem, reorderPinned, renameItem } = usePipeline(db);
const {
  suspendAfterMinutes,
  killAfterMinutes,

  ideCommand,
  gcAfterDays,
  load: loadPreferences,
  save: savePreference,
} = usePreferences(db);

// Resource sweeper disabled — corrupts daemon command connection
// useResourceSweeper(
//   () => db.value,
//   () => ({
//     suspendAfterMinutes: suspendAfterMinutes.value,
//     killAfterMinutes: killAfterMinutes.value,
//   })
// );

const selectedRepo = computed(() =>
  repos.value.find((r) => r.id === selectedRepoId.value) ?? null
);

const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const showPreferencesPanel = ref(false);
const showShortcutsModal = ref(false);
const showFilePickerModal = ref(false);
const showFilePreviewModal = ref(false);
const previewFilePath = ref("");
const showDiffModal = ref(false);
const showShellModal = ref(false);
const showCommandPalette = ref(false);
const diffScopes = new Map<string, "branch" | "commit" | "working">();
const zenMode = ref(false);
const maximized = ref(false);

const currentItem = computed(() => {
  const item = selectedItem();
  return item && item.stage !== "done" ? item : null;
});

// Load pipeline items when selected repo changes
watch(selectedRepoId, async (repoId) => {
  if (repoId) {
    await loadItems(repoId);
  } else {
    items.value = [];
    selectedItemId.value = null;
  }
});

// All pipeline items across all repos for sidebar display
const allItems = ref<PipelineItem[]>([]);

async function refreshAllItems() {
  if (!db.value) return;
  const allLoaded: PipelineItem[] = [];
  for (const repo of repos.value) {
    const repoItems = await listPipelineItems(db.value, repo.id);
    allLoaded.push(...repoItems);
  }
  allItems.value = allLoaded;
}

watch([repos, selectedRepoId], refreshAllItems, { immediate: true });

// Sort items the same way the sidebar does
function sortedItemsForCurrentRepo(): PipelineItem[] {
  const activityOrder: Record<string, number> = { idle: 0, unread: 1, working: 2 };
  return allItems.value
    .filter((item) => item.repo_id === selectedRepoId.value && item.stage !== "done")
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return b.pinned - a.pinned;
      if (a.pinned && b.pinned) return (a.pin_order ?? 0) - (b.pin_order ?? 0);
      const ao = activityOrder[a.activity || "idle"] ?? 0;
      const bo = activityOrder[b.activity || "idle"] ?? 0;
      if (ao !== bo) return ao - bo;
      const aTime = a.activity_changed_at || a.created_at;
      const bTime = b.activity_changed_at || b.created_at;
      return bTime.localeCompare(aTime);
    });
}

// Keyboard shortcuts
function navigateItems(direction: -1 | 1) {
  const currentItems = sortedItemsForCurrentRepo();
  if (currentItems.length === 0) return;

  const currentIndex = currentItems.findIndex((i) => i.id === selectedItemId.value);
  let nextIndex: number;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = currentIndex + direction;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= currentItems.length) nextIndex = currentItems.length - 1;
  }
  selectedItemId.value = currentItems[nextIndex].id;
}

async function handleCloseTask() {
  const item = selectedItem();
  if (!item || !selectedRepo.value) return;
  try {
    // Kill sessions
    await invoke("kill_session", { sessionId: item.id }).catch(() => {});
    await invoke("kill_session", { sessionId: `shell-${item.id}` }).catch(() => {});

    // Run teardown scripts if transitioning from in_progress
    if (item.stage === "in_progress") {
      const worktreePath = `${selectedRepo.value.path}/.kanna-worktrees/${item.branch}`;
      try {
        const configContent = await invoke<string>("read_text_file", {
          path: `${selectedRepo.value.path}/.kanna/config.json`,
        });
        if (configContent) {
          const repoConfig = parseRepoConfig(configContent);
          if (repoConfig.teardown?.length) {
            for (const cmd of repoConfig.teardown) {
              await invoke("run_script", { script: cmd, cwd: worktreePath, env: {} });
            }
          }
        }
      } catch { /* teardown failed — continue closing */ }
    }

    // Mark as done
    await updatePipelineItemStage(db.value!, item.id, "done");
    const currentItems = sortedItemsForCurrentRepo();
    const remaining = currentItems.filter((i) => i.id !== item.id);
    const firstRead = remaining.find((i) => (i as any).activity === "idle" || !(i as any).activity);
    selectedItemId.value = (firstRead || remaining[0])?.id || null;
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("Close failed:", e);
  }
}

const keyboardActions = {
  newTask: () => { showNewTaskModal.value = true; },
  newWindow: async () => {
    if (isTauri) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      new WebviewWindow(`window-${Date.now()}`, {
        url: "/",
        title: "",
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
      });
    } else {
      window.open(window.location.href, "_blank");
    }
  },
  openFile: () => {
    if (showFilePreviewModal.value) {
      showFilePreviewModal.value = false;
      showFilePickerModal.value = true;
    } else {
      showFilePickerModal.value = !showFilePickerModal.value;
    }
  },
  openInIDE: async () => {
    const item = currentItem.value;
    if (!item?.branch || !selectedRepo.value) return;
    const worktreePath = `${selectedRepo.value.path}/.kanna-worktrees/${item.branch}`;
    await invoke("run_script", { script: `${ideCommand.value} "${worktreePath}"`, cwd: worktreePath, env: {} }).catch(() => {});
  },
  makePR: async () => {
    const item = selectedItem();
    if (!item) return;
    try {
      await startPrAgent(item.id);
      await refreshAllItems();
    } catch (e) {
      console.error("PR agent failed to start:", e);
    }
  },
  closeTask: handleCloseTask,
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  toggleZen: () => { zenMode.value = !zenMode.value; },
  toggleMaximize: () => { maximized.value = !maximized.value; },
  dismiss: () => {
    if (showCommandPalette.value) { showCommandPalette.value = false; return; }
    if (showShortcutsModal.value) { showShortcutsModal.value = false; return; }
    if (showFilePreviewModal.value) { showFilePreviewModal.value = false; return; }
    if (showFilePickerModal.value) { showFilePickerModal.value = false; return; }
    if (showDiffModal.value) { showDiffModal.value = false; maximized.value = false; return; }
    // Shell modal: Escape goes to the terminal inside it; close with Cmd+J
    if (showShellModal.value) { return; }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; return; }
    if (showImportRepoModal.value) { showImportRepoModal.value = false; return; }
    if (showPreferencesPanel.value) { showPreferencesPanel.value = false; return; }
  },
  openShell: () => { showShellModal.value = !showShellModal.value; },
  showDiff: () => { showDiffModal.value = !showDiffModal.value; },
  showShortcuts: () => { showShortcutsModal.value = !showShortcutsModal.value; },
  openPreferences: () => { showPreferencesPanel.value = true; },
  commandPalette: () => { showCommandPalette.value = !showCommandPalette.value; },
};
useKeyboardShortcuts(keyboardActions);

function focusAgentTerminal() {
  nextTick(() => {
    const el = document.querySelector(".main-panel .xterm-helper-textarea") as HTMLElement | null;
    el?.focus();
  });
}

// Handlers
async function handleSelectRepo(repoId: string) {
  selectedRepoId.value = repoId;
  if (db.value) setSetting(db.value, "selected_repo_id", repoId);
}

function handleSelectItem(itemId: string) {
  selectedItemId.value = itemId;
  if (db.value) setSetting(db.value, "selected_item_id", itemId);
  // Mark as read if unread
  const item = allItems.value.find((i) => i.id === itemId);
  if (item && item.activity === "unread" && db.value) {
    updatePipelineItemActivity(db.value, itemId, "idle");
    item.activity = "idle";
  }
}

async function handleNewTaskSubmit(prompt: string) {
  if (!selectedRepoId.value) {
    // Auto-select the first repo if only one exists
    if (repos.value.length === 1) {
      selectedRepoId.value = repos.value[0].id;
    } else {
      alert("Select a repository first");
      return;
    }
  }
  const repo = repos.value.find((r) => r.id === selectedRepoId.value);
  if (!repo) return;
  try {
    await createItem(selectedRepoId.value, repo.path, prompt);
    showNewTaskModal.value = false;
    await refreshAllItems();
  } catch (e: any) {
    console.error("Task creation failed:", e);
    alert(`Task creation failed: ${e?.message || e}`);
  }
}

async function handlePinItem(itemId: string, position: number) {
  await pinItem(itemId, position);
  await refreshAllItems();
}

async function handleUnpinItem(itemId: string) {
  await unpinItem(itemId);
  await refreshAllItems();
}

async function handleReorderPinned(repoId: string, orderedIds: string[]) {
  await reorderPinned(repoId, orderedIds);
  await refreshAllItems();
}

async function handleRenameItem(itemId: string, displayName: string | null) {
  await renameItem(itemId, displayName);
  await refreshAllItems();
}

async function handleImportRepo(path: string, name: string, defaultBranch: string) {
  await importRepo(path, name, defaultBranch);
  showImportRepoModal.value = false;
}

async function handlePreferenceUpdate(key: string, value: string) {
  await savePreference(key, value);
}

// Reconcile DB terminal sessions against live daemon sessions on startup
async function reconcileSessions() {
  if (!db.value) return;
  try {
    const liveSessions = await invoke<{ session_id: string }[]>("list_sessions");
    const liveIds = new Set(liveSessions.map((s) => s.session_id));

    const dbSessions = await db.value.select<{ id: string; daemon_session_id: string }>(
      "SELECT id, daemon_session_id FROM terminal_session WHERE daemon_session_id IS NOT NULL"
    );

    for (const s of dbSessions) {
      if (!liveIds.has(s.daemon_session_id)) {
        await db.value!.execute("DELETE FROM terminal_session WHERE id = ?", [s.id]);
      }
    }
  } catch {
    // Daemon may not be running yet
  }
}

// Run migrations to ensure tables exist
async function runMigrations(database: DbHandle) {
  await database.execute(`CREATE TABLE IF NOT EXISTS repo (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS pipeline_item (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_number INTEGER, issue_title TEXT, prompt TEXT,
    stage TEXT NOT NULL DEFAULT 'in_progress', pr_number INTEGER, pr_url TEXT,
    branch TEXT, agent_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS worktree (
    id TEXT PRIMARY KEY, pipeline_item_id TEXT NOT NULL REFERENCES pipeline_item(id) ON DELETE CASCADE,
    path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS terminal_session (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pipeline_item_id TEXT REFERENCES pipeline_item(id) ON DELETE SET NULL,
    label TEXT, cwd TEXT, daemon_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    agent_type TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER,
    status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT, error TEXT
  )`);
  await database.execute(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('suspendAfterMinutes', '5')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('killAfterMinutes', '30')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ideCommand', 'code')`);

  // Activity columns (added in feature-parity update)
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN activity TEXT NOT NULL DEFAULT 'idle'`);
  } catch { /* column already exists */ }
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN activity_changed_at TEXT`);
  } catch { /* column already exists */ }
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN port_offset INTEGER`);
  } catch { /* column already exists */ }
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN port_env TEXT`);
  } catch { /* column already exists */ }
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN pin_order INTEGER`);
  } catch { /* column already exists */ }
  try {
    await database.execute(`ALTER TABLE pipeline_item ADD COLUMN display_name TEXT`);
  } catch { /* column already exists */ }

  // Pipeline simplification: map old stages to new
  try {
    await database.execute(`UPDATE pipeline_item SET stage = 'in_progress' WHERE stage = 'queued'`);
    await database.execute(`UPDATE pipeline_item SET stage = 'done' WHERE stage IN ('needs_review', 'merged', 'closed')`);
  } catch { /* migration already applied or no rows to update */ }
}

// Initialize
onMounted(async () => {
  try {
    let database: DbHandle;
    if (isTauri) {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      let dbName = "kanna-v2.db";
      try {
        const envDb = await invoke<string>("read_env_var", { name: "KANNA_DB_NAME" });
        if (envDb) dbName = envDb;
      } catch {}
      // Worktree instances use a separate DB to avoid conflicts
      try {
        const wt = await invoke<string>("read_env_var", { name: "KANNA_WORKTREE" });
        if (wt) {
          // Get worktree name from KANNA_DAEMON_DIR (set by ensure_daemon_running)
          // e.g., /path/to/.kanna-worktrees/task-abc123/.kanna-daemon → task-abc123
          const daemonDir = await invoke<string>("read_env_var", { name: "KANNA_DAEMON_DIR" }).catch(() => "");
          let suffix = Date.now().toString();
          if (daemonDir) {
            const parts = daemonDir.split("/");
            const idx = parts.indexOf(".kanna-daemon");
            if (idx > 0) suffix = parts[idx - 1];
          }
          dbName = `kanna-wt-${suffix}.db`;
        }
      } catch {}
      console.log("[db] using database:", dbName);
      database = (await Database.load(`sqlite:${dbName}`)) as unknown as DbHandle;
    } else {
      database = getMockDatabase() as unknown as DbHandle;
    }
    db.value = database;
    await runMigrations(db.value);
    await refreshRepos();
    await loadPreferences();
    // await reconcileSessions(); // disabled — corrupts daemon connection

    // Transition stale "working" items to "unread"
    if (db.value) {
      const workingItems = await db.value.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE activity = 'working'"
      );
      for (const item of workingItems) {
        // Don't try to reattach on startup — it creates daemon connections
        // that interfere with future PTY sessions. Just mark as unread.
        await updatePipelineItemActivity(db.value, item.id, "unread");
      }
    }

    // GC: remove done tasks older than gcAfterDays
    if (db.value) {
      const cutoff = new Date(Date.now() - gcAfterDays.value * 86400000).toISOString();
      const stale = await db.value.select<PipelineItem>(
        "SELECT * FROM pipeline_item WHERE stage = 'done' AND updated_at < ?",
        [cutoff]
      );
      for (const item of stale) {
        // Remove worktree
        if (item.branch) {
          for (const repo of repos.value) {
            const worktreePath = `${repo.path}/.kanna-worktrees/${item.branch}`;
            await invoke("git_worktree_remove", { repoPath: repo.path, path: worktreePath }).catch(() => {});
          }
        }
        // Delete from DB
        await db.value.execute("DELETE FROM pipeline_item WHERE id = ?", [item.id]);
      }
      if (stale.length > 0) {
        console.log(`[gc] cleaned up ${stale.length} done task(s)`);
      }
    }

    // Restore persisted selection
    if (db.value) {
      const savedRepo = await getSetting(db.value, "selected_repo_id");
      const savedItem = await getSetting(db.value, "selected_item_id");
      if (savedRepo && repos.value.some((r) => r.id === savedRepo)) {
        selectedRepoId.value = savedRepo;
        await loadItems(savedRepo);
        if (savedItem && items.value.some((i) => i.id === savedItem)) {
          selectedItemId.value = savedItem;
        }
      }
    }

    // Set window title for non-main branches
    if (isTauri) {
      try {
        const info = await invoke<{ branch: string; commit_hash: string; version: string }>("git_app_info");
        if (info.branch !== "main" && info.branch !== "master") {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().setTitle(`Kanna — ${info.branch} (${info.version} @ ${info.commit_hash})`);
        }
      } catch {}
    }

    // Listen for hook events from Claude (via daemon broadcast)
    listen("hook_event", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      const hookEvent = payload.event;
      if (!sessionId || !db.value) return;

      const item = allItems.value.find((i) => i.id === sessionId);
      if (!item) return;

      if (hookEvent === "Stop" || hookEvent === "StopFailure") {
        // Auto-transition pr → done
        if (item.stage === "pr") {
          await updatePipelineItemStage(db.value!, item.id, "done");
          item.stage = "done";
        }
        const activity = selectedItemId.value === sessionId ? "idle" : "unread";
        updatePipelineItemActivity(db.value!, item.id, activity);
        item.activity = activity;
        refreshAllItems();
      } else if (hookEvent === "WaitingForInput") {
        updatePipelineItemActivity(db.value!, item.id, "unread");
        item.activity = "unread";
        refreshAllItems();
      } else if (hookEvent === "PostToolUse") {
        updatePipelineItemActivity(db.value!, item.id, "working");
        item.activity = "working";
      }
    });

    // Listen for process exit (backup for when hooks don't fire)
    listen("session_exit", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      if (!sessionId || !db.value) return;

      const item = allItems.value.find((i) => i.id === sessionId);
      if (!item) return;
      // Auto-transition pr → done on exit too
      if (item.stage === "pr") {
        await updatePipelineItemStage(db.value!, item.id, "done");
        item.stage = "done";
      }
      const activity = selectedItemId.value === sessionId ? "idle" : "unread";
      updatePipelineItemActivity(db.value!, item.id, activity);
      item.activity = activity;
      refreshAllItems();
    });
  } catch (e) {
    console.error("Failed to initialize database:", e);
  }
});
</script>

<template>
  <div class="app" :class="{ zen: zenMode }">
    <Sidebar
      v-if="!zenMode && !maximized"
      :repos="repos"
      :pipeline-items="allItems"
      :selected-repo-id="selectedRepoId"
      :selected-item-id="selectedItemId"
      @select-repo="handleSelectRepo"
      @select-item="handleSelectItem"
      @import-repo="showImportRepoModal = true"
      @new-task="(repoId: string) => { selectedRepoId = repoId; showNewTaskModal = true; }"
      @open-preferences="showPreferencesPanel = true"
      @pin-item="handlePinItem"
      @unpin-item="handleUnpinItem"
      @reorder-pinned="handleReorderPinned"
      @rename-item="handleRenameItem"
    />
    <MainPanel
      :item="currentItem"
      :repo-path="selectedRepo?.path"
      :spawn-pty-session="spawnPtySession"
      :maximized="maximized"
      @close-task="handleCloseTask"
      @agent-completed="refreshAllItems"
    />

    <NewTaskModal
      v-if="showNewTaskModal"
      @submit="handleNewTaskSubmit"
      @cancel="showNewTaskModal = false"
    />
    <ImportRepoModal
      v-if="showImportRepoModal"
      @import="handleImportRepo"
      @cancel="showImportRepoModal = false"
    />
    <PreferencesPanel
      v-if="showPreferencesPanel"
      :preferences="{
        suspendAfterMinutes: suspendAfterMinutes,
        killAfterMinutes: killAfterMinutes,

        ideCommand: ideCommand,
      }"
      @update="handlePreferenceUpdate"
      @close="showPreferencesPanel = false"
    />
    <CommandPaletteModal
      v-if="showCommandPalette"
      @close="showCommandPalette = false"
      @execute="(action: ActionName) => keyboardActions[action]()"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      @close="showShortcutsModal = false"
    />
    <ShellModal
      v-if="showShellModal && currentItem"
      :session-id="`shell-${currentItem.id}`"
      :cwd="currentItem.branch ? `${selectedRepo?.path}/.kanna-worktrees/${currentItem.branch}` : selectedRepo?.path || '/tmp'"
      :port-env="currentItem.port_env"
      :maximized="maximized"
      @close="showShellModal = false; maximized = false; focusAgentTerminal()"
    />
    <DiffModal
      v-if="showDiffModal && selectedRepo?.path"
      :repo-path="selectedRepo.path"
      :worktree-path="currentItem?.branch ? `${selectedRepo.path}/.kanna-worktrees/${currentItem.branch}` : undefined"
      :initial-scope="currentItem ? diffScopes.get(currentItem.id) : undefined"
      :maximized="maximized"
      @scope-change="(s: any) => { if (currentItem) diffScopes.set(currentItem.id, s); }"
      @close="showDiffModal = false; maximized = false"
    />
    <FilePickerModal
      v-if="showFilePickerModal && selectedRepo?.path"
      :worktree-path="currentItem?.branch ? `${selectedRepo.path}/.kanna-worktrees/${currentItem.branch}` : selectedRepo.path"
      @close="showFilePickerModal = false"
      @select="(f: string) => { showFilePickerModal = false; previewFilePath = f; showFilePreviewModal = true; }"
    />
    <FilePreviewModal
      v-if="showFilePreviewModal && selectedRepo?.path"
      :file-path="previewFilePath"
      :worktree-path="currentItem?.branch ? `${selectedRepo.path}/.kanna-worktrees/${currentItem.branch}` : selectedRepo.path"
      :ide-command="ideCommand"
      @close="showFilePreviewModal = false"
    />
  </div>
</template>

<style>
:root {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: dark;
  color: #e0e0e0;
  background-color: #1a1a1a;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>

<style scoped>
.app {
  display: flex;
  height: 100%;
  width: 100%;
}

.app.zen {
  /* In zen mode, sidebar is hidden, main panel fills everything */
}
</style>
