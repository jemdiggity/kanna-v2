<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import CommitGraphView from "./CommitGraphView.vue";
import { useShortcutContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
useShortcutContext("graph");
const { zIndex, bringToFront } = useModalZIndex();
const graphViewRef = ref<InstanceType<typeof CommitGraphView> | null>(null);

function dismiss(): boolean {
  return graphViewRef.value?.dismiss() ?? true;
}

defineExpose({ zIndex, bringToFront, dismiss });

const modalRef = ref<HTMLElement | null>(null);

defineProps<{
  repoPath: string;
  worktreePath?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

onMounted(() => {
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('close')">
    <div ref="modalRef" class="graph-modal" tabindex="-1">
      <CommitGraphView
        ref="graphViewRef"
        :repo-path="repoPath"
        :worktree-path="worktreePath"
        @close="emit('close')"
      />
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

.graph-modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 90vw;
  height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}
</style>
