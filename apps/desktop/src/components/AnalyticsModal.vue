<script setup lang="ts">
import { ref, computed, toRef, onMounted, nextTick } from "vue";
import {
  useEmbeddableView,
  type EmbeddableViewProps,
} from "../composables/useEmbeddableView";
import { useI18n } from "vue-i18n";
import { Line } from "vue-chartjs";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { useAnalytics } from "../composables/useAnalytics";
import { getChartTheme } from "../theme/theme";
import { useThemeRuntime } from "../theme/runtime";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const props = defineProps<EmbeddableViewProps & {
  repoId: string | null;
}>();

const { zIndex, bringToFront, overlayClass, overlayStyle, dismissOnScrimClick } =
  useEmbeddableView(props);
defineExpose({ zIndex, bringToFront });
const emit = defineEmits<{ (e: "close"): void }>();

const { t } = useI18n();
const { effectiveAppTheme } = useThemeRuntime();
const chartTheme = computed(() => getChartTheme(effectiveAppTheme.value));

const activeView = ref(0);
const viewCount = 3;
const viewNames = computed(() => [t('analytics.viewTasks'), t('analytics.viewAvgTime'), t('analytics.viewOperator')]);

const {
  taskBuckets,
  avgTimeInState,
  headlineStats,
  hasData,
  loading,
  operatorMetrics,
  hasOperatorData,
} = useAnalytics(toRef(props, "repoId"));

const overlayRef = ref<HTMLDivElement | null>(null);

onMounted(() => {
  nextTick(() => overlayRef.value?.focus());
});

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    emit("close");
  } else if (e.key === " ") {
    e.preventDefault();
    e.stopPropagation();
    activeView.value = (activeView.value + 1) % viewCount;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const lineChartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    intersect: false,
    mode: "index" as const,
  },
  plugins: {
    legend: { labels: { color: chartTheme.value.label } },
    tooltip: {
      backgroundColor: chartTheme.value.tooltipBackground,
      borderColor: chartTheme.value.tooltipBorder,
      borderWidth: 1,
      titleColor: chartTheme.value.tooltipText,
      bodyColor: chartTheme.value.tooltipText,
    },
  },
  scales: {
    x: { ticks: { color: chartTheme.value.label }, grid: { color: chartTheme.value.grid } },
    y: { ticks: { color: chartTheme.value.label, stepSize: 1 }, grid: { color: chartTheme.value.grid }, beginAtZero: true },
  },
}));
</script>

<template>
  <div
    ref="overlayRef"
    :class="overlayClass"
    :style="overlayStyle"
    tabindex="0"
    @click.self="dismissOnScrimClick(() => emit('close'))"
    @keydown="handleKeydown"
  >
    <div class="analytics-modal">
      <div class="modal-header">
        <h2>{{ viewNames[activeView] }}</h2>
        <span class="hint">{{ $t('analytics.hint') }}</span>
      </div>

      <template v-if="loading">
        <div class="empty-state">{{ $t('analytics.loading') }}</div>
      </template>

      <template v-else-if="!hasData">
        <div class="empty-state">{{ $t('analytics.noTasks') }}</div>
      </template>

      <!-- View 0: Tasks created / closed -->
      <template v-else-if="activeView === 0">
        <div class="headline-cards">
          <div class="card">
            <div class="card-value">{{ headlineStats.totalCreated }}</div>
            <div class="card-label">{{ $t('analytics.labelCreated') }}</div>
          </div>
          <div class="card">
            <div class="card-value">{{ headlineStats.totalClosed }}</div>
            <div class="card-label">{{ $t('analytics.labelClosed') }}</div>
          </div>
          <div class="card">
            <div class="card-value">{{ headlineStats.open }}</div>
            <div class="card-label">{{ $t('analytics.labelOpen') }}</div>
          </div>
        </div>
        <div class="chart-container">
          <Line
            :data="{
              labels: taskBuckets.map((b) => b.label),
              datasets: [
                {
                  label: t('analytics.labelCreated'),
                  data: taskBuckets.map((b) => b.created),
                  borderColor: chartTheme.createdLine,
                  backgroundColor: chartTheme.createdFill,
                  fill: true,
                  tension: 0.3,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                },
                {
                  label: t('analytics.labelClosed'),
                  data: taskBuckets.map((b) => b.closed),
                  borderColor: chartTheme.closedLine,
                  backgroundColor: chartTheme.closedFill,
                  fill: true,
                  tension: 0.3,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                },
              ],
            }"
            :options="lineChartOptions"
          />
        </div>
      </template>

      <!-- View 1: Avg Time in State -->
      <template v-else-if="activeView === 1">
        <template v-if="avgTimeInState.working === 0 && avgTimeInState.idle === 0 && avgTimeInState.unread === 0">
          <div class="empty-state">{{ $t('analytics.activityTrackingStarted') }}</div>
        </template>
        <template v-else>
          <div class="headline-cards">
            <div class="card busy">
              <div class="card-value">{{ formatDuration(avgTimeInState.working) }}</div>
              <div class="card-label">{{ $t('analytics.avgBusy') }}</div>
            </div>
            <div class="card unread">
              <div class="card-value">{{ formatDuration(avgTimeInState.unread) }}</div>
              <div class="card-label">{{ $t('analytics.avgUnread') }}</div>
            </div>
            <div class="card idle">
              <div class="card-value">{{ formatDuration(avgTimeInState.idle) }}</div>
              <div class="card-label">{{ $t('analytics.avgIdle') }}</div>
            </div>
          </div>
          <div class="state-bar">
            <div
              class="state-segment busy"
              :style="{ flex: avgTimeInState.working }"
            />
            <div
              class="state-segment unread"
              :style="{ flex: avgTimeInState.unread }"
            />
            <div
              class="state-segment idle"
              :style="{ flex: avgTimeInState.idle }"
            />
          </div>
          <div class="state-bar-labels">
            <span class="bar-label"><span class="dot busy" /> {{ $t('analytics.busy') }}</span>
            <span class="bar-label"><span class="dot unread" /> {{ $t('analytics.unread') }}</span>
            <span class="bar-label"><span class="dot idle" /> {{ $t('analytics.idle') }}</span>
          </div>
        </template>
      </template>

      <!-- View 2: Operator -->
      <template v-else-if="activeView === 2">
        <template v-if="!hasOperatorData">
          <div class="empty-state">{{ $t('analytics.operatorTrackingStarted') }}</div>
        </template>
        <template v-else>
          <div class="headline-cards">
            <div class="card">
              <div class="card-value">{{ operatorMetrics.avgResponseTime != null ? formatDuration(operatorMetrics.avgResponseTime) : '—' }}</div>
              <div class="card-label">{{ $t('analytics.avgResponseTime') }}</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.avgDwellTime != null ? formatDuration(operatorMetrics.avgDwellTime) : '—' }}</div>
              <div class="card-label">{{ $t('analytics.avgDwellTime') }}</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.switchesPerHour != null ? operatorMetrics.switchesPerHour.toFixed(1) : '—' }}</div>
              <div class="card-label">{{ $t('analytics.switchesPerHour') }}</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.focusScore != null ? Math.round(operatorMetrics.focusScore * 100) + '%' : '—' }}</div>
              <div class="card-label">{{ $t('analytics.focusScore') }}</div>
            </div>
          </div>
        </template>
      </template>

      <!-- Dot indicators -->
      <div class="dots">
        <span v-for="i in viewCount" :key="i" class="dot" :class="{ active: activeView === i - 1 }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.embedded .analytics-modal {
  width: 100%;
  height: 100%;
  max-width: none;
  border: none;
  border-radius: 0;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--kn-overlay-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
}

.analytics-modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 720px;
  max-width: 90vw;
  max-height: 80vh;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.modal-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--kn-text-secondary);
}

.hint {
  font-size: 11px;
  color: var(--kn-text-muted);
}

.headline-cards {
  display: flex;
  gap: 12px;
}

.card {
  flex: 1;
  background: var(--kn-bg-sidebar);
  border: 1px solid var(--kn-border-default);
  border-radius: 6px;
  padding: 12px;
  text-align: center;
}

.card.busy { border-color: var(--kn-accent); }
.card.unread { border-color: var(--kn-warning); }
.card.idle { border-color: var(--kn-border-strong); }

.card-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--kn-text-secondary);
}

.card-label {
  font-size: 11px;
  color: var(--kn-text-muted);
  margin-top: 4px;
}

.chart-container {
  height: 300px;
  position: relative;
}

.state-bar {
  display: flex;
  height: 32px;
  border-radius: 6px;
  overflow: hidden;
  gap: 2px;
}

.state-segment {
  min-width: 2px;
  transition: flex 0.3s ease;
}

.state-segment.busy { background: var(--kn-accent); }
.state-segment.unread { background: var(--kn-warning); }
.state-segment.idle { background: var(--kn-border-strong); }

.state-bar-labels {
  display: flex;
  justify-content: center;
  gap: 16px;
  font-size: 11px;
  color: var(--kn-text-muted);
}

.bar-label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.bar-label .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.bar-label .dot.busy { background: var(--kn-accent); }
.bar-label .dot.unread { background: var(--kn-warning); }
.bar-label .dot.idle { background: var(--kn-border-strong); }

.empty-state {
  text-align: center;
  color: var(--kn-text-muted);
  padding: 48px 0;
  font-size: 14px;
}

.dots {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.dots > .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--kn-border-strong);
}

.dots > .dot.active {
  background: var(--kn-accent);
}
</style>
