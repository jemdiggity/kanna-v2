<script setup lang="ts">
export interface MentionedFileRow {
  path: string;
  line?: number;
  available: boolean;
  unavailableReason?: string;
}

defineProps<{
  rows: MentionedFileRow[];
  loading: boolean;
  error: string | null;
  overflow: boolean;
  testId?: string;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "open", index: number): void;
}>();
</script>

<template>
  <div
    class="mentioned-files-overlay"
    :data-testid="testId"
    tabindex="-1"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <div class="mentioned-files-header">
      <div>
        <strong>Mentioned files</strong>
        <span>Recently referenced by the agent</span>
      </div>
      <button type="button" @click="emit('close')">Close</button>
    </div>
    <div v-if="loading" class="mentioned-files-state">Finding files…</div>
    <div v-else-if="error" class="mentioned-files-state">{{ error }}</div>
    <div v-else-if="rows.length === 0" class="mentioned-files-state">
      No files have been mentioned yet.
    </div>
    <div v-else class="mentioned-files-list">
      <button
        v-for="(row, index) in rows"
        :key="`${row.path}:${row.line ?? ''}`"
        type="button"
        class="mentioned-file-row"
        :class="{ unavailable: !row.available }"
        :disabled="!row.available"
        :aria-label="row.available
          ? `Open file ${row.path}`
          : `${row.path} unavailable: ${row.unavailableReason}`"
        :data-testid="`mentioned-file-${row.available ? 'available' : 'unavailable'}`"
        @click="emit('open', index)"
      >
        <strong>{{ row.path.split('/').pop() }}{{ row.line ? `:${row.line}` : '' }}</strong>
        <span>{{ row.path }}</span>
        <small v-if="!row.available">Unavailable · {{ row.unavailableReason }}</small>
      </button>
      <p v-if="overflow" class="mentioned-files-more">More mentions may be available.</p>
    </div>
  </div>
</template>

<style scoped>
.mentioned-files-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  color: var(--kn-text-primary);
  background: var(--kn-terminal-bg);
}
.mentioned-files-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--kn-border-default);
}
.mentioned-files-header div { display: flex; flex-direction: column; gap: 3px; }
.mentioned-files-header strong { font-size: 16px; }
.mentioned-files-header span,
.mentioned-file-row span,
.mentioned-file-row small,
.mentioned-files-more { color: var(--kn-text-muted); }
.mentioned-files-header span { font-size: 11px; }
.mentioned-files-header button {
  color: var(--kn-accent);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.mentioned-files-list { overflow: auto; padding: 12px; }
.mentioned-file-row {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  padding: 10px 12px;
  color: var(--kn-text-primary);
  text-align: left;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-default);
  border-radius: 8px;
  cursor: pointer;
}
.mentioned-file-row:hover { border-color: var(--kn-border-strong); }
.mentioned-file-row strong,
.mentioned-file-row span { font-family: "SF Mono", Menlo, monospace; }
.mentioned-file-row strong { font-size: 13px; }
.mentioned-file-row span,
.mentioned-file-row small,
.mentioned-files-more { font-size: 11px; }
.mentioned-file-row.unavailable { opacity: 0.55; cursor: not-allowed; }
.mentioned-files-state {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  color: var(--kn-text-muted);
}
.mentioned-files-more { text-align: center; }
</style>
