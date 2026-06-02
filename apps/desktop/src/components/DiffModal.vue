<script setup lang="ts">
import { ref, onMounted, nextTick } from "vue";
import DiffView from "./DiffView.vue";
import { useShortcutContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
useShortcutContext("diff");
const { zIndex, bringToFront } = useModalZIndex();
defineExpose({ zIndex, bringToFront });

const modalRef = ref<HTMLElement | null>(null);

defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "working";
  initialScrollPositions?: Partial<Record<"branch" | "working", number>>;
  maximized?: boolean;
  baseRef?: string;
  viewKey?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "scope-change", scope: "branch" | "working"): void;
  (e: "scroll-state-change", positions: Partial<Record<"branch" | "working", number>>): void;
}>();

// Escape is handled by the centralized dismiss handler in useKeyboardShortcuts
// (capture phase), which respects modal priority (e.g. closes shortcuts menu first).
onMounted(() => {
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div class="modal-overlay" :class="{ maximized }" :style="{ zIndex }" @click.self="emit('close')">
    <div ref="modalRef" class="diff-modal" tabindex="-1">
      <DiffView
        :repo-path="repoPath"
        :worktree-path="worktreePath"
        :initial-scope="initialScope"
        :initial-scroll-positions="initialScrollPositions"
        :base-ref="baseRef"
        :view-key="viewKey"
        @scope-change="emit('scope-change', $event)"
        @scroll-state-change="emit('scroll-state-change', $event)"
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

.diff-modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}

.maximized { background: none; }
.maximized .diff-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
}
</style>
