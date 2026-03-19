<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { isTauri, getMockDatabase } from "./tauri-mock";
import { invoke } from "./invoke";
import { listen } from "./listen";
import type { DbHandle, PipelineItem } from "@kanna/db";
import { listPipelineItems, updatePipelineItemActivity, getSetting, setSetting } from "@kanna/db";
import type { Stage } from "@kanna/core";
import Sidebar from "./components/Sidebar.vue";
import MainPanel from "./components/MainPanel.vue";
import NewTaskModal from "./components/NewTaskModal.vue";
import ImportRepoModal from "./components/ImportRepoModal.vue";
import PreferencesPanel from "./components/PreferencesPanel.vue";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal.vue";
import FilePickerModal from "./components/FilePickerModal.vue";
import DiffModal from "./components/DiffModal.vue";
import ShellModal from "./components/ShellModal.vue";
import { useRepo } from "./composables/useRepo";
import { usePipeline } from "./composables/usePipeline";
import { usePreferences } from "./composables/usePreferences";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { useResourceSweeper } from "./composables/useResourceSweeper";
import { usePRWorkflow } from "./composables/usePRWorkflow";

const db = ref<DbHandle | null>(null);

const { repos, selectedRepoId, refresh: refreshRepos, importRepo } = useRepo(db);
const { items, selectedItemId, loadItems, transition, createItem, spawnPtySession, selectedItem } = usePipeline(db);
const {
  fontFamily,
  fontSize,
  suspendAfterMinutes,
  killAfterMinutes,

  ideCommand,
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

// PR workflow — only instantiate when db is available
const prWorkflow = computed(() =>
  db.value ? usePRWorkflow(db.value) : null
);

const showNewTaskModal = ref(false);
const showImportRepoModal = ref(false);
const showPreferencesPanel = ref(false);
const showShortcutsModal = ref(false);
const showFilePickerModal = ref(false);
const showDiffModal = ref(false);
const showShellModal = ref(false);
const diffScopes = new Map<string, "branch" | "commit" | "working">();
const zenMode = ref(false);

const currentItem = computed(() => selectedItem());

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
    .filter((item) => item.repo_id === selectedRepoId.value)
    .sort((a, b) => {
      const ao = activityOrder[(a as any).activity || "idle"] ?? 0;
      const bo = activityOrder[(b as any).activity || "idle"] ?? 0;
      if (ao !== bo) return ao - bo;
      const aTime = (a as any).activity_changed_at || a.created_at;
      const bTime = (b as any).activity_changed_at || b.created_at;
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

async function handleMakePR() {
  const item = selectedItem();
  if (!item || !selectedRepo.value || !prWorkflow.value) return;
  try {
    await prWorkflow.value.createPR(item, selectedRepo.value.path);
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("PR creation failed:", e);
  }
}

async function handleMerge() {
  const item = selectedItem();
  if (!item || !selectedRepo.value || !prWorkflow.value) return;
  try {
    await prWorkflow.value.mergePR(item, selectedRepo.value.path);
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("Merge failed:", e);
  }
}

async function handleCloseTask() {
  const item = selectedItem();
  if (!item || !selectedRepo.value || !prWorkflow.value) return;
  try {
    await prWorkflow.value.closeTask(item, selectedRepo.value.path);
    await loadItems(selectedRepo.value.id);
    await refreshAllItems();
  } catch (e) {
    console.error("Close failed:", e);
  }
}

useKeyboardShortcuts({
  newTask: () => { showNewTaskModal.value = true; },
  openFile: () => { showFilePickerModal.value = true; },
  makePR: handleMakePR,
  merge: handleMerge,
  closeTask: handleCloseTask,
  navigateUp: () => navigateItems(-1),
  navigateDown: () => navigateItems(1),
  toggleZen: () => { zenMode.value = !zenMode.value; },
  dismiss: () => {
    if (showShortcutsModal.value) { showShortcutsModal.value = false; return; }
    if (showFilePickerModal.value) { showFilePickerModal.value = false; return; }
    if (showDiffModal.value) { showDiffModal.value = false; return; }
    if (showShellModal.value) { showShellModal.value = false; focusAgentTerminal(); return; }
    if (showNewTaskModal.value) { showNewTaskModal.value = false; return; }
    if (showImportRepoModal.value) { showImportRepoModal.value = false; return; }
    if (showPreferencesPanel.value) { showPreferencesPanel.value = false; return; }
    if (zenMode.value) { zenMode.value = false; }
  },
  openShell: () => { showShellModal.value = !showShellModal.value; },
  newWindow: () => { /* TODO: Tauri window API */ },
  showDiff: () => { showDiffModal.value = !showDiffModal.value; },
  showShortcuts: () => { showShortcutsModal.value = !showShortcutsModal.value; },
  openPreferences: () => { showPreferencesPanel.value = true; },
});

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
    stage TEXT NOT NULL DEFAULT 'queued', pr_number INTEGER, pr_url TEXT,
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
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_font_family', 'SF Mono')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('terminal_font_size', '13')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('suspend_after_minutes', '5')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('kill_after_minutes', '30')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('appearance_mode', 'system')`);
  await database.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ide_command', 'code')`);

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

    // Listen for hook events from Claude (via daemon broadcast)
    listen("hook_event", (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      const hookEvent = payload.event;
      if (!sessionId || !db.value) return;

      const item = allItems.value.find((i) => i.id === sessionId);
      if (!item) return;

      if (hookEvent === "Stop" || hookEvent === "StopFailure") {
        const activity = selectedItemId.value === sessionId ? "idle" : "unread";
        updatePipelineItemActivity(db.value!, item.id, activity);
        item.activity = activity;
        refreshAllItems();
      } else if (hookEvent === "PostToolUse") {
        updatePipelineItemActivity(db.value!, item.id, "working");
        item.activity = "working";
      }
    });

    // Listen for process exit (backup for when hooks don't fire)
    listen("session_exit", (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      if (!sessionId || !db.value) return;

      const item = allItems.value.find((i) => i.id === sessionId);
      if (!item) return;
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
      v-if="!zenMode"
      :repos="repos"
      :pipeline-items="allItems"
      :selected-repo-id="selectedRepoId"
      :selected-item-id="selectedItemId"
      @select-repo="handleSelectRepo"
      @select-item="handleSelectItem"
      @import-repo="showImportRepoModal = true"
      @new-task="(repoId: string) => { selectedRepoId = repoId; showNewTaskModal = true; }"
      @open-preferences="showPreferencesPanel = true"
    />
    <MainPanel
      :item="currentItem"
      :repo-path="selectedRepo?.path"
      :spawn-pty-session="spawnPtySession"
      @make-pr="handleMakePR"
      @merge="handleMerge"
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
        fontFamily: fontFamily,
        fontSize: fontSize,
        suspendAfterMinutes: suspendAfterMinutes,
        killAfterMinutes: killAfterMinutes,

        ideCommand: ideCommand,
      }"
      @update="handlePreferenceUpdate"
      @close="showPreferencesPanel = false"
    />
    <KeyboardShortcutsModal
      v-if="showShortcutsModal"
      @close="showShortcutsModal = false"
    />
    <ShellModal
      v-if="showShellModal && currentItem"
      :session-id="`shell-${currentItem.id}`"
      :cwd="currentItem.branch ? `${selectedRepo?.path}/.kanna-worktrees/${currentItem.branch}` : selectedRepo?.path || '/tmp'"
      @close="showShellModal = false; focusAgentTerminal()"
    />
    <DiffModal
      v-if="showDiffModal && selectedRepo?.path"
      :repo-path="selectedRepo.path"
      :worktree-path="currentItem?.branch ? `${selectedRepo.path}/.kanna-worktrees/${currentItem.branch}` : undefined"
      :initial-scope="currentItem ? diffScopes.get(currentItem.id) : undefined"
      @scope-change="(s: any) => { if (currentItem) diffScopes.set(currentItem.id, s); }"
      @close="showDiffModal = false"
    />
    <FilePickerModal
      v-if="showFilePickerModal && currentItem?.branch"
      :worktree-path="`${selectedRepo?.path}/.kanna-worktrees/${currentItem.branch}`"
      :ide-command="ideCommand"
      @close="showFilePickerModal = false"
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
