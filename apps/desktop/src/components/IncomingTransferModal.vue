<script setup lang="ts">
import { useModalZIndex } from "../composables/useModalZIndex";

const props = defineProps<{
  sourceName?: string | null;
}>();

const emit = defineEmits<{
  (e: "approve"): void;
  (e: "reject"): void;
}>();

const { zIndex } = useModalZIndex();
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('reject')">
    <div class="modal-card">
      <h2 class="title">{{ $t("taskTransfer.incomingTitle") }}</h2>
      <p v-if="props.sourceName" class="subtitle">{{ props.sourceName }}</p>

      <div class="actions">
        <button class="btn btn-danger" @click="emit('reject')">
          {{ $t("taskTransfer.reject") }}
        </button>
        <button class="btn btn-primary" @click="emit('approve')">
          {{ $t("taskTransfer.approve") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--kn-overlay-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-card {
  width: 420px;
  max-width: 90vw;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  padding: 16px;
}

.title {
  font-size: 14px;
  color: var(--kn-text-primary);
  margin-bottom: 8px;
}

.subtitle {
  font-size: 12px;
  color: var(--kn-text-muted);
  margin-bottom: 14px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 5px 14px;
  border-radius: 4px;
  border: 1px solid var(--kn-border-strong);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-secondary);
  transition: background 0.15s;
}

.btn:hover {
  background: var(--kn-bg-hover);
}

.btn-primary {
  background: var(--kn-accent);
  border-color: var(--kn-accent-hover);
  color: var(--kn-text-inverse);
}

.btn-primary:hover {
  background: var(--kn-accent-hover);
}

.btn-danger {
  background: var(--kn-bg-hover);
  border-color: var(--kn-border-strong);
  color: var(--kn-text-secondary);
}

.btn-danger:hover {
  background: var(--kn-danger);
  border-color: var(--kn-danger);
  color: var(--kn-text-inverse);
}
</style>
