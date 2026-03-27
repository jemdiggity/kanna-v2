<script setup lang="ts">
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

const props = defineProps<{
  repos: Repo[];
  tasks: Task[];
}>();

const emit = defineEmits<{
  select: [task: Task];
}>();

function tasksForRepo(repoId: string): Task[] {
  return props.tasks.filter((t) => t.repo_id === repoId);
}

function taskName(task: Task): string {
  if (task.display_name) return task.display_name;
  if (task.prompt) return task.prompt.length > 60 ? task.prompt.slice(0, 60) + "…" : task.prompt;
  return task.id.slice(0, 8);
}

function hasPrTag(task: Task): boolean {
  try { return (JSON.parse(task.tags) as string[]).includes("pr"); }
  catch { return false; }
}
</script>

<template>
  <div class="task-list">
    <header class="header">
      <h1>Kanna</h1>
    </header>

    <div v-if="repos.length === 0" class="empty">
      No repos connected.
    </div>

    <div v-for="repo in repos" :key="repo.id" class="repo-group">
      <div class="repo-name">{{ repo.name }}</div>
      <div v-if="tasksForRepo(repo.id).length === 0" class="empty-repo">
        No active tasks
      </div>
      <div
        v-for="task in tasksForRepo(repo.id)"
        :key="task.id"
        class="task-row"
        :class="{ working: task.activity === 'working', unread: task.activity === 'unread' }"
        @click="emit('select', task)"
      >
        <div class="task-info">
          <span class="task-name">{{ taskName(task) }}</span>
          <span v-if="hasPrTag(task)" class="badge pr">PR</span>
        </div>
        <div class="task-meta">
          <span class="activity-dot" :class="task.activity" />
          <span v-if="task.branch" class="branch">{{ task.branch.replace('task-', '').slice(0, 8) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-list {
  padding: 0 16px 24px;
}

.header {
  padding: 16px 0 12px;
}

.header h1 {
  font-size: 28px;
  font-weight: 700;
  color: #e0e0e0;
  letter-spacing: -0.5px;
}

.empty {
  color: #666;
  padding: 40px 0;
  text-align: center;
}

.repo-group {
  margin-bottom: 20px;
}

.repo-name {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #777;
  padding: 8px 0 4px;
}

.empty-repo {
  color: #555;
  font-size: 13px;
  padding: 8px 0;
}

.task-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #1a1a1a;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.task-row:active {
  background: #1a1a1a;
}

.task-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
}

.task-row.working .task-name { font-style: italic; color: #c0c0c0; }
.task-row.unread .task-name { font-weight: 600; color: #fff; }

.badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.badge.pr {
  background: #1a3a1a;
  color: #5cb85c;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 12px;
}

.activity-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #333;
}

.activity-dot.working { background: #f0ad4e; }
.activity-dot.unread { background: #5bc0de; }
.activity-dot.idle { background: #444; }

.branch {
  font-size: 11px;
  font-family: ui-monospace, monospace;
  color: #555;
}
</style>
