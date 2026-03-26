<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { useLessScroll } from "../composables/useLessScroll";
import { invoke } from "../invoke";
import { registerContextShortcuts } from "../composables/useShortcutContext";
import { FileDiff, parsePatchFiles } from "@pierre/diffs";
import {
  getOrCreateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";

const { t } = useI18n();

registerContextShortcuts("diff", [
  { label: t('diffView.shortcutScopeNext'), display: "⇧⌘]" },
  { label: t('diffView.shortcutScopePrev'), display: "⇧⌘[" },
  { label: t('diffView.shortcutLineUpDown'), display: "j / k" },
  { label: t('diffView.shortcutPageUpDown'), display: "f / b" },
  { label: t('diffView.shortcutHalfUpDown'), display: "d / u" },
  { label: t('diffView.shortcutTopBottom'), display: "g / G" },
  { label: t('diffView.shortcutClose'), display: "q" },
]);

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "commit" | "working";
  baseRef?: string;
}>();

const emit = defineEmits<{
  (e: "scope-change", scope: "branch" | "commit" | "working"): void;
  (e: "close"): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const diffContent = ref("");
const loading = ref(false);
const error = ref<string | null>(null);
const noDiff = ref(false);
const noBranchCommits = ref(false);
const includeStaged = ref(false);
const scope = ref<"branch" | "commit" | "working">(props.initialScope || "working");
let fileDiffInstance: FileDiff | null = null;
let workerPool: WorkerPoolManager | null = null;

async function initWorkerPool() {
  if (workerPool) return workerPool;
  try {
    workerPool = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () =>
          new Worker(
            new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url),
            { type: "module" }
          ),
      },
      highlighterOptions: {
        theme: "github-dark",
        lineDiffType: "word",
      },
    });
    return workerPool;
  } catch (e) {
    console.warn("[DiffView] Worker pool init failed, falling back:", e);
    return null;
  }
}

async function loadDiff() {
  emit("scope-change", scope.value);
  const path = props.worktreePath || props.repoPath;
  loading.value = true;
  error.value = null;
  noDiff.value = false;
  noBranchCommits.value = false;

  try {
    let patch = "";

    if (scope.value === "working") {
      const mode = includeStaged.value ? "all" : "unstaged";
      patch = await invoke<string>("git_diff", { repoPath: path, mode });
    } else if (scope.value === "commit") {
      const hasBranchCommits = await checkBranchHasCommits(path);
      if (!hasBranchCommits) {
        noBranchCommits.value = true;
        cleanupInstance();
        return;
      }
      patch = await invoke<string>("git_diff_range", {
        repoPath: path,
        from: "HEAD~1",
        to: "HEAD",
      });
    } else {
      // "branch" scope — diff from merge base
      const baseRef = props.baseRef || await detectBaseRef(path);
      const mergeBase = await invoke<string>("git_merge_base", {
        repoPath: path,
        refA: baseRef,
        refB: "HEAD",
      });
      patch = await invoke<string>("git_diff_range", {
        repoPath: path,
        from: mergeBase,
        to: "HEAD",
      });
    }

    if (!patch?.trim()) {
      noDiff.value = true;
      diffContent.value = "";
      cleanupInstance();
      return;
    }

    diffContent.value = patch;
    await renderDiff(diffContent.value);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function checkBranchHasCommits(path: string): Promise<boolean> {
  try {
    const baseRef = props.baseRef || await detectBaseRef(path);
    const mergeBase = await invoke<string>("git_merge_base", {
      repoPath: path,
      refA: baseRef,
      refB: "HEAD",
    });
    const branchDiff = await invoke<string>("git_diff_range", {
      repoPath: path,
      from: mergeBase,
      to: "HEAD",
    });
    return branchDiff.trim().length > 0;
  } catch (e: unknown) {
    console.warn("[DiffView] checkBranchHasCommits failed:", e);
    return false;
  }
}

async function detectBaseRef(path: string): Promise<string> {
  const defaultBranch = await invoke<string>("git_default_branch", { repoPath: path });
  try {
    await invoke<string>("git_merge_base", {
      repoPath: path,
      refA: `origin/${defaultBranch}`,
      refB: "HEAD",
    });
    return `origin/${defaultBranch}`;
  } catch (e: unknown) {
    console.warn("[DiffView] origin ref not available, using local:", e);
    return defaultBranch;
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
  const allFiles = patches?.flatMap((p) => p.files || []) || [];
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
        diffStyle: "unified",
        diffIndicators: "classic",
      },
      pool || undefined
    );

    instance.render({
      fileDiff: fileMeta,
      containerWrapper: wrapper,
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

const scopeOrder: Array<"working" | "commit" | "branch"> = ["working", "commit", "branch"];

function cycleScopeForward() {
  const idx = scopeOrder.indexOf(scope.value);
  scope.value = scopeOrder[(idx + 1) % scopeOrder.length];
  loadDiff();
}

function cycleScopeBack() {
  const idx = scopeOrder.indexOf(scope.value);
  scope.value = scopeOrder[(idx - 1 + scopeOrder.length) % scopeOrder.length];
  loadDiff();
}

useLessScroll(containerRef, {
  extraHandler(e) {
    // Cmd+Shift+] — next scope
    if (e.key === "]" && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      cycleScopeForward();
      return true;
    }
    // Cmd+Shift+[ — previous scope
    if (e.key === "[" && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      cycleScopeBack();
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});

onMounted(() => loadDiff());

onUnmounted(() => cleanupInstance());

defineExpose({ refresh: loadDiff });
</script>

<template>
  <div class="diff-view">
    <div class="diff-toolbar">
      <div class="scope-selector">
        <button :class="{ active: scope === 'branch' }" @click="scope = 'branch'; loadDiff()">{{ $t('diffView.scopeBranch') }}</button>
        <button :class="{ active: scope === 'commit' }" @click="scope = 'commit'; loadDiff()">{{ $t('diffView.scopeLastCommit') }}</button>
        <button :class="{ active: scope === 'working' }" @click="scope = 'working'; loadDiff()">{{ $t('diffView.scopeWorking') }}</button>
      </div>
    </div>
    <div v-if="error" class="diff-status diff-error">{{ error }}</div>
    <div v-else-if="noDiff && !loading" class="diff-status">{{ $t('diffView.noChanges') }}</div>
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
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.diff-container :deep(.diff-file) {
  margin-bottom: 2px;
}

.diff-container :deep(diffs-container) {
  color-scheme: dark;
}
</style>
