<script setup lang="ts">
import { computed, ref, onMounted, nextTick } from "vue";
import DiffView from "./DiffView.vue";
import { useShortcutContext } from "../composables/useShortcutContext";
import { useModalZIndex } from "../composables/useModalZIndex";
import { useKannaStore } from "../stores/kanna";
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
const currentHeadCommit = computed(() => props.reviewHeadCommit ?? "HEAD");
const baseRefLabel = computed(() => props.baseRef ?? "main");

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
    const requestDelivered = await store.requestRevision(props.taskId, {
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

function approveReview() {
  if (!props.taskId) return;
  void store.advanceStage(props.taskId);
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

defineExpose({ zIndex, bringToFront, dismiss, requestChanges });

// Escape is handled by the centralized dismiss handler in useKeyboardShortcuts
// (capture phase), which respects modal priority (e.g. closes shortcuts menu first).
onMounted(() => {
  nextTick(() => modalRef.value?.focus());
});
</script>

<template>
  <div class="modal-overlay" :class="{ maximized }" :style="{ zIndex }" @click.self="emit('close')">
    <div ref="modalRef" class="diff-modal" tabindex="-1">
      <div v-if="reviewEnabled" class="verdict-bar">
        <span>{{ $t('diffView.pendingCommentCount', { count: comments.length }) }}</span>
        <button type="button" :disabled="comments.length === 0" @click="openRequestChangesComposer">
          {{ $t('diffView.requestChanges') }}
        </button>
        <button type="button" class="approve" @click="approveReview">
          {{ $t('diffView.approve') }}
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
