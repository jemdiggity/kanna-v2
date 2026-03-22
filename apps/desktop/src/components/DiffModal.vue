<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import DiffView from "./DiffView.vue";

defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "commit" | "working";
  maximized?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "scope-change", scope: "branch" | "commit" | "working"): void;
}>();

// Use capture phase so Escape reaches us before xterm's handler consumes it
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.stopPropagation();
    emit("close");
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown, true));
onUnmounted(() => window.removeEventListener("keydown", onKeydown, true));
</script>

<template>
  <div class="modal-overlay" :class="{ maximized }" @click.self="emit('close')">
    <div class="diff-modal">
      <DiffView :repo-path="repoPath" :worktree-path="worktreePath" :initial-scope="initialScope" @scope-change="emit('scope-change', $event)" @close="emit('close')" />
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
}

.diff-modal {
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 8px;
  width: 90vw;
  height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.maximized { background: none; }
.maximized .diff-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
}
</style>
