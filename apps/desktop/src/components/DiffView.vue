<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { useLessScroll } from "../composables/useLessScroll";
import { invoke } from "../invoke";
import { registerContextShortcuts } from "../composables/useShortcutContext";
import { useDiffRenderer, type DiffRenderContext } from "../composables/useDiffRenderer";
import {
  buildDiffSearchTargets,
  findDiffSearchMatches,
  type DiffSearchMatch,
} from "../utils/diffSearch";
import { getDiffTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
import DiffToolbar from "./DiffToolbar.vue";
import DiffSearchBar from "./DiffSearchBar.vue";

const { t } = useI18n();
const { effectiveCodeTheme } = useThemeRuntime();
const diffTheme = computed(() => getDiffTheme(effectiveCodeTheme.value));

registerContextShortcuts("diff", [
  { label: t('diffView.shortcutSearch'), display: "/", groupKey: "shortcuts.groupSearch" },
  { label: t('diffView.shortcutSearchAlt'), display: "⌘F", groupKey: "shortcuts.groupSearch" },
  { label: t('diffView.shortcutNextPrevMatch'), display: "n / N", groupKey: "shortcuts.groupSearch" },
  { label: t('diffView.shortcutLineUpDown'), display: "j / k", groupKey: "shortcuts.groupNavigation" },
  { label: t('diffView.shortcutPageUpDown'), display: "f / b", groupKey: "shortcuts.groupNavigation" },
  { label: t('diffView.shortcutHalfUpDown'), display: "d / u", groupKey: "shortcuts.groupNavigation" },
  { label: t('diffView.shortcutTopBottom'), display: "g / G", groupKey: "shortcuts.groupNavigation" },
  { label: t('diffView.shortcutScopeNext'), display: "⇧⌘]", groupKey: "shortcuts.groupViews" },
  { label: t('diffView.shortcutScopePrev'), display: "⇧⌘[", groupKey: "shortcuts.groupViews" },
  { label: t('diffView.shortcutCycleFilter'), display: "s", groupKey: "shortcuts.groupViews" },
  { label: t('diffView.shortcutClose'), display: "q", groupKey: "shortcuts.groupActions" },
]);

type WorkingFilter = "all" | "unstaged" | "staged";
type BranchInclude = "none" | "staged" | "all";
type DiffScope = "branch" | "working";
type DiffScrollPositions = Partial<Record<DiffScope, number>>;
const workingFilterOrder: WorkingFilter[] = ["all", "unstaged", "staged"];
const branchIncludeOrder: BranchInclude[] = ["none", "staged", "all"];

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: DiffScope;
  initialScrollPositions?: DiffScrollPositions;
  initialBranchInclude?: BranchInclude;
  baseRef?: string;
  viewKey?: string;
}>();

const emit = defineEmits<{
  (e: "scope-change", scope: DiffScope): void;
  (e: "scroll-state-change", positions: DiffScrollPositions): void;
  (e: "branch-include-change", include: BranchInclude): void;
  (e: "close"): void;
}>();

const diffViewRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const searchBarRef = ref<{ focus: () => void } | null>(null);
const diffContent = ref("");
const loading = ref(false);
const error = ref<string | null>(null);
const noDiff = ref(false);
const workingFilter = ref<WorkingFilter>("all");
const branchInclude = ref<BranchInclude>(normalizeBranchInclude(props.initialBranchInclude));
const scope = ref<DiffScope>(props.initialScope === "branch" ? "branch" : "working");
const scrollPositions = ref<DiffScrollPositions>(cloneScrollPositions(props.initialScrollPositions));
const isSearching = ref(false);
const searchQuery = ref("");
const currentMatch = ref(1);

const workingFilterLabel = computed(() => {
  const labels: Record<WorkingFilter, string> = {
    all: t('diffView.filterAll'),
    unstaged: t('diffView.filterUnstaged'),
    staged: t('diffView.filterStaged'),
  };
  return labels[workingFilter.value];
});

const branchIncludeLabel = computed(() => {
  const labels: Record<BranchInclude, string> = {
    none: t('diffView.branchIncludeNone'),
    staged: t('diffView.filterStaged'),
    all: t('diffView.filterAll'),
  };
  return labels[branchInclude.value];
});

let nextDiffLoadId = 0;
let activeDiffLoadId = 0;
let scrollRestorePendingLoadId = 0;

const {
  renderedFiles,
  cleanupInstance,
  initWorkerPool,
  renderDiff,
} = useDiffRenderer({
  containerRef,
  diffTheme,
  t,
  isActiveDiffLoad,
  restoreScrollPositionForActiveLoad,
  finishPendingScrollRestore,
  applySearchHighlights,
  setNoDiff(nextNoDiff) {
    noDiff.value = nextNoDiff;
  },
});

const searchTargets = computed(() => buildDiffSearchTargets(renderedFiles.value));
const searchMatches = computed(() => findDiffSearchMatches(searchTargets.value, searchQuery.value));
const searchMatchCount = computed(() => searchMatches.value.length);
const searchCountLabel = computed(() => {
  if (!searchQuery.value) return "";
  if (!searchMatchCount.value) return t("diffView.searchNoMatches");
  return `${currentMatch.value}/${searchMatchCount.value}`;
});

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function isActiveDiffLoad(loadId: number): boolean {
  return activeDiffLoadId === loadId;
}

function openSearch() {
  isSearching.value = true;
}

function closeSearch() {
  isSearching.value = false;
  searchQuery.value = "";
  currentMatch.value = 1;
}

function nextMatch() {
  if (!searchMatchCount.value) return;
  currentMatch.value =
    currentMatch.value >= searchMatchCount.value ? 1 : currentMatch.value + 1;
}

function prevMatch() {
  if (!searchMatchCount.value) return;
  currentMatch.value =
    currentMatch.value <= 1 ? searchMatchCount.value : currentMatch.value - 1;
}

function getFileWrapper(fileId: string): HTMLElement | null {
  const wrappers = containerRef.value?.querySelectorAll<HTMLElement>(".diff-file");
  if (!wrappers) return null;
  return [...wrappers].find((wrapper) => wrapper.dataset.fileId === fileId) ?? null;
}

function ensureSearchStyles(shadowRoot: ShadowRoot) {
  if (shadowRoot.querySelector("style[data-kanna-diff-search]")) return;
  const style = document.createElement("style");
  style.dataset.kannaDiffSearch = "true";
  style.textContent = `
    .diff-search-match {
      background: rgba(255, 196, 61, 0.22);
      box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.3);
    }

    .diff-search-active {
      background: rgba(255, 196, 61, 0.4);
      box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.85);
    }
  `;
  shadowRoot.appendChild(style);
}

function getMatchElements(match: DiffSearchMatch): HTMLElement[] {
  const wrapper = getFileWrapper(match.anchor.fileId);
  const container = wrapper?.querySelector<HTMLElement>("diffs-container");
  const shadowRoot = container?.shadowRoot;
  if (shadowRoot) {
    ensureSearchStyles(shadowRoot);
  }

  if (match.anchor.type === "file-header") {
    const stickyHeader = wrapper?.querySelector<HTMLElement>(".diff-file-header");
    if (stickyHeader) return [stickyHeader];
    if (!shadowRoot) return [];
    const title = shadowRoot.querySelector<HTMLElement>("[data-title]");
    return title ? [title] : [];
  }

  if (!shadowRoot) return [];

  const lineIndexPrefix = `${match.anchor.unifiedLineIndex},`;
  const gutter = shadowRoot.querySelector<HTMLElement>(`[data-gutter] [data-line-index^="${lineIndexPrefix}"]`);
  const content = shadowRoot.querySelector<HTMLElement>(`[data-content] [data-line-index^="${lineIndexPrefix}"]`);
  return [gutter, content].filter((element): element is HTMLElement => element != null);
}

function clearSearchHighlights() {
  for (const header of containerRef.value?.querySelectorAll<HTMLElement>(".diff-file-header.diff-search-match, .diff-file-header.diff-search-active") ?? []) {
    header.classList.remove("diff-search-match", "diff-search-active");
  }

  const containers = containerRef.value?.querySelectorAll<HTMLElement>("diffs-container");
  if (!containers) return;

  for (const container of containers) {
    const shadowRoot = container.shadowRoot;
    if (!shadowRoot) continue;
    for (const element of shadowRoot.querySelectorAll<HTMLElement>(".diff-search-match, .diff-search-active")) {
      element.classList.remove("diff-search-match", "diff-search-active");
    }
  }
}

function applySearchHighlights() {
  clearSearchHighlights();
  if (!searchMatches.value.length) return;

  const activeIndex = Math.max(1, Math.min(currentMatch.value, searchMatches.value.length)) - 1;
  let activeElement: HTMLElement | null = null;

  for (const [index, match] of searchMatches.value.entries()) {
    const elements = getMatchElements(match);
    for (const element of elements) {
      element.classList.add("diff-search-match");
      if (index === activeIndex) {
        element.classList.add("diff-search-active");
        if (activeElement == null && !element.closest("[data-gutter]")) {
          activeElement = element;
        }
      }
    }
  }

  activeElement?.scrollIntoView?.({ block: "center" });
}

function logDiffPerf(
  loadId: number,
  stage: string,
  details: Record<string, unknown>,
) {
  console.warn(`[DiffView][perf] load#${loadId} ${stage}`, details);
}

function cloneScrollPositions(positions?: DiffScrollPositions): DiffScrollPositions {
  return positions ? { ...positions } : {};
}

function normalizeBranchInclude(include?: BranchInclude): BranchInclude {
  return include === "staged" || include === "all" ? include : "none";
}

function emitScrollStateChange() {
  emit("scroll-state-change", { ...scrollPositions.value });
}

function updateScrollPosition(scopeName: DiffScope, top: number) {
  if (scrollPositions.value[scopeName] === top) return;
  scrollPositions.value = {
    ...scrollPositions.value,
    [scopeName]: top,
  };
  emitScrollStateChange();
}

function saveCurrentScrollPosition() {
  if (!containerRef.value) return;
  updateScrollPosition(scope.value, containerRef.value.scrollTop);
}

function restoreScrollPosition() {
  if (!containerRef.value) return;
  const top = scrollPositions.value[scope.value] ?? 0;
  containerRef.value.scrollTo({ top, behavior: "auto" });
}

function restoreScrollPositionForActiveLoad(context: DiffRenderContext) {
  if (!isActiveDiffLoad(context.loadId)) return;
  if ((scrollPositions.value[scope.value] ?? 0) <= 0) return;
  restoreScrollPosition();
}

function finishPendingScrollRestore(context: DiffRenderContext) {
  if (scrollRestorePendingLoadId !== context.loadId) return;
  restoreScrollPositionForActiveLoad(context);
  scrollRestorePendingLoadId = 0;
}

function syncViewStateFromProps() {
  scope.value = props.initialScope === "branch" ? "branch" : "working";
  scrollPositions.value = cloneScrollPositions(props.initialScrollPositions);
  branchInclude.value = normalizeBranchInclude(props.initialBranchInclude);
}

async function loadDiff(options: { preserveCurrentScroll?: boolean } = {}) {
  if (options.preserveCurrentScroll !== false) {
    saveCurrentScrollPosition();
  }
  emit("scope-change", scope.value);
  closeSearch();
  const path = props.worktreePath || props.repoPath;
  const loadId = ++nextDiffLoadId;
  activeDiffLoadId = loadId;
  const loadStartedAt = performance.now();
  const renderContext: DiffRenderContext = {
    loadId,
    loadStartedAt,
  };
  loading.value = true;
  error.value = null;
  noDiff.value = false;
  scrollRestorePendingLoadId = (scrollPositions.value[scope.value] ?? 0) > 0 ? loadId : 0;
  logDiffPerf(loadId, "start", {
    scope: scope.value,
    path,
    hasExplicitBaseRef: Boolean(props.baseRef),
    workingFilter: scope.value === "working" ? workingFilter.value : undefined,
    branchInclude: scope.value === "branch" ? branchInclude.value : undefined,
  });

  try {
    let patch = "";

    if (scope.value === "working") {
      const diffStartedAt = performance.now();
      patch = await invoke<string>("git_diff", { repoPath: path, mode: workingFilter.value });
      logDiffPerf(loadId, "git_diff:done", {
        durationMs: roundDuration(performance.now() - diffStartedAt),
        mode: workingFilter.value,
      });
    } else {
      // "branch" scope — diff from merge base
      const baseRefStartedAt = performance.now();
      const resolvedBase = await resolveBranchBaseRef(path);
      logDiffPerf(loadId, "base_ref:done", {
        durationMs: roundDuration(performance.now() - baseRefStartedAt),
        baseRef: resolvedBase.ref,
        source: resolvedBase.source,
      });

      const mergeBaseStartedAt = performance.now();
      const mergeBase = await invoke<string>("git_merge_base", {
        repoPath: path,
        refA: resolvedBase.ref,
        refB: "HEAD",
      });
      logDiffPerf(loadId, "merge_base:done", {
        durationMs: roundDuration(performance.now() - mergeBaseStartedAt),
        mergeBase,
      });

      const diffRangeStartedAt = performance.now();
      patch = await invoke<string>("git_diff_branch_range", {
        repoPath: path,
        from: mergeBase,
        mode: branchInclude.value,
      });
      logDiffPerf(loadId, "git_diff_branch_range:done", {
        durationMs: roundDuration(performance.now() - diffRangeStartedAt),
        mode: branchInclude.value,
      });
    }

    if (!isActiveDiffLoad(loadId)) {
      return;
    }

    if (!patch?.trim()) {
      noDiff.value = true;
      diffContent.value = "";
      renderedFiles.value = [];
      cleanupInstance();
      scrollRestorePendingLoadId = 0;
      logDiffPerf(loadId, "empty", {
        totalMs: roundDuration(performance.now() - loadStartedAt),
      });
      return;
    }

    logDiffPerf(loadId, "patch:ready", {
      durationMs: roundDuration(performance.now() - loadStartedAt),
      bytes: patch.length,
      lines: patch.split("\n").length,
    });

    diffContent.value = patch;
    await renderDiff(diffContent.value, renderContext);
    if (!isActiveDiffLoad(loadId)) {
      return;
    }
    restoreScrollPosition();
  } catch (e: unknown) {
    if (!isActiveDiffLoad(loadId)) {
      return;
    }
    error.value = e instanceof Error ? e.message : String(e);
    scrollRestorePendingLoadId = 0;
    logDiffPerf(loadId, "error", {
      totalMs: roundDuration(performance.now() - loadStartedAt),
      error: error.value,
    });
  } finally {
    if (isActiveDiffLoad(loadId)) {
      loading.value = false;
    }
  }
}

interface ResolvedBranchBaseRef {
  ref: string;
  source: "upstream" | "prop" | "detected";
}

async function resolveBranchBaseRef(path: string): Promise<ResolvedBranchBaseRef> {
  const upstream = await invoke<string | null>("git_branch_upstream", { repoPath: path })
    .catch((e: unknown) => {
      console.warn("[DiffView] branch upstream unavailable, using stored base ref:", e);
      return null;
    });
  if (upstream) {
    return { ref: upstream, source: "upstream" };
  }
  if (props.baseRef) {
    return { ref: props.baseRef, source: "prop" };
  }
  return { ref: await detectBaseRef(path), source: "detected" };
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

watch(
  () => [props.viewKey, props.repoPath, props.worktreePath, props.baseRef] as const,
  (nextValue, previousValue) => {
    const viewChanged = previousValue !== undefined && nextValue[0] !== previousValue[0];
    if (viewChanged) {
      syncViewStateFromProps();
    }
    void loadDiff({ preserveCurrentScroll: !viewChanged });
  },
  { immediate: false }
);

watch(effectiveCodeTheme, () => {
  void initWorkerPool().then(() => {
    if (diffContent.value.trim()) {
      return loadDiff({ preserveCurrentScroll: true });
    }
  });
});

const scopeOrder: DiffScope[] = ["working", "branch"];

async function setScope(nextScope: DiffScope) {
  if (scope.value === nextScope) return;
  saveCurrentScrollPosition();
  scope.value = nextScope;
  await loadDiff({ preserveCurrentScroll: false });
}

function cycleScopeForward() {
  const idx = scopeOrder.indexOf(scope.value);
  void setScope(scopeOrder[(idx + 1) % scopeOrder.length]);
}

function cycleScopeBack() {
  const idx = scopeOrder.indexOf(scope.value);
  void setScope(scopeOrder[(idx - 1 + scopeOrder.length) % scopeOrder.length]);
}

function cycleWorkingFilter() {
  const idx = workingFilterOrder.indexOf(workingFilter.value);
  workingFilter.value = workingFilterOrder[(idx + 1) % workingFilterOrder.length];
  void loadDiff();
}

function cycleBranchInclude() {
  const idx = branchIncludeOrder.indexOf(branchInclude.value);
  branchInclude.value = branchIncludeOrder[(idx + 1) % branchIncludeOrder.length];
  emit("branch-include-change", branchInclude.value);
  void loadDiff();
}

function refreshBranchDiffOnWindowFocus() {
  if (scope.value !== "branch" || loading.value) return;
  void loadDiff({ preserveCurrentScroll: true });
}

function handleScroll() {
  if (loading.value || scrollRestorePendingLoadId === activeDiffLoadId) return;
  saveCurrentScrollPosition();
}

function handleSearchInputKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
    nextTick(() => diffViewRef.value?.focus());
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      prevMatch();
    } else {
      nextMatch();
    }
    nextTick(() => diffViewRef.value?.focus());
  }
}

useLessScroll(containerRef, {
  extraHandler(e) {
    const noMods = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "/" && noMods) {
      e.preventDefault();
      openSearch();
      nextTick(() => searchBarRef.value?.focus());
      return true;
    }

    if (meta && e.key === "f" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      openSearch();
      nextTick(() => searchBarRef.value?.focus());
      return true;
    }

    if (e.key === "n" && noMods && isSearching.value) {
      e.preventDefault();
      nextMatch();
      return true;
    }

    if (e.key === "N" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && isSearching.value) {
      e.preventDefault();
      prevMatch();
      return true;
    }

    // s — cycle working filter (only in working scope)
    if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (scope.value === "working") {
        e.preventDefault();
        cycleWorkingFilter();
        return true;
      }
    }
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

watch(searchMatchCount, (count) => {
  if (count === 0) {
    currentMatch.value = 1;
    return;
  }
  if (currentMatch.value > count) {
    currentMatch.value = count;
  }
});

watch(searchQuery, () => {
  currentMatch.value = 1;
});

watch([searchMatches, currentMatch], () => {
  nextTick(() => applySearchHighlights());
});

watch(isSearching, (searching) => {
  if (searching) {
    nextTick(() => searchBarRef.value?.focus());
  }
});

onMounted(() => {
  syncViewStateFromProps();
  void loadDiff({ preserveCurrentScroll: false });
  window.addEventListener("focus", refreshBranchDiffOnWindowFocus);
  nextTick(() => diffViewRef.value?.focus());
});

onUnmounted(() => {
  activeDiffLoadId = 0;
  scrollRestorePendingLoadId = 0;
  window.removeEventListener("focus", refreshBranchDiffOnWindowFocus);
  cleanupInstance();
});

defineExpose({ refresh: loadDiff });
</script>

<template>
  <div ref="diffViewRef" class="diff-view" tabindex="-1">
    <DiffToolbar
      :scope="scope"
      :working-filter-label="workingFilterLabel"
      :branch-include-label="branchIncludeLabel"
      @set-scope="setScope"
      @cycle-working-filter="cycleWorkingFilter()"
      @cycle-branch-include="cycleBranchInclude()"
    />
    <div v-if="error" class="diff-status diff-error">{{ error }}</div>
    <div v-else-if="noDiff && !loading" class="diff-status">{{ $t('diffView.noChanges') }}</div>
    <div ref="containerRef" class="diff-container" @scroll="handleScroll"></div>
    <DiffSearchBar
      v-if="isSearching"
      ref="searchBarRef"
      v-model="searchQuery"
      :search-count-label="searchCountLabel"
      @keydown="handleSearchInputKeydown"
    />
  </div>
</template>

<style scoped>
.diff-view {
  flex: 1;
  overflow: auto;
  background: var(--kn-code-bg);
  font-size: 13px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  outline: none;
}

.diff-status {
  padding: 24px;
  color: var(--kn-text-muted);
  text-align: center;
  font-size: 13px;
}

.diff-error {
  color: var(--kn-danger);
}

.diff-container {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.diff-container :deep(.diff-file) {
  position: relative;
  margin-bottom: 2px;
}

.diff-container :deep(.diff-file-header) {
  position: sticky;
  top: -1px;
  z-index: 2;
  padding: 7px 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-panel);
  color: var(--kn-text-primary);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}

.diff-container :deep(.diff-file-header.diff-search-match) {
  background: rgba(255, 196, 61, 0.22);
  box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.3);
}

.diff-container :deep(.diff-file-header.diff-search-active) {
  background: rgba(255, 196, 61, 0.4);
  box-shadow: inset 0 0 0 1px rgba(255, 196, 61, 0.85);
}

.diff-container :deep(.diff-file-skipped) {
  padding: 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-app);
  color: var(--kn-text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.diff-container :deep(diffs-container) {
  color-scheme: light dark;
}
</style>
