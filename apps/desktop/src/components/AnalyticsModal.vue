<script setup lang="ts">
import { ref, toRef } from "vue";
import { Line, Bar } from "vue-chartjs";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import type { DbHandle } from "@kanna/db";
import { useAnalytics } from "../composables/useAnalytics";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Title, Tooltip, Legend, Filler);

const props = defineProps<{
  db: DbHandle | null;
  repoId: string | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const activeView = ref(0);
const viewCount = 3;
const viewNames = ["Tasks", "Avg Time in State", "Operator"];

const {
  taskBuckets,
  avgTimeInState,
  headlineStats,
  hasData,
  loading,
  operatorMetrics,
  operatorBreakdowns,
  hasOperatorData,
} = useAnalytics(toRef(props, "db"), toRef(props, "repoId"));

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

const horizontalChartOptions = {
  indexAxis: "y" as const,
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: "#888" } },
    tooltip: {
      backgroundColor: "#1e1e1e",
      borderColor: "#444",
      borderWidth: 1,
      titleColor: "#ccc",
      bodyColor: "#ccc",
    },
  },
  scales: {
    x: { ticks: { color: "#888" }, grid: { color: "#333" }, beginAtZero: true },
    y: { ticks: { color: "#888" }, grid: { color: "#333" } },
  },
};

const lineChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    intersect: false,
    mode: "index" as const,
  },
  plugins: {
    legend: { labels: { color: "#888" } },
    tooltip: {
      backgroundColor: "#1e1e1e",
      borderColor: "#444",
      borderWidth: 1,
      titleColor: "#ccc",
      bodyColor: "#ccc",
    },
  },
  scales: {
    x: { ticks: { color: "#888" }, grid: { color: "#333" } },
    y: { ticks: { color: "#888", stepSize: 1 }, grid: { color: "#333" }, beginAtZero: true },
  },
};
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown" tabindex="0">
    <div class="analytics-modal">
      <div class="modal-header">
        <h2>{{ viewNames[activeView] }}</h2>
        <span class="hint">spacebar to switch &middot; esc to close</span>
      </div>

      <template v-if="loading">
        <div class="empty-state">Loading...</div>
      </template>

      <template v-else-if="!hasData">
        <div class="empty-state">No tasks yet</div>
      </template>

      <!-- View 0: Tasks created / closed -->
      <template v-else-if="activeView === 0">
        <div class="headline-cards">
          <div class="card">
            <div class="card-value">{{ headlineStats.totalCreated }}</div>
            <div class="card-label">Created</div>
          </div>
          <div class="card">
            <div class="card-value">{{ headlineStats.totalClosed }}</div>
            <div class="card-label">Closed</div>
          </div>
          <div class="card">
            <div class="card-value">{{ headlineStats.open }}</div>
            <div class="card-label">Open</div>
          </div>
        </div>
        <div class="chart-container">
          <Line
            :data="{
              labels: taskBuckets.map((b) => b.label),
              datasets: [
                {
                  label: 'Created',
                  data: taskBuckets.map((b) => b.created),
                  borderColor: '#0066cc',
                  backgroundColor: 'rgba(0, 102, 204, 0.1)',
                  fill: true,
                  tension: 0.3,
                  pointRadius: 3,
                  pointHoverRadius: 5,
                },
                {
                  label: 'Closed',
                  data: taskBuckets.map((b) => b.closed),
                  borderColor: '#2ea043',
                  backgroundColor: 'rgba(46, 160, 67, 0.1)',
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
          <div class="empty-state">Activity tracking started — data will appear as tasks complete.</div>
        </template>
        <template v-else>
          <div class="headline-cards">
            <div class="card busy">
              <div class="card-value">{{ formatDuration(avgTimeInState.working) }}</div>
              <div class="card-label">Avg Busy</div>
            </div>
            <div class="card unread">
              <div class="card-value">{{ formatDuration(avgTimeInState.unread) }}</div>
              <div class="card-label">Avg Unread</div>
            </div>
            <div class="card idle">
              <div class="card-value">{{ formatDuration(avgTimeInState.idle) }}</div>
              <div class="card-label">Avg Idle</div>
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
            <span class="bar-label"><span class="dot busy" /> Busy</span>
            <span class="bar-label"><span class="dot unread" /> Unread</span>
            <span class="bar-label"><span class="dot idle" /> Idle</span>
          </div>
        </template>
      </template>

      <!-- View 2: Operator -->
      <template v-else-if="activeView === 2">
        <template v-if="!hasOperatorData">
          <div class="empty-state">Operator tracking started — data will appear as you work.</div>
        </template>
        <template v-else>
          <div class="headline-cards">
            <div class="card">
              <div class="card-value">{{ operatorMetrics.avgResponseTime != null ? formatDuration(operatorMetrics.avgResponseTime) : '—' }}</div>
              <div class="card-label">Avg Response Time</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.avgDwellTime != null ? formatDuration(operatorMetrics.avgDwellTime) : '—' }}</div>
              <div class="card-label">Avg Dwell Time</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.switchesPerHour != null ? operatorMetrics.switchesPerHour.toFixed(1) : '—' }}</div>
              <div class="card-label">Switches/Hour</div>
            </div>
            <div class="card">
              <div class="card-value">{{ operatorMetrics.focusScore != null ? Math.round(operatorMetrics.focusScore * 100) + '%' : '—' }}</div>
              <div class="card-label">Focus Score</div>
            </div>
          </div>
          <div class="chart-container">
            <Bar
              :data="{
                labels: operatorBreakdowns.map((b) => b.label),
                datasets: [
                  { label: 'Dwell Time', data: operatorBreakdowns.map((b) => b.dwellTime), backgroundColor: '#0066cc' },
                  { label: 'Response Time', data: operatorBreakdowns.map((b) => b.responseTime), backgroundColor: '#d29922' },
                ],
              }"
              :options="horizontalChartOptions"
            />
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
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  outline: none;
}

.analytics-modal {
  background: #252525;
  border: 1px solid #444;
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
  color: #ccc;
}

.hint {
  font-size: 11px;
  color: #666;
}

.headline-cards {
  display: flex;
  gap: 12px;
}

.card {
  flex: 1;
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 6px;
  padding: 12px;
  text-align: center;
}

.card.busy { border-color: #0066cc; }
.card.unread { border-color: #d29922; }
.card.idle { border-color: #555; }

.card-value {
  font-size: 24px;
  font-weight: 600;
  color: #ccc;
}

.card-label {
  font-size: 11px;
  color: #888;
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

.state-segment.busy { background: #0066cc; }
.state-segment.unread { background: #d29922; }
.state-segment.idle { background: #555; }

.state-bar-labels {
  display: flex;
  justify-content: center;
  gap: 16px;
  font-size: 11px;
  color: #888;
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

.bar-label .dot.busy { background: #0066cc; }
.bar-label .dot.unread { background: #d29922; }
.bar-label .dot.idle { background: #555; }

.empty-state {
  text-align: center;
  color: #666;
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
  background: #555;
}

.dots > .dot.active {
  background: #0066cc;
}
</style>
