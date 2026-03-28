<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import TaskList from "./components/TaskList.vue";
import TerminalView from "./components/TerminalView.vue";

interface Repo {
  id: string;
  name: string;
  path: string;
}

interface Task {
  id: string;
  repo_id: string;
  prompt: string;
  tags: string;
  activity: string;
  display_name: string | null;
  branch: string | null;
  pr_number: number | null;
  created_at: string;
}

const repos = ref<Repo[]>([]);
const tasks = ref<Task[]>([]);
const selectedTask = ref<Task | null>(null);
const error = ref<string | null>(null);

async function dbSelect<T>(query: string, bindValues: unknown[] = []): Promise<T[]> {
  return await invoke<T[]>("db_select", { query, bindValues });
}

async function loadData() {
  try {
    repos.value = await dbSelect<Repo>(
      "SELECT id, name, path FROM repo WHERE hidden = 0 ORDER BY name"
    );
    const loaded: Task[] = [];
    for (const repo of repos.value) {
      const items = await dbSelect<Task>(
        `SELECT id, repo_id, prompt, tags, activity, display_name, branch, pr_number, created_at
         FROM pipeline_item
         WHERE repo_id = ? AND tags NOT LIKE '%"done"%' AND tags NOT LIKE '%"merge"%'
         ORDER BY created_at DESC`,
        [repo.id]
      );
      loaded.push(...items);
    }
    tasks.value = loaded;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function selectTask(task: Task) {
  selectedTask.value = task;
}

function goBack() {
  selectedTask.value = null;
}

let pollInterval: ReturnType<typeof setInterval>;

onMounted(async () => {
  await loadData();
  pollInterval = setInterval(loadData, 5000);
});

onUnmounted(() => {
  clearInterval(pollInterval);
});
</script>

<template>
  <div class="app">
    <div v-if="error" class="error-banner">{{ error }}</div>
    <TerminalView
      v-if="selectedTask"
      :task="selectedTask"
      @back="goBack"
    />
    <TaskList
      v-else
      :repos="repos"
      :tasks="tasks"
      @select="selectTask"
    />
  </div>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: #0d0d0d;
  color: #d4d4d4;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  font-size: 15px;
  -webkit-user-select: none;
  user-select: none;
  overscroll-behavior: none;
}

.app {
  min-height: 100dvh;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

.error-banner {
  background: #3a1111;
  color: #ff6b6b;
  padding: 8px 16px;
  font-size: 13px;
  font-family: ui-monospace, monospace;
}
</style>
