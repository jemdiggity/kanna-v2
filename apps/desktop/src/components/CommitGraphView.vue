<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { invoke } from "../invoke";
import { useLessScroll } from "../composables/useLessScroll";
import {
  layoutCommitGraph,
  type GraphCommit,
  type GraphLayout,
  type CurveDef,
} from "../utils/commitGraph";

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
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

const scrollTop = ref(0);
const viewportHeight = ref(600);

const totalHeight = computed(
  () => layout.value.commits.length * COMMIT_SPACING + GRAPH_PADDING * 2
);

const graphWidth = computed(
  () => (layout.value.maxColumn + 1) * BRANCH_SPACING + GRAPH_PADDING * 2
);

const textStartX = computed(() => graphWidth.value + TEXT_GAP);

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

function onScroll() {
  if (scrollRef.value) {
    scrollTop.value = scrollRef.value.scrollTop;
    viewportHeight.value = scrollRef.value.clientHeight;
  }
}

useLessScroll(scrollRef, { onClose: () => emit("close") });

async function loadGraph() {
  loading.value = true;
  error.value = null;
  try {
    const path = props.worktreePath || props.repoPath;
    const commits = await invoke<GraphCommit[]>("git_graph", {
      repoPath: path,
    });
    layout.value = layoutCommitGraph(commits);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
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
  <div ref="scrollRef" class="graph-scroll" tabindex="-1" @scroll="onScroll">
    <div v-if="loading" class="graph-status">Loading commit graph&#x2026;</div>
    <div v-else-if="error" class="graph-status error">{{ error }}</div>
    <template v-else>
      <div class="graph-canvas" :style="{ height: totalHeight + 'px' }">
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
        </svg>

        <div class="commit-text-layer" :style="{ left: textStartX + 'px' }">
          <div
            v-for="commit in visibleCommits"
            :key="'t' + commit.hash"
            class="commit-row"
            :style="{ top: py(commit.y) - 8 + 'px' }"
          >
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
</template>

<style scoped>
.graph-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  outline: none;
  position: relative;
}

.graph-status {
  padding: 24px;
  color: #888;
  text-align: center;
}

.graph-status.error {
  color: #ff7b72;
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

.commit-hash {
  font-family: "SF Mono", "Menlo", "Consolas", monospace;
  font-size: 11px;
  opacity: 0.9;
}

.commit-message {
  color: #e0e0e0;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.commit-author {
  color: #888;
  font-size: 11px;
}

.commit-time {
  color: #666;
  font-size: 11px;
}
</style>
