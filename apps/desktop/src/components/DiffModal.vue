<script setup lang="ts">
import { computed, ref, onMounted, nextTick } from "vue";
import DiffView from "./DiffView.vue";
import {
  useEmbeddableView,
  type EmbeddableViewProps,
} from "../composables/useEmbeddableView";
import { useModalTearOff } from "../composables/useModalTearOff";
import type { RemoteTaskViewTransport } from "../modalTearOff";
import type {
  RemoteTaskDiffContent,
  RemoteTaskDiffRequest,
} from "../services/desktopRemoteTaskClient";

const modalRef = ref<HTMLElement | null>(null);

const props = defineProps<EmbeddableViewProps & {
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "working";
  initialScrollPositions?: Partial<Record<"branch" | "working", number>>;
  initialBranchInclude?: "none" | "staged" | "all";
  maximized?: boolean;
  baseRef?: string;
  viewKey?: string;
  standalone?: boolean;
  remoteDiffLoader?: (request: RemoteTaskDiffRequest) => Promise<RemoteTaskDiffContent>;
  remoteDesktopId?: string;
  remoteTaskId?: string;
  remoteTransport?: RemoteTaskViewTransport;
}>();

const {
  zIndex,
  bringToFront,
  overlayClass,
  overlayStyle,
  dismissOnScrimClick,
  focusWhenBrought,
} = useEmbeddableView(props, { context: "diff" });
focusWhenBrought(modalRef);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "scope-change", scope: "branch" | "working"): void;
  (e: "scroll-state-change", positions: Partial<Record<"branch" | "working", number>>): void;
  (e: "branch-include-change", include: "none" | "staged" | "all"): void;
}>();

const tearOff = useModalTearOff({
  enabled: computed(() => !props.standalone),
  modalRef,
  handleSelector: ".diff-toolbar",
  getContext: () => ({
    surface: "diff",
    repoPath: props.repoPath,
    ...(props.worktreePath ? { worktreePath: props.worktreePath } : {}),
    ...(props.initialScope ? { initialScope: props.initialScope } : {}),
    ...(props.initialScrollPositions ? { initialScrollPositions: props.initialScrollPositions } : {}),
    ...(props.initialBranchInclude ? { initialBranchInclude: props.initialBranchInclude } : {}),
    ...(props.baseRef ? { baseRef: props.baseRef } : {}),
    ...(props.viewKey ? { viewKey: props.viewKey } : {}),
    ...(props.remoteDesktopId ? { remoteDesktopId: props.remoteDesktopId } : {}),
    ...(props.remoteTaskId ? { remoteTaskId: props.remoteTaskId } : {}),
    ...(props.remoteTransport ? { remoteTransport: props.remoteTransport } : {}),
  }),
  onTornOff: () => emit("close"),
});

defineExpose({ zIndex, bringToFront });

// Escape is handled by the centralized dismiss handler in useKeyboardShortcuts
// (capture phase), which respects modal priority (e.g. closes shortcuts menu first).
onMounted(() => {
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div
    class="modal-overlay"
    :class="[{ maximized, standalone }, overlayClass]"
    :style="overlayStyle"
    @click.self="dismissOnScrimClick(() => emit('close'))"
  >
    <div
      ref="modalRef"
      class="diff-modal"
      tabindex="-1"
      @pointerdown="tearOff.onPointerDown"
      @pointermove="tearOff.onPointerMove"
      @pointerup="tearOff.onPointerUp"
      @pointercancel="tearOff.onPointerCancel"
    >
      <DiffView
        :repo-path="repoPath"
        :worktree-path="worktreePath"
        :initial-scope="initialScope"
        :initial-scroll-positions="initialScrollPositions"
        :initial-branch-include="initialBranchInclude"
        :base-ref="baseRef"
        :view-key="viewKey"
        :remote-diff-loader="remoteDiffLoader"
        @scope-change="emit('scope-change', $event)"
        @scroll-state-change="emit('scroll-state-change', $event)"
        @branch-include-change="emit('branch-include-change', $event)"
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

.modal-overlay.standalone {
  background: none;
}

.modal-overlay.embedded {
  position: relative;
  inset: auto;
  flex: 1;
  min-height: 0;
  background: none;
}

.standalone .diff-modal,
.embedded .diff-modal {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
}

.diff-modal :deep(.diff-toolbar) {
  cursor: default;
  user-select: none;
}

.diff-modal :deep(.diff-toolbar button) {
  cursor: pointer;
}

.maximized { background: none; }
.maximized .diff-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
}
</style>
