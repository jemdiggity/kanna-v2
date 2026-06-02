<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useModalZIndex } from "../composables/useModalZIndex";
import type { TransferPeerOption } from "../utils/taskTransfer";

const props = defineProps<{
  peers: TransferPeerOption[];
  loading?: boolean;
  actionPending?: boolean;
  title?: string;
  actionLabel?: string;
  requireTrusted?: boolean;
}>();

const emit = defineEmits<{
  (e: "select", peerId: string): void;
  (e: "cancel"): void;
}>();

const { zIndex } = useModalZIndex();
const selectedPeerId = ref<string | null>(null);
const selectedPeer = computed(() =>
  props.peers.find((peer) => peer.id === selectedPeerId.value) ?? null,
);

watch(
  () => props.peers,
  (peers) => {
    if (!selectedPeerId.value) return;
    if (!peers.some((peer) => peer.id === selectedPeerId.value)) {
      selectedPeerId.value = null;
    }
  },
);

function confirmSelect() {
  if (props.actionPending) return;
  if (!selectedPeerId.value) return;
  if ((props.requireTrusted ?? true) && !selectedPeer.value?.trusted) return;
  emit("select", selectedPeerId.value);
}
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('cancel')">
    <div class="modal-card">
      <h2 class="title">{{ title ?? $t("taskTransfer.pushToMachine") }}</h2>

      <div v-if="loading" class="state-text">{{ $t("common.loading") }}</div>

      <div v-else-if="peers.length === 0" class="state-text">
        {{ $t("taskTransfer.noPeersFound") }}
      </div>

      <div v-else class="peer-list">
        <button
          v-for="peer in peers"
          :key="peer.id"
          class="peer-row"
          :class="{ selected: selectedPeerId === peer.id }"
          @click="selectedPeerId = peer.id"
        >
          <span class="peer-name">{{ peer.name }}</span>
          <span v-if="peer.subtitle" class="peer-subtitle">{{ peer.subtitle }}</span>
        </button>
      </div>

      <div class="actions">
        <button class="btn btn-danger" @click="emit('cancel')">
          {{ $t("actions.cancel") }}
        </button>
        <button
          class="btn btn-primary"
          :disabled="!selectedPeerId || loading || actionPending || ((requireTrusted ?? true) && !selectedPeer?.trusted)"
          @click="confirmSelect"
        >
          {{ actionPending ? $t("common.loading") : (actionLabel ?? $t("taskTransfer.pushToMachine")) }}
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
  width: 520px;
  max-width: 92vw;
  max-height: 70vh;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
}

.title {
  padding: 14px 16px;
  border-bottom: 1px solid var(--kn-border-default);
  font-size: 14px;
  font-weight: 600;
  color: var(--kn-text-primary);
}

.state-text {
  padding: 16px;
  color: var(--kn-text-muted);
  font-size: 13px;
}

.peer-list {
  max-height: 45vh;
  overflow-y: auto;
}

.peer-row {
  width: 100%;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--kn-border-default);
  color: var(--kn-text-secondary);
  text-align: left;
  padding: 10px 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.peer-row:hover {
  background: var(--kn-bg-hover);
}

.peer-row.selected {
  background: var(--kn-bg-selected);
}

.peer-name {
  font-size: 13px;
  font-weight: 500;
}

.peer-subtitle {
  font-size: 11px;
  color: var(--kn-text-muted);
}

.actions {
  border-top: 1px solid var(--kn-border-default);
  padding: 12px 14px;
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

.btn:hover:enabled {
  background: var(--kn-bg-hover);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn-primary {
  background: var(--kn-accent);
  border-color: var(--kn-accent-hover);
  color: var(--kn-text-inverse);
}

.btn-primary:hover:enabled {
  background: var(--kn-accent-hover);
}

.btn-danger {
  background: var(--kn-bg-hover);
  border-color: var(--kn-border-strong);
  color: var(--kn-text-secondary);
}

.btn-danger:hover:enabled {
  background: var(--kn-danger);
  border-color: var(--kn-danger);
  color: var(--kn-text-inverse);
}
</style>
