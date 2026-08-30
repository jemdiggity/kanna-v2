<script setup lang="ts">
import { computed, ref, onMounted, nextTick } from "vue";
import DiffView from "./DiffView.vue";
import { useShortcutContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
import { useModalTearOff } from "../composables/useModalTearOff";
import { useKannaStore } from "../stores/kanna";
import type { RequestRevisionOptions } from "../stores/workflow";
import {
  buildRevisionPrompt,
  formatReviewAnchor,
  type PendingReviewComment,
} from "../utils/reviewComments";
useShortcutContext("diff");
const { zIndex, bringToFront } = useModalZIndex();
const store = useKannaStore();

const modalRef = ref<HTMLElement | null>(null);
const diffViewRef = ref<InstanceType<typeof DiffView> | null>(null);
const summaryComposerOpen = ref(false);
const summaryDraft = ref("");
const sendingRevision = ref(false);
const approving = ref(false);

const props = defineProps<{
  repoPath: string;
  worktreePath?: string;
  initialScope?: "branch" | "working";
  initialScrollPositions?: Partial<Record<"branch" | "working", number>>;
  initialBranchInclude?: "none" | "staged" | "all";
  maximized?: boolean;
  baseRef?: string;
  viewKey?: string;
  taskId?: string;
  reviewStage?: string;
  reviewComments?: PendingReviewComment[];
  reviewHeadCommit?: string;
  approveSignalsMerge?: boolean;
  hasRunningPost?: boolean;
  standalone?: boolean;
  requestRevisionAction?: (taskId: string, options: RequestRevisionOptions) => Promise<boolean>;
  advanceStageAction?: (taskId: string) => Promise<unknown>;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "scope-change", scope: "branch" | "working"): void;
  (e: "scroll-state-change", positions: Partial<Record<"branch" | "working", number>>): void;
  (e: "branch-include-change", include: "none" | "staged" | "all"): void;
  (e: "review-head-change", headCommit: string): void;
  (e: "review-comments-change", comments: PendingReviewComment[]): void;
}>();

const comments = computed(() => props.reviewComments ?? []);
const reviewEnabled = computed(() =>
  Boolean(props.taskId) && (props.reviewStage === "review" || props.reviewStage === "pr")
);
// "Approve & Merge" is only truthful when the task's pinned current stage
// declares the merge-signaling approve post (approveSignalsMerge comes from
// the pinned pipeline_def). Pre-change snapshots and custom workflows whose
// final stage has no such post get the generic "Approve".
const approveMergesTask = computed(() => props.approveSignalsMerge === true);
// Approval is single-flight for the full post lifetime: the local flag
// covers the request, hasRunningPost covers the running approve post. An
// ordinary repeated approval must never reach the backend's running-post
// override, which would close the task before the post finishes.
const approveDisabled = computed(() => approving.value || props.hasRunningPost === true);
const currentHeadCommit = computed(() => props.reviewHeadCommit ?? "HEAD");
const baseRefLabel = computed(() => props.baseRef ?? "main");
const tearOff = useModalTearOff({
  enabled: computed(() => !props.standalone),
  modalRef,
  handleSelector: ".diff-toolbar, .verdict-bar",
  getContext: () => ({
    surface: "diff",
    repoPath: props.repoPath,
    ...(props.worktreePath ? { worktreePath: props.worktreePath } : {}),
    ...(props.initialScope ? { initialScope: props.initialScope } : {}),
    ...(props.initialScrollPositions ? { initialScrollPositions: props.initialScrollPositions } : {}),
    ...(props.initialBranchInclude ? { initialBranchInclude: props.initialBranchInclude } : {}),
    ...(props.baseRef ? { baseRef: props.baseRef } : {}),
    ...(props.viewKey ? { viewKey: props.viewKey } : {}),
    ...(props.taskId ? { taskId: props.taskId } : {}),
    ...(props.reviewStage ? { reviewStage: props.reviewStage } : {}),
    ...(props.reviewComments ? { reviewComments: props.reviewComments } : {}),
    ...(props.reviewHeadCommit ? { reviewHeadCommit: props.reviewHeadCommit } : {}),
    ...(props.approveSignalsMerge !== undefined ? { approveSignalsMerge: props.approveSignalsMerge } : {}),
    ...(props.hasRunningPost !== undefined ? { hasRunningPost: props.hasRunningPost } : {}),
  }),
  onTornOff: () => emit("close"),
});

function openRequestChangesComposer() {
  if (!reviewEnabled.value || comments.value.length === 0) return;
  summaryComposerOpen.value = true;
  nextTick(() => {
    modalRef.value?.querySelector<HTMLTextAreaElement>(".summary-composer textarea")?.focus();
  });
}

async function submitRequestChanges() {
  if (!props.taskId || comments.value.length === 0 || sendingRevision.value) return;
  sendingRevision.value = true;
  const summary = summaryDraft.value.trim() || "Requested changes from Kanna review.";
  const prompt = buildRevisionPrompt({
    taskId: props.taskId,
    headCommit: currentHeadCommit.value,
    baseRef: baseRefLabel.value,
    comments: comments.value,
    summary: summaryDraft.value,
  });
  try {
    const requestRevision = props.requestRevisionAction ?? store.requestRevision;
    const requestDelivered = await requestRevision(props.taskId, {
      targetStage: "in progress",
      summary,
      prompt,
      metadata: {
        source: "kanna-diff-review",
        commentCount: comments.value.length,
        headCommit: currentHeadCommit.value,
      },
    });
    if (!requestDelivered) return;
    emit("review-comments-change", []);
    summaryDraft.value = "";
    summaryComposerOpen.value = false;
  } finally {
    sendingRevision.value = false;
  }
}

async function approveReview() {
  if (!props.taskId || approveDisabled.value) return;
  approving.value = true;
  try {
    const advanceStage = props.advanceStageAction ?? store.advanceStage;
    await advanceStage(props.taskId);
  } finally {
    approving.value = false;
  }
}

function dismiss(): boolean {
  if (summaryComposerOpen.value) {
    summaryComposerOpen.value = false;
    return false;
  }
  return diffViewRef.value?.dismissReviewLayer() ?? true;
}

function requestChanges() {
  openRequestChangesComposer();
}

defineExpose({ zIndex, bringToFront, dismiss, requestChanges, approveReview });

// Escape is handled by the centralized dismiss handler in useKeyboardShortcuts
// (capture phase), which respects modal priority (e.g. closes shortcuts menu first).
onMounted(() => {
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div class="modal-overlay" :class="{ maximized, standalone }" :style="{ zIndex }" @click.self="emit('close')">
    <div
      ref="modalRef"
      class="diff-modal"
      tabindex="-1"
      @pointerdown="tearOff.onPointerDown"
      @pointermove="tearOff.onPointerMove"
      @pointerup="tearOff.onPointerUp"
      @pointercancel="tearOff.onPointerCancel"
    >
      <div v-if="reviewEnabled" class="verdict-bar">
        <span>{{ $t('diffView.pendingCommentCount', { count: comments.length }) }}</span>
        <button type="button" :disabled="comments.length === 0" @click="openRequestChangesComposer">
          {{ $t('diffView.requestChanges') }}
        </button>
        <button type="button" class="approve" :disabled="approveDisabled" @click="approveReview">
          {{ approveMergesTask ? $t('diffView.approveMerge') : $t('diffView.approve') }}
        </button>
      </div>
      <DiffView
        ref="diffViewRef"
        :repo-path="repoPath"
        :worktree-path="worktreePath"
        :initial-scope="initialScope"
        :initial-scroll-positions="initialScrollPositions"
        :initial-branch-include="initialBranchInclude"
        :base-ref="baseRef"
        :view-key="viewKey"
        :review-enabled="reviewEnabled"
        :review-comments="comments"
        :review-head-commit="reviewHeadCommit"
        @scope-change="emit('scope-change', $event)"
        @scroll-state-change="emit('scroll-state-change', $event)"
        @branch-include-change="emit('branch-include-change', $event)"
        @review-head-change="emit('review-head-change', $event)"
        @review-comments-change="emit('review-comments-change', $event)"
        @close="emit('close')"
      />
      <div v-if="summaryComposerOpen" class="summary-composer">
        <div class="summary-panel">
          <h2>{{ $t('diffView.requestChanges') }}</h2>
          <div class="summary-comment-list">
            <div v-for="comment in comments" :key="comment.id" class="summary-comment">
              <code>{{ formatReviewAnchor(comment) }}</code>
              <pre>{{ comment.excerpt }}</pre>
              <p>{{ comment.note }}</p>
            </div>
          </div>
          <textarea
            v-model="summaryDraft"
            :placeholder="$t('diffView.summaryPlaceholder')"
            @keydown.meta.enter.prevent="submitRequestChanges"
          />
          <div class="summary-actions">
            <button type="button" @click="summaryComposerOpen = false">{{ $t('actions.cancel') }}</button>
            <button type="button" class="primary" :disabled="sendingRevision || comments.length === 0" @click="submitRequestChanges">
              {{ $t('diffView.sendRequestChanges') }}
            </button>
          </div>
        </div>
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
  position: relative;
}

.modal-overlay.standalone {
  background: none;
}

.standalone .diff-modal {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
}

.diff-modal :deep(.diff-toolbar),
.verdict-bar {
  cursor: default;
  user-select: none;
}

.diff-modal :deep(.diff-toolbar button),
.verdict-bar button {
  cursor: pointer;
}

.verdict-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-panel);
  color: var(--kn-text-muted);
  font-size: 12px;
}

.verdict-bar button,
.summary-actions button {
  padding: 4px 10px;
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-primary);
  font-size: 12px;
  cursor: pointer;
}

.verdict-bar button:disabled,
.summary-actions button:disabled {
  opacity: 0.5;
  cursor: default;
}

.verdict-bar .approve,
.summary-actions .primary {
  background: var(--kn-accent);
  border-color: var(--kn-accent-hover);
  color: var(--kn-text-inverse);
}

.summary-composer {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--kn-overlay-scrim);
}

.summary-panel {
  width: min(720px, calc(100% - 48px));
  max-height: calc(100% - 48px);
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  box-shadow: var(--kn-shadow-modal);
}

.summary-panel h2 {
  margin: 0 0 12px;
  font-size: 16px;
}

.summary-comment-list {
  min-height: 0;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--kn-border-default);
  border-radius: 4px;
  background: var(--kn-bg-app);
}

.summary-comment {
  padding: 10px;
  border-bottom: 1px solid var(--kn-border-default);
}

.summary-comment:last-child {
  border-bottom: none;
}

.summary-comment code {
  color: var(--kn-accent);
  font-size: 12px;
}

.summary-comment pre {
  margin: 8px 0;
  color: var(--kn-text-muted);
  font-family: "SF Mono", Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}

.summary-comment p {
  margin: 0;
  color: var(--kn-text-primary);
}

.summary-panel textarea {
  margin-top: 12px;
  min-height: 96px;
  resize: vertical;
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-primary);
  font: inherit;
  padding: 8px;
}

.summary-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.maximized { background: none; }
.maximized .diff-modal {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  border: none;
}
</style>
