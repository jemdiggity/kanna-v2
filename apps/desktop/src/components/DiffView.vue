<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { useLessScroll } from "../composables/useLessScroll";
import { invoke } from "../invoke";
import { registerContextShortcuts } from "../composables/useShortcutContext";
import { useDiffRenderer, type DiffRenderContext } from "../composables/useDiffRenderer";
import type { DiffReviewAnchor } from "../composables/useDiffRenderer";
import { useDiffSearch, type DiffSearchBarHandle } from "../composables/useDiffSearch";
import { useDiffBranchBaseRef } from "../composables/useDiffBranchBaseRef";
import { getDiffTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";
import { debugLog } from "../utils/debugLog";
import type { GraphResult } from "../utils/commitGraph";
import { formatReviewAnchor, type PendingReviewComment } from "../utils/reviewComments";
import DiffContentPane from "./DiffContentPane.vue";
import DiffToolbar from "./DiffToolbar.vue";
import DiffSearchBar from "./DiffSearchBar.vue";
import type {
  RemoteTaskDiffContent,
  RemoteTaskDiffRequest,
} from "../services/desktopRemoteTaskClient";

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
  { label: t('diffView.shortcutToggleComments'), display: "c", groupKey: "shortcuts.groupViews" },
  { label: t('diffView.shortcutSubmitComment'), display: "⌘Enter", groupKey: "shortcuts.groupActions" },
  { label: t('diffView.shortcutRequestChanges'), display: "⇧⌘S", groupKey: "shortcuts.groupActions" },
  { label: t('diffView.shortcutApprove'), display: "⌘S", groupKey: "shortcuts.groupActions" },
  { label: t('diffView.shortcutToggleContext'), display: "a", groupKey: "shortcuts.groupViews" },
  { label: t('diffView.shortcutClose'), display: "q", groupKey: "shortcuts.groupActions" },
]);

type WorkingFilter = "all" | "unstaged" | "staged";
type BranchInclude = "none" | "staged" | "all";
type DiffScope = "branch" | "working";
type DiffContextMode = "compact" | "all";
type DiffScrollPositions = Partial<Record<DiffScope, number>>;
interface DiffContentPaneHandle { getContainerElement: () => HTMLElement | null; }
interface DiffScrollAnchor {
  filePath: string;
  lineNumber: string;
  lineType: string | null;
  viewportOffset: number;
}
interface ActiveDiffScrollAnchor {
  loadId: number;
  anchor: DiffScrollAnchor;
  lineElement: HTMLElement | null;
}
interface LoadDiffOptions {
  preserveCurrentScroll?: boolean;
  scrollAnchor?: DiffScrollAnchor | null;
}

const workingFilterOrder: WorkingFilter[] = ["all", "unstaged", "staged"];
const branchIncludeOrder: BranchInclude[] = ["none", "staged", "all"];
const FULL_DIFF_CONTEXT_LINES = 0xffffffff;

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: DiffScope;
  initialScrollPositions?: DiffScrollPositions;
  initialBranchInclude?: BranchInclude;
  baseRef?: string;
  viewKey?: string;
  reviewEnabled?: boolean;
  reviewComments?: PendingReviewComment[];
  reviewHeadCommit?: string;
  remoteDiffLoader?: (request: RemoteTaskDiffRequest) => Promise<RemoteTaskDiffContent>;
}>();
const baseRef = computed(() => props.baseRef);
const reviewEnabled = computed(() => Boolean(props.reviewEnabled) && scope.value === "branch");
const reviewComments = computed(() => props.reviewComments ?? []);

const emit = defineEmits<{
  (e: "scope-change", scope: DiffScope): void;
  (e: "scroll-state-change", positions: DiffScrollPositions): void;
  (e: "branch-include-change", include: BranchInclude): void;
  (e: "review-head-change", headCommit: string): void;
  (e: "review-comments-change", comments: PendingReviewComment[]): void;
  (e: "close"): void;
}>();

const diffViewRef = ref<HTMLElement | null>(null);
const contentPaneRef = ref<DiffContentPaneHandle | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const searchBarRef = ref<DiffSearchBarHandle | null>(null);
const diffContent = ref("");
const loading = ref(false);
const error = ref<string | null>(null);
const noDiff = ref(false);
const diffTruncated = ref(false);
const workingFilter = ref<WorkingFilter>("all");
const branchInclude = ref<BranchInclude>(normalizeBranchInclude(props.initialBranchInclude));
const scope = ref<DiffScope>(props.initialScope === "branch" ? "branch" : "working");
const contextMode = ref<DiffContextMode>("compact");
const scrollPositions = ref<DiffScrollPositions>(cloneScrollPositions(props.initialScrollPositions));
const commentDrawerOpen = ref(false);
const composerNote = ref("");
const activeComposer = ref<DiffReviewAnchor | null>(null);
const composerDrafts = new Map<string, string>();

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

const allLines = computed(() => contextMode.value === "all");
const contextLabel = computed(() =>
  allLines.value ? t('diffView.contextAllLines') : t('diffView.contextCompact')
);

let nextDiffLoadId = 0;
let activeDiffLoadId = 0;
let scrollRestorePendingLoadId = 0;
let activeDiffScrollAnchor: ActiveDiffScrollAnchor | null = null;
let applySearchHighlightsFromSearch = () => {};

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
  applySearchHighlights() {
    applySearchHighlightsFromSearch();
  },
  setNoDiff(nextNoDiff) {
    noDiff.value = nextNoDiff;
  },
  reviewEnabled,
  onReviewAnchor(anchor) {
    openReviewComposer(anchor);
  },
});

const {
  isSearching,
  searchQuery,
  searchCountLabel,
  openSearch,
  closeSearch,
  focusSearchInput,
  nextMatch,
  prevMatch,
  applySearchHighlights: applySearchHighlightsFromComposable,
  handleSearchInputKeydown,
} = useDiffSearch({
  containerRef,
  renderedFiles,
  searchBarRef,
  t,
  focusDiffView() {
    diffViewRef.value?.focus();
  },
});

applySearchHighlightsFromSearch = applySearchHighlightsFromComposable;

const { resolveBranchBaseRef } = useDiffBranchBaseRef(baseRef);

function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function isActiveDiffLoad(loadId: number): boolean {
  return activeDiffLoadId === loadId;
}

function logDiffPerf(
  loadId: number,
  stage: string,
  details: Record<string, unknown>,
) {
  debugLog(`[DiffView][perf] load#${loadId} ${stage}`, details);
}

function cloneScrollPositions(positions?: DiffScrollPositions): DiffScrollPositions {
  return positions ? { ...positions } : {};
}

function normalizeBranchInclude(include?: BranchInclude): BranchInclude {
  return include === "staged" || include === "all" ? include : "none";
}

function syncContainerRef() {
  containerRef.value = contentPaneRef.value?.getContainerElement() ?? null;
}

function emitScrollStateChange() {
  emit("scroll-state-change", { ...scrollPositions.value });
}

function buildComposerKey(anchor: DiffReviewAnchor): string {
  return `${anchor.filePath}:${anchor.startLine}-${anchor.endLine}`;
}

function newCommentId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openReviewComposer(anchor: DiffReviewAnchor) {
  if (!reviewEnabled.value) return;
  const key = buildComposerKey(anchor);
  activeComposer.value = anchor;
  composerNote.value = composerDrafts.get(key) ?? "";
  nextTick(() => {
    const textarea = diffViewRef.value?.querySelector<HTMLTextAreaElement>(".review-composer textarea");
    textarea?.focus();
  });
}

function closeReviewComposer() {
  if (!activeComposer.value) return;
  composerDrafts.set(buildComposerKey(activeComposer.value), composerNote.value);
  activeComposer.value = null;
}

function submitReviewComposer() {
  const anchor = activeComposer.value;
  if (!anchor) return;
  const note = composerNote.value.trim();
  if (!note) return;
  const nextComments: PendingReviewComment[] = [
    ...reviewComments.value,
    {
      id: newCommentId(),
      filePath: anchor.filePath,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      excerpt: anchor.excerpt,
      note,
      headCommit: props.reviewHeadCommit ?? "HEAD",
      overlayTop: anchor.overlayTop,
    },
  ];
  composerDrafts.delete(buildComposerKey(anchor));
  activeComposer.value = null;
  composerNote.value = "";
  commentDrawerOpen.value = true;
  emit("review-comments-change", nextComments);
}

function updateReviewComment(commentId: string, note: string) {
  emit("review-comments-change", reviewComments.value.map((comment) =>
    comment.id === commentId ? { ...comment, note } : comment,
  ));
}

function deleteReviewComment(commentId: string) {
  emit("review-comments-change", reviewComments.value.filter((comment) => comment.id !== commentId));
}

function isStaleComment(comment: PendingReviewComment): boolean {
  return Boolean(props.reviewHeadCommit) && comment.headCommit !== props.reviewHeadCommit;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function getDiffFilePath(wrapper: HTMLElement): string {
  const header = wrapper.querySelector<HTMLElement>(".diff-file-header");
  return header?.title || header?.textContent || "";
}

function getRenderedCodeLines(wrapper: HTMLElement): HTMLElement[] {
  return Array.from(wrapper.querySelectorAll<HTMLElement>("diffs-container"))
    .flatMap((diffContainer) => Array.from(
      diffContainer.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [],
    ));
}

function getFileWrapper(filePath: string): HTMLElement | null {
  const container = containerRef.value;
  if (!container) return null;
  return Array.from(container.querySelectorAll<HTMLElement>(".diff-file"))
    .find((candidate) => getDiffFilePath(candidate) === filePath) ?? null;
}

function captureScrollAnchor(): DiffScrollAnchor | null {
  const container = containerRef.value;
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();

  for (const wrapper of container.querySelectorAll<HTMLElement>(".diff-file")) {
    const filePath = getDiffFilePath(wrapper);
    if (!filePath) continue;
    const line = getRenderedCodeLines(wrapper).find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
    });
    if (!line) continue;
    const lineNumber = line.getAttribute("data-line");
    if (lineNumber == null) continue;
    return {
      filePath,
      lineNumber,
      lineType: line.getAttribute("data-line-type"),
      viewportOffset: line.getBoundingClientRect().top - containerRect.top,
    };
  }

  return null;
}

function findAnchoredLine(activeAnchor: ActiveDiffScrollAnchor): HTMLElement | null {
  if (activeAnchor.lineElement?.isConnected) {
    return activeAnchor.lineElement;
  }
  const anchor = activeAnchor.anchor;
  const wrapper = getFileWrapper(anchor.filePath);
  if (!wrapper) {
    activeAnchor.lineElement = null;
    return null;
  }
  const line = getRenderedCodeLines(wrapper).find((candidate) =>
    candidate.getAttribute("data-line") === anchor.lineNumber
      && candidate.getAttribute("data-line-type") === anchor.lineType
  ) ?? null;
  activeAnchor.lineElement = line;
  return line;
}

function getElementOverlayTop(element: HTMLElement): number | null {
  const container = containerRef.value;
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return Math.max(0, elementRect.top - containerRect.top + container.scrollTop);
}

function findRenderedLineTop(anchor: { filePath: string; startLine: number }): number | null {
  const wrapper = getFileWrapper(anchor.filePath);
  if (!wrapper) return null;
  const lineSelector = `[data-line="${anchor.startLine}"]`;
  const lineNumberText = String(anchor.startLine);
  const diffContainers = Array.from(wrapper.querySelectorAll<HTMLElement>("diffs-container"));
  for (const diffContainer of diffContainers) {
    const root = diffContainer.shadowRoot;
    if (!root) continue;
    const line = root.querySelector<HTMLElement>(lineSelector);
    const lineTop = line ? getElementOverlayTop(line) : null;
    if (lineTop != null) return lineTop;

    const lineNumber = Array.from(root.querySelectorAll<HTMLElement>("[data-line-number-content]"))
      .find((candidate) => candidate.textContent?.trim() === lineNumberText);
    const lineNumberTop = lineNumber ? getElementOverlayTop(lineNumber) : null;
    if (lineNumberTop != null) return lineNumberTop;
  }
  return null;
}

function scrollToReviewTop(top: number) {
  const container = containerRef.value;
  if (!container) return;
  container.scrollTo({ top: Math.max(0, top - 12), behavior: "smooth" });
}

function jumpToReviewAnchor(anchor: { filePath: string; startLine: number; overlayTop?: number }) {
  if (scope.value !== "branch") {
    void setScope("branch").then(() => jumpToReviewAnchor(anchor));
    return;
  }
  nextTick(() => {
    const container = containerRef.value;
    if (!container) return;
    if (anchor.overlayTop != null && Number.isFinite(anchor.overlayTop)) {
      scrollToReviewTop(anchor.overlayTop);
      return;
    }
    const renderedLineTop = findRenderedLineTop(anchor);
    if (renderedLineTop != null) {
      scrollToReviewTop(renderedLineTop);
      return;
    }
    const wrapper = getFileWrapper(anchor.filePath);
    if (!wrapper) return;
    scrollToReviewTop(wrapper.offsetTop);
  });
}

function dismissReviewLayer(): boolean {
  if (activeComposer.value) {
    closeReviewComposer();
    return false;
  }
  if (commentDrawerOpen.value) {
    commentDrawerOpen.value = false;
    return false;
  }
  return true;
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
  if (!containerRef.value || allLines.value) return;
  updateScrollPosition(scope.value, containerRef.value.scrollTop);
}

function restoreScrollPosition() {
  if (!containerRef.value) return;
  const top = scrollPositions.value[scope.value] ?? 0;
  containerRef.value.scrollTo({ top, behavior: "auto" });
}

function restoreScrollAnchor(activeAnchor: ActiveDiffScrollAnchor): boolean {
  const container = containerRef.value;
  const line = findAnchoredLine(activeAnchor);
  if (!container || !line) return false;
  const anchor = activeAnchor.anchor;
  const containerRect = container.getBoundingClientRect();
  const lineRect = line.getBoundingClientRect();
  const top = Math.max(
    0,
    container.scrollTop + lineRect.top - containerRect.top - anchor.viewportOffset,
  );
  container.scrollTo({ top, behavior: "auto" });
  return true;
}

function restoreScrollAnchorForActiveLoad(context: DiffRenderContext): boolean {
  if (!isActiveDiffLoad(context.loadId)) return false;
  const activeAnchor = activeDiffScrollAnchor;
  if (!activeAnchor || activeAnchor.loadId !== context.loadId) return false;
  return restoreScrollAnchor(activeAnchor);
}

function restoreScrollPositionForActiveLoad(context: DiffRenderContext) {
  if (!isActiveDiffLoad(context.loadId)) return;
  if (restoreScrollAnchorForActiveLoad(context)) return;
  if ((scrollPositions.value[scope.value] ?? 0) <= 0) return;
  restoreScrollPosition();
}

function finishPendingScrollRestore(context: DiffRenderContext) {
  if (scrollRestorePendingLoadId !== context.loadId) return;
  restoreScrollPositionForActiveLoad(context);
  scrollRestorePendingLoadId = 0;
}

function clearScrollAnchorForLoad(loadId: number) {
  if (activeDiffScrollAnchor?.loadId === loadId) {
    activeDiffScrollAnchor = null;
  }
}

function syncViewStateFromProps() {
  scope.value = props.initialScope === "branch" ? "branch" : "working";
  scrollPositions.value = cloneScrollPositions(props.initialScrollPositions);
  branchInclude.value = normalizeBranchInclude(props.initialBranchInclude);
}

async function loadDiff(options: LoadDiffOptions = {}) {
  const scrollAnchor = options.scrollAnchor === undefined
    && options.preserveCurrentScroll !== false
    && allLines.value
      ? captureScrollAnchor()
      : options.scrollAnchor ?? null;
  if (options.preserveCurrentScroll !== false) {
    saveCurrentScrollPosition();
  }
  emit("scope-change", scope.value);
  closeSearch();
  const path = props.worktreePath || props.repoPath;
  const loadId = ++nextDiffLoadId;
  activeDiffLoadId = loadId;
  activeDiffScrollAnchor = scrollAnchor
    ? { loadId, anchor: scrollAnchor, lineElement: null }
    : null;
  const loadStartedAt = performance.now();
  const renderContext: DiffRenderContext = {
    loadId,
    loadStartedAt,
    allLines: allLines.value,
  };
  const contextLines = allLines.value ? FULL_DIFF_CONTEXT_LINES : undefined;
  loading.value = true;
  error.value = null;
  noDiff.value = false;
  diffTruncated.value = false;
  scrollRestorePendingLoadId = (scrollPositions.value[scope.value] ?? 0) > 0 ? loadId : 0;
  logDiffPerf(loadId, "start", {
    scope: scope.value,
    path,
    hasExplicitBaseRef: Boolean(props.baseRef),
    workingFilter: scope.value === "working" ? workingFilter.value : undefined,
    branchInclude: scope.value === "branch" ? branchInclude.value : undefined,
    contextLines,
  });

  try {
    let patch = "";
    let truncated = false;

    if (props.remoteDiffLoader) {
      const request: RemoteTaskDiffRequest = scope.value === "working"
        ? { scope: "working", mode: workingFilter.value }
        : { scope: "branch", mode: branchInclude.value };
      const remoteDiff = await props.remoteDiffLoader(request);
      patch = remoteDiff.patch;
      truncated = remoteDiff.truncated;
    } else if (scope.value === "working") {
      const diffStartedAt = performance.now();
      const args: { repoPath: string; mode: WorkingFilter; contextLines?: number } = {
        repoPath: path,
        mode: workingFilter.value,
      };
      if (contextLines !== undefined) args.contextLines = contextLines;
      patch = await invoke<string>("git_diff", args);
      logDiffPerf(loadId, "git_diff:done", {
        durationMs: roundDuration(performance.now() - diffStartedAt),
        mode: workingFilter.value,
        contextLines,
      });
    } else {
      // "branch" scope — diff from merge base
      void resolveHeadCommit(path);
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
      const args: {
        repoPath: string;
        from: string;
        mode: BranchInclude;
        contextLines?: number;
      } = {
        repoPath: path,
        from: mergeBase,
        mode: branchInclude.value,
      };
      if (contextLines !== undefined) args.contextLines = contextLines;
      patch = await invoke<string>("git_diff_branch_range", args);
      logDiffPerf(loadId, "git_diff_branch_range:done", {
        durationMs: roundDuration(performance.now() - diffRangeStartedAt),
        mode: branchInclude.value,
        contextLines,
      });
    }

    if (!isActiveDiffLoad(loadId)) {
      return;
    }
    diffTruncated.value = truncated;

    if (!patch?.trim() && !truncated) {
      noDiff.value = true;
      diffContent.value = "";
      renderedFiles.value = [];
      cleanupInstance();
      scrollRestorePendingLoadId = 0;
      clearScrollAnchorForLoad(loadId);
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
    if (!restoreScrollAnchorForActiveLoad(renderContext)) {
      restoreScrollPosition();
    }
  } catch (e: unknown) {
    if (!isActiveDiffLoad(loadId)) {
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    error.value = `Task diff unavailable: ${message}`;
    scrollRestorePendingLoadId = 0;
    clearScrollAnchorForLoad(loadId);
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

async function resolveHeadCommit(path: string) {
  try {
    const result = await invoke<GraphResult>("git_graph", {
      repoPath: path,
      maxCount: 1,
      fromRef: "HEAD",
    });
    if (result.head_commit) {
      emit("review-head-change", result.head_commit);
    }
  } catch (error) {
    console.debug("[DiffView] failed to resolve review head commit:", error);
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

function toggleContextLines() {
  const expanding = !allLines.value;
  const scrollAnchor = expanding ? captureScrollAnchor() : null;
  if (expanding) {
    saveCurrentScrollPosition();
  }
  contextMode.value = allLines.value ? "compact" : "all";
  void loadDiff({ preserveCurrentScroll: false, scrollAnchor });
}

function refreshBranchDiffOnWindowFocus() {
  if (scope.value !== "branch" || loading.value) return;
  void loadDiff({ preserveCurrentScroll: true });
}

function handleScroll() {
  if (loading.value || scrollRestorePendingLoadId === activeDiffLoadId) return;
  saveCurrentScrollPosition();
}

useLessScroll(containerRef, {
  extraHandler(e) {
    const noMods = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "/" && noMods) {
      e.preventDefault();
      openSearch();
      focusSearchInput();
      return true;
    }

    if (meta && e.key === "f" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      openSearch();
      focusSearchInput();
      return true;
    }

    if (e.key === "n" && noMods && isSearching.value) {
      e.preventDefault();
      nextMatch();
      return true;
    }

    if (e.key === "c" && noMods) {
      e.preventDefault();
      commentDrawerOpen.value = !commentDrawerOpen.value;
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
    if (e.key === "a" && noMods) {
      e.preventDefault();
      toggleContextLines();
      return true;
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

onMounted(() => {
  syncContainerRef();
  syncViewStateFromProps();
  void loadDiff({ preserveCurrentScroll: false });
  window.addEventListener("focus", refreshBranchDiffOnWindowFocus);
  nextTick(() => diffViewRef.value?.focus());
});

onUnmounted(() => {
  activeDiffLoadId = 0;
  scrollRestorePendingLoadId = 0;
  activeDiffScrollAnchor = null;
  window.removeEventListener("focus", refreshBranchDiffOnWindowFocus);
  cleanupInstance();
});

defineExpose({ refresh: loadDiff, dismissReviewLayer, jumpToReviewAnchor });
</script>

<template>
  <div ref="diffViewRef" class="diff-view" tabindex="-1">
    <DiffToolbar
      :scope="scope"
      :working-filter-label="workingFilterLabel"
      :branch-include-label="branchIncludeLabel"
      :context-label="contextLabel"
      :all-lines="allLines"
      @set-scope="setScope"
      @cycle-working-filter="cycleWorkingFilter()"
      @cycle-branch-include="cycleBranchInclude()"
      @toggle-context-lines="toggleContextLines()"
    />
    <div
      v-if="diffTruncated"
      class="diff-truncated-warning"
      data-testid="diff-truncated-warning"
      role="alert"
    >
      Diff truncated at 1 MiB. The patch shown below is incomplete.
    </div>
    <DiffContentPane
      ref="contentPaneRef"
      :error="error"
      :no-diff="noDiff"
      :loading="loading"
      @scroll="handleScroll"
    />
    <div
      v-if="activeComposer && reviewEnabled"
      class="review-composer"
      :style="{ top: `${activeComposer.overlayTop ?? 48}px` }"
    >
      <div class="review-composer-anchor">{{ formatReviewAnchor(activeComposer) }}</div>
      <pre class="review-composer-excerpt">{{ activeComposer.excerpt }}</pre>
      <textarea
        v-model="composerNote"
        :placeholder="$t('diffView.commentPlaceholder')"
        @keydown.meta.enter.prevent="submitReviewComposer"
      />
      <div class="review-composer-actions">
        <button type="button" @click="closeReviewComposer">{{ $t('actions.cancel') }}</button>
        <button type="button" class="primary" :disabled="!composerNote.trim()" @click="submitReviewComposer">{{ $t('diffView.addComment') }}</button>
      </div>
    </div>
    <aside v-if="commentDrawerOpen" class="comment-drawer">
      <header>
        <strong>{{ $t('diffView.commentsTitle') }}</strong>
        <button type="button" @click="commentDrawerOpen = false">{{ $t('actions.close') }}</button>
      </header>
      <div v-if="reviewComments.length === 0" class="comment-empty">{{ $t('diffView.noComments') }}</div>
      <div v-for="comment in reviewComments" :key="comment.id" class="comment-card">
        <button type="button" class="comment-anchor" @click="jumpToReviewAnchor(comment)">
          {{ formatReviewAnchor(comment) }}
        </button>
        <div v-if="isStaleComment(comment)" class="comment-stale">
          {{ $t('diffView.staleComment', { sha: shortSha(comment.headCommit) }) }}
        </div>
        <pre>{{ comment.excerpt }}</pre>
        <textarea
          :value="comment.note"
          @input="event => updateReviewComment(comment.id, (event.target as HTMLTextAreaElement).value)"
        />
        <div class="comment-actions">
          <button type="button" @click="jumpToReviewAnchor(comment)">{{ $t('diffView.jumpToComment') }}</button>
          <button type="button" @click="deleteReviewComment(comment.id)">{{ $t('actions.delete') }}</button>
        </div>
      </div>
    </aside>
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
  position: relative;
}

.diff-truncated-warning {
  flex: 0 0 auto;
  padding: 9px 14px;
  border-top: 1px solid color-mix(in srgb, var(--kn-warning) 55%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--kn-warning) 55%, transparent);
  background: color-mix(in srgb, var(--kn-warning) 14%, var(--kn-code-bg));
  color: var(--kn-warning);
  font-weight: 650;
  letter-spacing: 0.01em;
}

.review-composer {
  position: absolute;
  left: 72px;
  right: 340px;
  z-index: 5;
  max-width: 720px;
  padding: 10px;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 6px;
  box-shadow: var(--kn-shadow-modal);
}

.review-composer-anchor,
.comment-anchor {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.review-composer-excerpt,
.comment-card pre {
  max-height: 120px;
  overflow: auto;
  margin: 8px 0;
  padding: 8px;
  background: var(--kn-bg-app);
  border: 1px solid var(--kn-border-default);
  border-radius: 4px;
  color: var(--kn-text-muted);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}

.review-composer textarea,
.comment-card textarea {
  width: 100%;
  min-height: 76px;
  resize: vertical;
  box-sizing: border-box;
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-primary);
  font: inherit;
  padding: 8px;
}

.review-composer-actions,
.comment-actions,
.comment-drawer header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.review-composer-actions button,
.comment-actions button,
.comment-drawer header button {
  padding: 4px 10px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-primary);
  font-size: 12px;
  cursor: pointer;
}

.review-composer-actions .primary {
  background: var(--kn-accent);
  border-color: var(--kn-accent-hover);
  color: var(--kn-text-inverse);
}

.review-composer-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.comment-drawer {
  position: absolute;
  top: 38px;
  right: 0;
  bottom: 0;
  z-index: 4;
  width: min(360px, 42vw);
  overflow: auto;
  background: var(--kn-bg-panel);
  border-left: 1px solid var(--kn-border-strong);
  box-shadow: var(--kn-shadow-modal);
}

.comment-drawer header {
  position: sticky;
  top: 0;
  justify-content: space-between;
  padding: 10px;
  background: var(--kn-bg-panel);
  border-bottom: 1px solid var(--kn-border-default);
}

.comment-empty {
  padding: 14px;
  color: var(--kn-text-muted);
}

.comment-card {
  padding: 10px;
  border-bottom: 1px solid var(--kn-border-default);
}

.comment-anchor {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--kn-accent);
  cursor: pointer;
}

.comment-stale {
  margin-top: 4px;
  color: var(--kn-warning);
  font-size: 12px;
}
</style>
