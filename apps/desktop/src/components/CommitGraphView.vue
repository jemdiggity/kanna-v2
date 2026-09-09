<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../invoke";
import { useLessScroll } from "../composables/useLessScroll";
import { registerContextShortcuts } from "../composables/useShortcutContext";
import { macOsTextInputAttrs } from "../utils/textInput";
import {
  layoutCommitGraph,
  type GraphResult,
  type GraphLayout,
  type CurveDef,
} from "../utils/commitGraph";

const { t } = useI18n();

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
  /**
   * Whether this view is the one in front. `useLessScroll` binds window-level
   * keys, and a tab stays mounted behind another one, so without this a
   * background graph answered `q` and closed itself. Absent means in front,
   * which is what a modal always is while it is open.
   */
  isForeground?: () => boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const COMMIT_SPACING = 28;
const BRANCH_SPACING = 16;
const NODE_RADIUS = 4;
const GRAPH_PADDING = 12;
const TEXT_GAP = 16;

const scrollRef = ref<HTMLElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const layout = ref<GraphLayout>({
  commits: [],
  branches: [],
  curves: [],
  maxColumn: 0,
});
const headCommit = ref<string | null>(null);
const mode = ref<"auto" | "all">("auto");
const searchInputRef = ref<HTMLInputElement | null>(null);
const isSearching = ref(false);
const searchQuery = ref("");
const currentMatch = ref(1);

const scrollTop = ref(0);
const viewportHeight = ref(600);

const totalHeight = computed(
  () => layout.value.commits.length * COMMIT_SPACING + GRAPH_PADDING * 2
);

const graphWidth = computed(
  () => (layout.value.maxColumn + 1) * BRANCH_SPACING + GRAPH_PADDING * 2
);

const textStartX = computed(() => graphWidth.value + TEXT_GAP);

const canvasWidth = computed(() => textStartX.value + 750);

const visibleRange = computed(() => {
  const first = Math.max(
    0,
    Math.floor((scrollTop.value - GRAPH_PADDING) / COMMIT_SPACING) - 20
  );
  const last = Math.min(
    layout.value.commits.length - 1,
    Math.ceil(
      (scrollTop.value + viewportHeight.value - GRAPH_PADDING) / COMMIT_SPACING
    ) + 20
  );
  return { first, last };
});

const visibleCommits = computed(() => {
  const { first, last } = visibleRange.value;
  return layout.value.commits.filter((c) => c.y >= first && c.y <= last);
});

const visibleHeadCommits = computed(() =>
  headCommit.value
    ? visibleCommits.value.filter((commit) => commit.hash === headCommit.value)
    : []
);

const visibleBranches = computed(() => {
  const { first, last } = visibleRange.value;
  return layout.value.branches.filter(
    (b) => b.endRow >= first && b.startRow <= last
  );
});

const visibleCurves = computed(() => {
  const { first, last } = visibleRange.value;
  return layout.value.curves.filter(
    (c) =>
      (c.startY >= first && c.startY <= last) ||
      (c.endY >= first && c.endY <= last)
  );
});

const searchableCommits = computed(() =>
  layout.value.commits.map((commit) => ({
    hash: commit.hash,
    text: [
      commit.message,
      commit.hash,
      commit.short_hash,
      commit.author,
      ...commit.refs,
    ].join("\n").toLowerCase(),
  }))
);

const searchMatches = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return [];
  return searchableCommits.value.filter((commit) => commit.text.includes(query));
});

const matchedHashes = computed(
  () => new Set(searchMatches.value.map((match) => match.hash))
);

const activeMatchHash = computed(() => {
  if (!searchMatches.value.length) return null;
  const index = Math.max(1, Math.min(currentMatch.value, searchMatches.value.length)) - 1;
  return searchMatches.value[index]?.hash ?? null;
});

const searchCountLabel = computed(() => {
  if (!searchQuery.value) return "";
  if (!searchMatches.value.length) return t("commitGraph.searchNoMatches");
  return `${currentMatch.value}/${searchMatches.value.length}`;
});

function px(col: number): number {
  return GRAPH_PADDING + col * BRANCH_SPACING;
}

function py(row: number): number {
  return GRAPH_PADDING + row * COMMIT_SPACING;
}

function curvePath(curve: CurveDef): string {
  const x1 = px(curve.startX);
  const y1 = py(curve.startY);
  const x2 = px(curve.endX);
  const y2 = py(curve.endY);
  const cx1 = x1 * 0.1 + x2 * 0.9;
  const cy1 = y1 * 0.6 + y2 * 0.4;
  const cx2 = x1 * 0.03 + x2 * 0.97;
  const cy2 = y1 * 0.4 + y2 * 0.6;
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

function relativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function refType(name: string): "local" | "remote" | "tag" {
  if (name.includes("/")) return "remote";
  if (/^v?\d/.test(name)) return "tag";
  return "local";
}

function onScroll() {
  if (scrollRef.value) {
    scrollTop.value = scrollRef.value.scrollTop;
    viewportHeight.value = scrollRef.value.clientHeight;
  }
}

function openSearch() {
  isSearching.value = true;
}

function closeSearch() {
  isSearching.value = false;
  searchQuery.value = "";
  currentMatch.value = 1;
}

function dismiss(): boolean {
  if (isSearching.value) {
    closeSearch();
    return false;
  }

  return true;
}

function scrollToCommit(hash: string) {
  if (!scrollRef.value) return;
  const row = layout.value.commits.find((commit) => commit.hash === hash);
  if (!row) return;
  const targetY = py(row.y) - scrollRef.value.clientHeight / 2;
  scrollRef.value.scrollTop = Math.max(0, targetY);
}

function activateCurrentMatch() {
  if (!searchMatches.value.length) return;
  const index = Math.max(1, Math.min(currentMatch.value, searchMatches.value.length)) - 1;
  const match = searchMatches.value[index];
  if (!match) return;
  scrollToCommit(match.hash);
}

function nextMatch() {
  if (!searchMatches.value.length) return;
  currentMatch.value =
    currentMatch.value >= searchMatches.value.length ? 1 : currentMatch.value + 1;
  activateCurrentMatch();
}

function prevMatch() {
  if (!searchMatches.value.length) return;
  currentMatch.value =
    currentMatch.value <= 1 ? searchMatches.value.length : currentMatch.value - 1;
  activateCurrentMatch();
}

function scrollToHead() {
  if (!headCommit.value || !scrollRef.value) return;
  scrollToCommit(headCommit.value);
}

function toggleMode() {
  mode.value = mode.value === "auto" ? "all" : "auto";
  loadGraph();
}

function handleSearchInputKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
    nextTick(() => scrollRef.value?.focus());
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) {
      prevMatch();
    } else {
      nextMatch();
    }
    nextTick(() => scrollRef.value?.focus());
  }
}

watch(searchMatches, (matches) => {
  currentMatch.value = 1;
  if (matches.length > 0) {
    nextTick(() => activateCurrentMatch());
  }
});

watch(isSearching, (searching) => {
  if (searching) {
    nextTick(() => searchInputRef.value?.focus());
  }
});

defineExpose({ dismiss });

useLessScroll(scrollRef, {
  isActive: () => props.isForeground?.() ?? true,
  extraHandler: (e: KeyboardEvent) => {
    const noMods = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const meta = e.metaKey || e.ctrlKey;

    if (e.key === "/" && noMods) {
      e.preventDefault();
      openSearch();
      return true;
    }

    if (meta && e.key === "f" && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      openSearch();
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

    if (e.key === " " && noMods) {
      e.preventDefault();
      toggleMode();
      return true;
    }
    return false;
  },
  onClose: () => emit("close"),
});

registerContextShortcuts("graph", [
  { label: t("commitGraph.shortcutSearch"), display: "/", groupKey: "shortcuts.groupSearch" },
  { label: t("commitGraph.shortcutSearchAlt"), display: "⌘F", groupKey: "shortcuts.groupSearch" },
  { label: t("commitGraph.shortcutNextPrevMatch"), display: "n / N", groupKey: "shortcuts.groupSearch" },
  { label: t("commitGraph.shortcutLineUpDown"), display: "j / k", groupKey: "shortcuts.groupNavigation" },
  { label: t("commitGraph.shortcutPageUpDown"), display: "f / b", groupKey: "shortcuts.groupNavigation" },
  { label: t("commitGraph.shortcutHalfUpDown"), display: "d / u", groupKey: "shortcuts.groupNavigation" },
  { label: t("commitGraph.shortcutTopBottom"), display: "g / G", groupKey: "shortcuts.groupNavigation" },
  { label: t("commitGraph.shortcutToggleMode"), display: "Space", groupKey: "shortcuts.groupViews" },
  { label: t("commitGraph.shortcutClose"), display: "q", groupKey: "shortcuts.groupActions" },
]);

async function loadGraph() {
  loading.value = true;
  error.value = null;
  try {
    const path = props.worktreePath || props.repoPath;
    const fromRef = mode.value === "auto" ? "HEAD" : undefined;
    const result = await invoke<GraphResult>("git_graph", {
      repoPath: path,
      fromRef,
    });
    headCommit.value = result.head_commit;
    layout.value = layoutCommitGraph(result.commits);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    await nextTick();
    scrollToHead();
  }
}

onMounted(() => {
  loadGraph();
  if (scrollRef.value) {
    viewportHeight.value = scrollRef.value.clientHeight;
  }
});
</script>

<template>
  <div class="graph-wrapper">
  <div ref="scrollRef" class="graph-scroll" tabindex="-1" @scroll="onScroll">
    <div v-if="loading" class="graph-status">Loading commit graph&#x2026;</div>
    <div v-else-if="error" class="graph-status error">{{ error }}</div>
    <template v-else>
      <div class="graph-canvas" :style="{ height: totalHeight + 'px', minWidth: canvasWidth + 'px' }">
        <svg
          class="graph-svg"
          :width="graphWidth"
          :height="totalHeight"
          :viewBox="`0 0 ${graphWidth} ${totalHeight}`"
        >
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <line
            v-for="(b, i) in visibleBranches"
            :key="'b' + i"
            :x1="px(b.column)"
            :y1="py(b.startRow)"
            :x2="px(b.column)"
            :y2="py(b.endRow)"
            :stroke="b.color"
            stroke-width="2"
            stroke-opacity="0.4"
          />

          <path
            v-for="(c, i) in visibleCurves"
            :key="'c' + i"
            :d="curvePath(c)"
            :stroke="c.color"
            stroke-width="2"
            stroke-opacity="0.5"
            fill="none"
          />

          <circle
            v-for="commit in visibleCommits"
            :key="commit.hash"
            :cx="px(commit.x)"
            :cy="py(commit.y)"
            :r="NODE_RADIUS"
            :fill="commit.color"
            filter="url(#glow)"
          />

          <circle
            v-for="commit in visibleHeadCommits"
            :key="'head-' + commit.hash"
            class="head-node-marker"
            :cx="px(commit.x)"
            :cy="py(commit.y)"
            :r="NODE_RADIUS + 4"
          />
        </svg>

        <div class="commit-text-layer" :style="{ left: textStartX + 'px' }">
          <div
            v-for="commit in visibleCommits"
            :key="'t' + commit.hash"
            class="commit-row"
            :class="{
              'is-head': headCommit === commit.hash,
              'is-search-match': matchedHashes.has(commit.hash),
              'is-search-active': activeMatchHash === commit.hash,
            }"
            :style="{ top: py(commit.y) - 8 + 'px' }"
          >
            <span v-if="headCommit === commit.hash" class="head-pill">HEAD</span>
            <span
              v-for="r in commit.refs"
              :key="r"
              class="ref-pill"
              :class="'ref-' + refType(r)"
            >{{ truncate(r, 20) }}</span>
            <span class="commit-hash" :style="{ color: commit.color }">{{
              commit.short_hash
            }}</span>
            <span class="commit-message">{{
              truncate(commit.message, 72)
            }}</span>
            <span class="commit-author">{{ commit.author }}</span>
            <span class="commit-time">{{ relativeTime(commit.timestamp) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
  <div class="mode-indicator">{{ mode.toUpperCase() }}</div>
  <div v-if="isSearching" class="search-bar">
    <span class="search-prefix">/</span>
    <input
      ref="searchInputRef"
      v-model="searchQuery"
      v-bind="macOsTextInputAttrs"
      class="search-input"
      :placeholder="t('commitGraph.searchPlaceholder')"
      @keydown="handleSearchInputKeydown"
    />
    <span v-if="searchQuery" class="search-count">{{ searchCountLabel }}</span>
  </div>
  </div>
</template>

<style scoped>
.graph-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.graph-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  outline: none;
  position: relative;
}

.mode-indicator {
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 10px;
  font-weight: 600;
  color: var(--kn-text-muted);
  letter-spacing: 0.05em;
  z-index: 1;
  pointer-events: none;
}

.search-bar {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 6px;
  background: var(--kn-bg-panel);
  z-index: 2;
}

.search-prefix {
  color: var(--kn-accent);
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 12px;
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--kn-text-primary);
  font-size: 12px;
  outline: none;
}

.search-input::placeholder {
  color: var(--kn-text-muted);
}

.search-count {
  color: var(--kn-text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.graph-status {
  padding: 24px;
  color: var(--kn-text-muted);
  text-align: center;
}

.graph-status.error {
  color: var(--kn-danger);
}

.graph-canvas {
  position: relative;
  min-width: max-content;
}

.graph-svg {
  position: absolute;
  top: 0;
  left: 0;
}

.head-node-marker {
  fill: none;
  stroke: var(--kn-warning);
  stroke-width: 2.5;
  filter: none;
}

.commit-text-layer {
  position: absolute;
  top: 0;
  pointer-events: none;
}

.commit-row {
  position: absolute;
  display: flex;
  gap: 10px;
  align-items: baseline;
  white-space: nowrap;
  height: 16px;
  font-size: 12px;
  line-height: 16px;
}

.commit-row.is-search-match {
  background: var(--kn-bg-accent-subtle);
  border-radius: 4px;
}

.commit-row.is-search-active {
  background: var(--kn-bg-selected);
  box-shadow: 0 0 0 1px var(--kn-accent);
}

.commit-row.is-head {
  background: var(--kn-warning-bg);
  border-radius: 4px;
}

.commit-row.is-head.is-search-match,
.commit-row.is-head.is-search-active {
  background: var(--kn-warning-bg);
  box-shadow:
    0 0 0 1px var(--kn-warning),
    0 0 0 3px var(--kn-bg-accent-subtle);
}

.head-pill {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid var(--kn-warning);
  border-radius: 3px;
  background: var(--kn-warning-bg);
  color: var(--kn-warning);
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
}

.ref-pill {
  display: inline-block;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 15px;
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ref-local {
  background: var(--kn-bg-accent-subtle);
  color: var(--kn-accent);
  border: 1px solid var(--kn-accent);
}

.ref-remote {
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-muted);
  border: 1px solid var(--kn-border-default);
}

.ref-tag {
  background: var(--kn-bg-accent-subtle);
  color: var(--kn-accent);
  border: 1px solid var(--kn-accent);
}

.commit-hash {
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 11px;
  opacity: 0.9;
}

.commit-message {
  color: var(--kn-text-primary);
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-author {
  color: var(--kn-text-muted);
  font-size: 11px;
}

.commit-time {
  color: var(--kn-text-muted);
  font-size: 11px;
}
</style>
