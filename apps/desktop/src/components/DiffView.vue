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
    const patch = await invoke<string>("git_diff", {
      repoPath: path,
      staged: false,
    });

    if (!patch || !patch.trim()) {
      // Try staged diff
      const stagedPatch = await invoke<string>("git_diff", {
        repoPath: path,
        staged: true,
      });
      if (!stagedPatch || !stagedPatch.trim()) {
        noDiff.value = true;
        diffContent.value = "";
        cleanupInstance();
        return;
      }
      diffContent.value = stagedPatch;
    } else {
      diffContent.value = patch;
    }

    await renderDiff(diffContent.value);
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function cleanupInstance() {
  if (fileDiffInstance) {
    fileDiffInstance.destroy();
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

  const files = parsePatchFiles(patch);
  if (!files || files.length === 0) {
    noDiff.value = true;
    cleanupInstance();
    return;
  }

  const pool = await initWorkerPool();

  cleanupInstance();

  // Render each file diff
  for (const fileMeta of files) {
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
