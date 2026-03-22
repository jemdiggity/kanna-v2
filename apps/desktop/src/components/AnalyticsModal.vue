<script setup lang="ts">
import { ref, toRef } from "vue";
import { Bar } from "vue-chartjs";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import type { DbHandle } from "@kanna/db";
import { useAnalytics } from "../composables/useAnalytics";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const props = defineProps<{
  db: DbHandle | null;
  repoId: string | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();

const activeView = ref(0);
const viewCount = 2;
const viewNames = ["Throughput", "Activity Time"];

const {
  throughputBuckets,
  activityBreakdowns,
  headlineStats,
  hasData,
  loading,
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

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: "#888" } },
  },
  scales: {
    x: { ticks: { color: "#888" }, grid: { color: "#333" } },
    y: { ticks: { color: "#888" }, grid: { color: "#333" }, beginAtZero: true },
  },
};

const horizontalChartOptions = {
  indexAxis: "y" as const,
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: "#888" } },
    tooltip: {
      callbacks: {
        label: (ctx: any) => `${ctx.dataset.label}: ${formatDuration(ctx.raw)}`,
      },
    },
  },
  scales: {
    x: { stacked: true, ticks: { color: "#888", callback: (v: any) => formatDuration(v) }, grid: { color: "#333" }, beginAtZero: true },
    y: { stacked: true, ticks: { color: "#ccc" }, grid: { color: "#333" } },
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

      <!-- View 0: Throughput -->
      <template v-else-if="activeView === 0">
        <div class="headline-cards">
          <div class="card">
            <div class="card-value">{{ headlineStats.tasksCreated }}</div>
            <div class="card-label">Created</div>
          </div>
          <div class="card">
            <div class="card-value">{{ headlineStats.tasksCompleted }}</div>
            <div class="card-label">Completed</div>
          </div>
          <div class="card">
            <div class="card-value">{{ headlineStats.completionRate != null ? headlineStats.completionRate + '%' : '—' }}</div>
            <div class="card-label">Completion Rate</div>
          </div>
        </div>
        <div class="chart-container">
          <Bar
            :data="{
              labels: throughputBuckets.map((b) => b.label),
              datasets: [
                { label: 'Created', data: throughputBuckets.map((b) => b.created), backgroundColor: '#0066cc' },
                { label: 'Completed', data: throughputBuckets.map((b) => b.completed), backgroundColor: '#2ea043' },
              ],
            }"
            :options="chartOptions"
          />
        </div>
      </template>

      <!-- View 1: Activity Time -->
      <template v-else-if="activeView === 1">
        <template v-if="activityBreakdowns.length === 0">
          <div class="empty-state">Activity tracking started — data will appear as agents run.</div>
        </template>
        <template v-else>
          <div class="headline-cards">
            <div class="card">
              <div class="card-value">{{ formatDuration(headlineStats.avgWorking) }}</div>
              <div class="card-label">Avg Working</div>
            </div>
            <div class="card">
              <div class="card-value">{{ formatDuration(headlineStats.avgIdle) }}</div>
              <div class="card-label">Avg Idle</div>
            </div>
            <div class="card">
              <div class="card-value">{{ formatDuration(headlineStats.avgUnread) }}</div>
              <div class="card-label">Avg Waiting</div>
            </div>
          </div>
          <div class="chart-container">
            <Bar
              :data="{
                labels: activityBreakdowns.map((b) => b.label),
                datasets: [
                  { label: 'Working', data: activityBreakdowns.map((b) => b.working), backgroundColor: '#0066cc' },
                  { label: 'Waiting', data: activityBreakdowns.map((b) => b.unread), backgroundColor: '#d29922' },
                  { label: 'Idle', data: activityBreakdowns.map((b) => b.idle), backgroundColor: '#555' },
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

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #555;
}

.dot.active {
  background: #0066cc;
}
</style>
