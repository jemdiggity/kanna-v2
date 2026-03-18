<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { invoke } from "../invoke";
import { FileDiff, parsePatchFiles } from "@pierre/diffs";
import {
  getOrCreateWorkerPoolSingleton,
} from "@pierre/diffs/worker";

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
}>();

const containerRef = ref<HTMLElement | null>(null);
const diffContent = ref("");
const loading = ref(false);
const error = ref<string | null>(null);
const noDiff = ref(false);
const scope = ref<"branch" | "commit" | "working">("branch");
const diffMode = ref<"unified" | "split">("unified");

let fileDiffInstance: FileDiff | null = null;
let workerPool: any = null;

async function initWorkerPool() {
  if (workerPool) return workerPool;
  try {
    workerPool = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () =>
          new Worker(
            new URL("@pierre/diffs/worker/worker.js", import.meta.url),
            { type: "module" }
          ),
      },
      highlighterOptions: {
        theme: "github-dark",
      },
    });
    return workerPool;
  } catch (e) {
    console.warn("[DiffView] Worker pool init failed, falling back:", e);
    return null;
  }
}

async function loadDiff() {
  const path = props.worktreePath || props.repoPath;
  loading.value = true;
  error.value = null;
  noDiff.value = false;

  try {
    let patch = "";

    if (scope.value === "branch") {
      // All changes since base branch
      try {
        const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path });
        patch = await invoke<string>("git_diff_range", {
          repoPath: path,
          from: defaultBranch,
          to: "HEAD",
        });
      } catch {
        // Fallback to working changes if branch diff fails
        patch = await invoke<string>("git_diff", { repoPath: path, staged: false });
      }
    } else if (scope.value === "commit") {
      // Last commit
      try {
        patch = await invoke<string>("git_diff_range", {
          repoPath: path,
          from: "HEAD~1",
          to: "HEAD",
        });
      } catch {
        patch = "";
      }
    } else {
      // Working tree changes (unstaged + untracked)
      patch = await invoke<string>("git_diff", { repoPath: path, staged: false });
      if (!patch?.trim()) {
        patch = await invoke<string>("git_diff", { repoPath: path, staged: true });
      }
    }

    if (!patch?.trim()) {
      noDiff.value = true;
      diffContent.value = "";
      cleanupInstance();
      return;
    }

    diffContent.value = patch;
    await renderDiff(diffContent.value);
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function cleanupInstance() {
  if (fileDiffInstance) {
    // FileDiff doesn't have a destroy method — just null the reference
    fileDiffInstance = null;
  }
  // Clear rendered diff elements safely
  if (containerRef.value) {
    while (containerRef.value.firstChild) {
      containerRef.value.removeChild(containerRef.value.firstChild);
    }
  }
}

async function renderDiff(patch: string) {
  if (!containerRef.value) return;

  const patches = parsePatchFiles(patch);
  // parsePatchFiles returns [{ patchMetadata, files: [FileDiffMetadata, ...] }]
  const allFiles = patches?.flatMap((p: any) => p.files || []) || [];
  if (allFiles.length === 0) {
    noDiff.value = true;
    cleanupInstance();
    return;
  }

  const pool = await initWorkerPool();

  cleanupInstance();

  // Render each file diff
  for (const fileMeta of allFiles) {
    const wrapper = document.createElement("div");
    wrapper.className = "diff-file";
    containerRef.value.appendChild(wrapper);

    const instance = new FileDiff(
      {
        theme: "github-dark",
        lineDiffType: "word",
      },
      pool || undefined
    );

    instance.render({
      fileDiff: fileMeta,
      fileContainer: wrapper,
    });

    // Keep last instance for cleanup
    fileDiffInstance = instance;
  }
}

watch(
  () => [props.repoPath, props.worktreePath],
  () => loadDiff(),
  { immediate: false }
);

onMounted(() => {
  loadDiff();
});

onUnmounted(() => {
  cleanupInstance();
});

defineExpose({ refresh: loadDiff });
</script>

<template>
  <div class="diff-view">
    <div class="diff-toolbar">
      <div class="scope-selector">
        <button :class="{ active: scope === 'branch' }" @click="scope = 'branch'; loadDiff()">Branch</button>
        <button :class="{ active: scope === 'commit' }" @click="scope = 'commit'; loadDiff()">Last Commit</button>
        <button :class="{ active: scope === 'working' }" @click="scope = 'working'; loadDiff()">Working</button>
      </div>
    </div>
    <div v-if="loading" class="diff-status">Loading diff...</div>
    <div v-else-if="error" class="diff-status diff-error">{{ error }}</div>
    <div v-else-if="noDiff" class="diff-status">No changes</div>
    <div ref="containerRef" class="diff-container"></div>
  </div>
</template>

<style scoped>
.diff-view {
  flex: 1;
  overflow: auto;
  background: #1a1a1a;
  font-size: 13px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.diff-toolbar {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid #333;
  background: #1e1e1e;
  flex-shrink: 0;
}

.scope-selector {
  display: flex;
  gap: 0;
}

.scope-selector button {
  padding: 3px 12px;
  background: #2a2a2a;
  border: 1px solid #444;
  color: #888;
  font-size: 11px;
  cursor: pointer;
}

.scope-selector button:first-child { border-radius: 4px 0 0 4px; }
.scope-selector button:last-child { border-radius: 0 4px 4px 0; }
.scope-selector button:not(:first-child) { border-left: none; }

.scope-selector button.active {
  background: #0066cc;
  border-color: #0077ee;
  color: #fff;
}

.diff-status {
  padding: 24px;
  color: #666;
  text-align: center;
  font-size: 13px;
}

.diff-error {
  color: #f85149;
}

.diff-container {
  min-height: 0;
}

.diff-container :deep(.diff-file) {
  margin-bottom: 2px;
}
</style>
