<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { useLessScroll } from "../composables/useLessScroll";
import { invoke } from "../invoke";
import { registerContextShortcuts } from "../composables/useShortcutContext";
import {
  FileDiff,
  parsePatchFiles,
  setLanguageOverride,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  getSyntaxLanguageForPath,
  isBazelSyntaxPath,
} from "../utils/syntaxLanguage";
import { normalizeGitPatchForDiffParser } from "../utils/normalizeGitPatch";
import { macOsTextInputAttrs } from "../utils/textInput";
import {
  buildDiffSearchTargets,
  findDiffSearchMatches,
  type DiffSearchFile,
  type DiffSearchMatch,
} from "../utils/diffSearch";
import {
  getOrCreateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
import { getDiffTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";

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
const searchInputRef = ref<HTMLInputElement | null>(null);
const diffContent = ref("");
const loading = ref(false);
const error = ref<string | null>(null);
const noDiff = ref(false);
const workingFilter = ref<WorkingFilter>("all");
const branchInclude = ref<BranchInclude>(normalizeBranchInclude(props.initialBranchInclude));
const scope = ref<DiffScope>(props.initialScope === "branch" ? "branch" : "working");
const scrollPositions = ref<DiffScrollPositions>(cloneScrollPositions(props.initialScrollPositions));
const renderedFiles = ref<DiffSearchFile[]>([]);
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
let workerPool: WorkerPoolManager | null = null;

interface DiffFilePathMetadata {
  newName?: string;
  oldName?: string;
  fileName?: string;
}

interface DiffWorkerPoolStats {
  managerState?: string;
  totalWorkers?: number;
  workersFailed?: boolean;
  busyWorkers?: number;
  queuedTasks?: number;
  pendingTasks?: number;
  diffCacheSize?: number;
}

interface DiffWorkerPoolInspector {
  getStats?: () => DiffWorkerPoolStats;
  isInitialized?: () => boolean;
}

interface DiffRenderContext {
  loadId: number;
  loadStartedAt: number;
}

interface DiffRenderFileEntry {
  id: string;
  rawFileMeta: FileDiffMetadata & DiffFilePathMetadata;
  displayPath: string;
  wrapper: HTMLDivElement;
  skipReason?: "oversized";
}

interface DiffRenderProgress {
  completedFiles: number;
  firstCompletedAt: number | null;
  completedAllLogged: boolean;
  firstCompletedWaiters: Array<() => void>;
}

const searchTargets = computed(() => buildDiffSearchTargets(renderedFiles.value));
const searchMatches = computed(() => findDiffSearchMatches(searchTargets.value, searchQuery.value));
const searchMatchCount = computed(() => searchMatches.value.length);
const searchCountLabel = computed(() => {
  if (!searchQuery.value) return "";
  if (!searchMatchCount.value) return t("diffView.searchNoMatches");
  return `${currentMatch.value}/${searchMatchCount.value}`;
});

let nextDiffLoadId = 0;
let activeDiffLoadId = 0;
let fileDiffInstances: FileDiff[] = [];
let scrollRestorePendingLoadId = 0;

const DIFF_RENDER_BATCH_SIZE = 12;
const DIFF_INITIAL_RENDER_BATCH_SIZE = 1;
const MAX_RENDERABLE_DIFF_LINE_LENGTH = 250_000;
const MAX_RENDERABLE_DIFF_FILE_CONTENT_LENGTH = 2_000_000;

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function isActiveDiffLoad(loadId: number): boolean {
  return activeDiffLoadId === loadId;
}

async function waitForRenderTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForFirstRenderedFile(
  progress: DiffRenderProgress,
  timeoutMs = 5000,
): Promise<void> {
  if (progress.firstCompletedAt != null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const index = progress.firstCompletedWaiters.indexOf(finish);
      if (index >= 0) {
        progress.firstCompletedWaiters.splice(index, 1);
      }
      resolve();
    };
    progress.firstCompletedWaiters.push(finish);
    setTimeout(finish, timeoutMs);
  });
}

function getWorkerPoolStatsSnapshot(pool: WorkerPoolManager | null): DiffWorkerPoolStats | null {
  if (pool == null) return null;
  const inspector = pool as WorkerPoolManager & DiffWorkerPoolInspector;
  if (typeof inspector.getStats !== "function") return null;
  return inspector.getStats();
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

function getDisplayPath(fileMeta: FileDiffMetadata & DiffFilePathMetadata): string {
  return fileMeta.name || fileMeta.newName || fileMeta.oldName || fileMeta.fileName || "";
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

async function initWorkerPool() {
  if (workerPool) {
    await (workerPool as WorkerPoolManager & {
      setRenderOptions?: (options: { theme: string; lineDiffType: "word" }) => Promise<void>;
    }).setRenderOptions?.({
      theme: diffTheme.value,
      lineDiffType: "word",
    });
    return workerPool;
  }
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
        theme: diffTheme.value,
        lineDiffType: "word",
      },
    });
    return workerPool;
  } catch (e) {
    console.warn("[DiffView] Worker pool init failed, falling back:", e);
    return null;
  }
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

function cleanupInstance() {
  fileDiffInstances = [];
  // Clear rendered diff elements safely
  if (containerRef.value) {
    while (containerRef.value.firstChild) {
      containerRef.value.removeChild(containerRef.value.firstChild);
    }
  }
}

function createDiffFileWrapper(entry: { id: string; displayPath: string }): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-file";
  wrapper.dataset.fileId = entry.id;

  const header = document.createElement("div");
  header.className = "diff-file-header";
  header.textContent = entry.displayPath;
  header.title = entry.displayPath;
  wrapper.appendChild(header);

  return wrapper;
}

function getDiffLineCollections(fileMeta: FileDiffMetadata): string[][] {
  const maybeLineCollections = fileMeta as FileDiffMetadata & {
    additionLines?: string[];
    deletionLines?: string[];
  };
  return [
    maybeLineCollections.additionLines ?? [],
    maybeLineCollections.deletionLines ?? [],
  ];
}

function shouldSkipDiffFileRender(fileMeta: FileDiffMetadata): boolean {
  let totalContentLength = 0;
  for (const lines of getDiffLineCollections(fileMeta)) {
    for (const line of lines) {
      if (line.length > MAX_RENDERABLE_DIFF_LINE_LENGTH) {
        return true;
      }
      totalContentLength += line.length;
      if (totalContentLength > MAX_RENDERABLE_DIFF_FILE_CONTENT_LENGTH) {
        return true;
      }
    }
  }
  return false;
}

function renderSkippedDiffFile(entry: DiffRenderFileEntry, context: DiffRenderContext): void {
  const skipped = document.createElement("div");
  skipped.className = "diff-file-skipped";
  skipped.textContent = t("diffView.fileSkippedTooLarge");
  entry.wrapper.appendChild(skipped);

  logDiffPerf(context.loadId, "render:file_skipped", {
    path: entry.displayPath,
    reason: entry.skipReason,
  });
}

function resolveRenderableFileMeta(
  rawFileMeta: FileDiffMetadata & DiffFilePathMetadata,
  displayPath: string,
): FileDiffMetadata {
  if (!isBazelSyntaxPath(displayPath)) {
    return rawFileMeta;
  }

  return setLanguageOverride(
    rawFileMeta,
    getSyntaxLanguageForPath(displayPath) as "python"
  );
}

function renderDiffFile(
  entry: DiffRenderFileEntry,
  pool: WorkerPoolManager | null,
  context: DiffRenderContext,
  allFilesCount: number,
  progress: DiffRenderProgress,
  fileIndex: number,
): void {
  const fileRenderStartedAt = performance.now();
  let didLogPostRender = false;
  const fileMeta = resolveRenderableFileMeta(entry.rawFileMeta, entry.displayPath);

  const instance = new FileDiff(
    {
      theme: diffTheme.value,
      diffStyle: "unified",
      diffIndicators: "classic",
      disableFileHeader: true,
      onPostRender: () => {
        if (didLogPostRender || !isActiveDiffLoad(context.loadId)) return;
        didLogPostRender = true;
        nextTick(() => {
          restoreScrollPositionForActiveLoad(context);
          applySearchHighlights();
        });
        const completedAt = performance.now();
        const sinceFileStartMs = completedAt - fileRenderStartedAt;
        const sinceLoadStartMs = completedAt - context.loadStartedAt;
        progress.completedFiles += 1;
        if (progress.firstCompletedAt == null) {
          progress.firstCompletedAt = completedAt;
          for (const resolve of progress.firstCompletedWaiters.splice(0)) {
            resolve();
          }
          logDiffPerf(context.loadId, "content:first_file_ready", {
            durationMs: roundDuration(sinceLoadStartMs),
            fileIndex,
            fileCount: allFilesCount,
            path: entry.displayPath,
            workerStats: getWorkerPoolStatsSnapshot(pool),
          });
        }
        if (sinceFileStartMs >= 250) {
          logDiffPerf(context.loadId, "content:file_ready", {
            fileIndex,
            fileCount: allFilesCount,
            path: entry.displayPath,
            sinceFileStartMs: roundDuration(sinceFileStartMs),
            sinceLoadStartMs: roundDuration(sinceLoadStartMs),
            workerStats: getWorkerPoolStatsSnapshot(pool),
          });
        }
        if (!progress.completedAllLogged && progress.completedFiles === allFilesCount) {
          progress.completedAllLogged = true;
          finishPendingScrollRestore(context);
          logDiffPerf(context.loadId, "content:all_files_ready", {
            durationMs: roundDuration(sinceLoadStartMs),
            fileCount: allFilesCount,
            firstContentMs: roundDuration(
              (progress.firstCompletedAt ?? completedAt) - context.loadStartedAt,
            ),
            workerStats: getWorkerPoolStatsSnapshot(pool),
          });
        }
      },
    },
    pool || undefined
  );

  instance.render({
    fileDiff: fileMeta,
    containerWrapper: entry.wrapper,
  });

  fileDiffInstances.push(instance);

  logDiffPerf(context.loadId, "render:file_invoked", {
    fileIndex,
    fileCount: allFilesCount,
    path: entry.displayPath,
    syncMs: roundDuration(performance.now() - fileRenderStartedAt),
    workerStats: getWorkerPoolStatsSnapshot(pool),
  });
}

async function renderDiff(patch: string, context: DiffRenderContext) {
  if (!containerRef.value) return;

  const normalizedPatchStartedAt = performance.now();
  const normalizedPatch = normalizeGitPatchForDiffParser(patch);
  const normalizedPatchDurationMs = performance.now() - normalizedPatchStartedAt;

  const parseStartedAt = performance.now();
  const patches = parsePatchFiles(normalizedPatch);
  const parseDurationMs = performance.now() - parseStartedAt;
  const allFiles = patches?.flatMap((p) => p.files || []) || [];
  if (allFiles.length === 0) {
    noDiff.value = true;
    renderedFiles.value = [];
    cleanupInstance();
    logDiffPerf(context.loadId, "parse:empty", {
      totalMs: roundDuration(performance.now() - context.loadStartedAt),
      normalizeMs: roundDuration(normalizedPatchDurationMs),
      parseMs: roundDuration(parseDurationMs),
    });
    return;
  }

  logDiffPerf(context.loadId, "parse:done", {
    normalizeMs: roundDuration(normalizedPatchDurationMs),
    parseMs: roundDuration(parseDurationMs),
    patchCount: patches.length,
    fileCount: allFiles.length,
  });

  const renderEntries: DiffRenderFileEntry[] = allFiles.map((rawFileMeta, fileIndex) => {
    const typedFileMeta = rawFileMeta as FileDiffMetadata & DiffFilePathMetadata;
    const id = `${context.loadId}:${fileIndex}`;
    const displayPath = getDisplayPath(typedFileMeta);
    return {
      id,
      rawFileMeta: typedFileMeta,
      displayPath,
      wrapper: createDiffFileWrapper({ id, displayPath }),
      skipReason: shouldSkipDiffFileRender(typedFileMeta) ? "oversized" : undefined,
    };
  });

  const renderableEntries = renderEntries.filter((entry) => entry.skipReason == null);

  renderedFiles.value = renderableEntries.map((entry) => ({
    id: entry.id,
    fileDiff: entry.rawFileMeta,
  }));

  const workerInitStartedAt = performance.now();
  const pool = await initWorkerPool();
  logDiffPerf(context.loadId, "worker_pool:ready", {
    durationMs: roundDuration(performance.now() - workerInitStartedAt),
    stats: getWorkerPoolStatsSnapshot(pool),
  });

  const cleanupStartedAt = performance.now();
  cleanupInstance();
  logDiffPerf(context.loadId, "cleanup:done", {
    durationMs: roundDuration(performance.now() - cleanupStartedAt),
  });

  for (const entry of renderEntries) {
    containerRef.value.appendChild(entry.wrapper);
  }

  const progress = {
    completedFiles: 0,
    firstCompletedAt: null as number | null,
    completedAllLogged: false,
    firstCompletedWaiters: [],
  };

  for (const entry of renderEntries) {
    if (entry.skipReason) {
      renderSkippedDiffFile(entry, context);
    }
  }

  for (let batchStart = 0; batchStart < renderableEntries.length;) {
    if (!isActiveDiffLoad(context.loadId)) {
      return;
    }

    const batchSize = batchStart === 0 ? DIFF_INITIAL_RENDER_BATCH_SIZE : DIFF_RENDER_BATCH_SIZE;
    const batch = renderableEntries.slice(batchStart, batchStart + batchSize);
    const batchStartedAt = performance.now();

    for (const [batchIndex, entry] of batch.entries()) {
      renderDiffFile(
        entry,
        pool,
        context,
        renderableEntries.length,
        progress,
        batchStart + batchIndex,
      );
    }

    logDiffPerf(context.loadId, "render:batch_invoked", {
      batchIndex: Math.floor(batchStart / DIFF_RENDER_BATCH_SIZE),
      batchSize: batch.length,
      renderedCount: Math.min(batchStart + batch.length, renderableEntries.length),
      fileCount: renderableEntries.length,
      durationMs: roundDuration(performance.now() - batchStartedAt),
      workerStats: getWorkerPoolStatsSnapshot(pool),
    });

    if (batchStart + batch.length < renderableEntries.length) {
      if (batchStart === 0) {
        await waitForFirstRenderedFile(progress);
      }
      await waitForRenderTurn();
    }

    batchStart += batch.length;
  }

  logDiffPerf(context.loadId, "render:scheduled", {
    totalMs: roundDuration(performance.now() - context.loadStartedAt),
    fileCount: renderableEntries.length,
    skippedFileCount: renderEntries.length - renderableEntries.length,
    workerStats: getWorkerPoolStatsSnapshot(pool),
  });
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
      nextTick(() => searchInputRef.value?.focus());
      return true;
    }

    if (meta && e.key === "f" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      openSearch();
      nextTick(() => searchInputRef.value?.focus());
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
    nextTick(() => searchInputRef.value?.focus());
  }
});

onMounted(() => {
  syncViewStateFromProps();
  void loadDiff({ preserveCurrentScroll: false });
  nextTick(() => diffViewRef.value?.focus());
});

onUnmounted(() => {
  activeDiffLoadId = 0;
  scrollRestorePendingLoadId = 0;
  cleanupInstance();
});

defineExpose({ refresh: loadDiff });
</script>

<template>
  <div ref="diffViewRef" class="diff-view" tabindex="-1">
    <div class="diff-toolbar">
      <div class="scope-selector">
        <button :class="{ active: scope === 'working' }" @click="setScope('working')">{{ $t('diffView.scopeWorking') }}</button>
        <button :class="{ active: scope === 'branch' }" @click="setScope('branch')">{{ $t('diffView.scopeBranch') }}</button>
      </div>
      <button
        v-if="scope === 'working'"
        class="staged-toggle"
        @click="cycleWorkingFilter()"
      >{{ workingFilterLabel }}</button>
      <button
        v-if="scope === 'branch'"
        class="branch-include-toggle staged-toggle"
        @click="cycleBranchInclude()"
      >{{ branchIncludeLabel }}</button>
    </div>
    <div v-if="error" class="diff-status diff-error">{{ error }}</div>
    <div v-else-if="noDiff && !loading" class="diff-status">{{ $t('diffView.noChanges') }}</div>
    <div ref="containerRef" class="diff-container" @scroll="handleScroll"></div>
    <div v-if="isSearching" class="search-bar">
      <span class="search-prefix">/</span>
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        v-bind="macOsTextInputAttrs"
        class="search-input"
        :placeholder="$t('diffView.searchPlaceholder')"
        @keydown="handleSearchInputKeydown"
      />
      <span v-if="searchQuery" class="search-count">{{ searchCountLabel }}</span>
    </div>
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

.diff-toolbar {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-sidebar);
  flex-shrink: 0;
}

.scope-selector {
  display: flex;
  gap: 0;
}

.scope-selector button {
  padding: 3px 12px;
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  color: var(--kn-text-muted);
  font-size: 11px;
  cursor: pointer;
}

.scope-selector button:first-child { border-radius: 4px 0 0 4px; }
.scope-selector button:last-child { border-radius: 0 4px 4px 0; }
.scope-selector button:not(:first-child) { border-left: none; }

.scope-selector button.active {
  background: var(--kn-accent);
  border-color: var(--kn-accent-hover);
  color: var(--kn-text-inverse);
}

.staged-toggle {
  margin-left: 12px;
  padding: 3px 10px;
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  color: var(--kn-text-muted);
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
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

.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--kn-border-default);
  background: var(--kn-bg-app);
  flex-shrink: 0;
}

.search-prefix {
  font-family: "SF Mono", Menlo, monospace;
  color: var(--kn-text-muted);
  font-size: 13px;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--kn-text-primary);
  font-size: 13px;
}

.search-input::placeholder {
  color: var(--kn-text-muted);
}

.search-count {
  font-size: 12px;
  color: var(--kn-text-muted);
  white-space: nowrap;
}
</style>
