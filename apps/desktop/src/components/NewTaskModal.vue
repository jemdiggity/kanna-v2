<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { invoke } from "../invoke";
import type { AgentProvider } from "@kanna/db";
import { useModalZIndex } from "../composables/useModalZIndex";
import { registerContextShortcuts } from "../composables/useShortcutContext";
import { macOsTextInputAttrs } from "../utils/textInput";
import { filterBaseBranchCandidates } from "../utils/baseBranchPicker";
import type { AgentExecutionType } from "../stores/agentExecutionType";
const { zIndex } = useModalZIndex();

registerContextShortcuts("newTask", [
  { label: "Switch agent", display: "⇧⌘[ / ⇧⌘]", groupKey: "shortcuts.groupActions" },
]);

const props = defineProps<{
  defaultAgentProvider?: AgentProvider;
  pipelines?: string[];
  defaultPipeline?: string;
  baseBranches?: string[];
  defaultBaseBranch?: string;
  defaultBranchName?: string;
}>();

const emit = defineEmits<{
  submit: [prompt: string, agentProvider: AgentProvider, pipelineName: string, baseBranch: string, agentType: AgentExecutionType];
  cancel: [];
}>();

const prompt = ref("");
const agentProvider = ref<AgentProvider>(props.defaultAgentProvider ?? "claude");
const displayMode = ref<AgentExecutionType>("agent");
const rawModeExplicitlySelected = ref(false);
const pipelineOptions = computed(() => {
  if (props.pipelines && props.pipelines.length > 0) return props.pipelines;
  return ["default"];
});
const selectedPipeline = ref<string>(props.defaultPipeline ?? pipelineOptions.value[0] ?? "default");
const showPipelinePicker = ref(false);
const pipelineLabelId = "pipeline-label";
const pipelineActionLabelId = "pipeline-action-label";
const pipelineValueId = "pipeline-value";
const pipelineToggleId = "pipeline-toggle";
const pipelinePickerId = "pipeline-picker";
const defaultBranchName = computed(() => props.defaultBranchName ?? "main");
const selectableBaseBranches = computed(() => props.baseBranches ?? []);
const defaultSelectableBaseBranch = computed<string | null>(() => {
  const branches = selectableBaseBranches.value;
  if (props.defaultBaseBranch && branches.includes(props.defaultBaseBranch)) {
    return props.defaultBaseBranch;
  }

  const originDefault = `origin/${defaultBranchName.value}`;
  if (branches.includes(originDefault)) return originDefault;
  if (branches.includes(defaultBranchName.value)) return defaultBranchName.value;
  return null;
});
const selectedBaseBranch = ref<string | null>(defaultSelectableBaseBranch.value);
const showBaseBranchPicker = ref(false);
const baseBranchQuery = ref("");
const selectedBaseBranchIndex = ref(0);
const visibleBaseBranches = computed(() =>
  filterBaseBranchCandidates(
    selectableBaseBranches.value,
    baseBranchQuery.value,
    defaultBranchName.value,
  ),
);
const textareaRef = ref<HTMLTextAreaElement>();
const baseBranchSearchRef = ref<HTMLInputElement | null>(null);

const MAX_VISIBLE_BRANCH_ROWS = 7;
const BRANCH_ROW_HEIGHT_PX = 36;
const baseBranchOptionsMaxHeight = `${MAX_VISIBLE_BRANCH_ROWS * BRANCH_ROW_HEIGHT_PX}px`;

const providers: Array<AgentProvider> = ["claude", "copilot", "codex", "opencode"];
const availableProviders = ref<Array<AgentProvider>>([...providers]);

function providerLabel(provider: AgentProvider): string {
  if (provider === "claude") return "Claude";
  if (provider === "copilot") return "Copilot";
  if (provider === "codex") return "Codex";
  return "OpenCode";
}

const supportsThemedMode = computed(() => agentProvider.value === "claude" || agentProvider.value === "codex");

watch(supportsThemedMode, (supported) => {
  if (!supported) {
    displayMode.value = "pty";
    return;
  }
  if (!rawModeExplicitlySelected.value) {
    displayMode.value = "agent";
  }
}, { immediate: true });

function selectDisplayMode(mode: AgentExecutionType) {
  if (mode === "agent" && !supportsThemedMode.value) return;
  displayMode.value = mode;
  rawModeExplicitlySelected.value = mode === "pty";
}

// "Direct CLI" = the raw terminal (PTY); unchecked = the themed GUI view.
const directCli = computed<boolean>({
  get: () => displayMode.value === "pty",
  set: (checked) => selectDisplayMode(checked ? "pty" : "agent"),
});

function cycleProvider(direction: -1 | 1) {
  const idx = availableProviders.value.indexOf(agentProvider.value);
  if (idx === -1) return;
  agentProvider.value = availableProviders.value[(idx + direction + availableProviders.value.length) % availableProviders.value.length];
}

onMounted(async () => {
  textareaRef.value?.focus();
  try {
    // Detect installed CLIs and filter options
    const checks = await Promise.all(providers.map(async (p) => {
      try {
        await invoke("which_binary", { name: p });
        return p;
      } catch (error) {
        console.debug(`[newtask] CLI binary not found or unavailable: ${p}`, error);
        return null as AgentProvider | null;
      }
    }));
    const found = checks.filter(Boolean) as AgentProvider[];
    if (found.length > 0) availableProviders.value = found;
    else availableProviders.value = [...providers]; // if none detected, keep all options

    // Ensure selected provider is available; prefer defaultAgentProvider when provided
    const preferred = props.defaultAgentProvider ?? agentProvider.value;
    if (availableProviders.value.includes(preferred)) {
      agentProvider.value = preferred;
    } else {
      agentProvider.value = availableProviders.value[0];
    }
  } catch (e) {
    console.debug("[newtask] cli detection failed:", e);
  }
});

watch(baseBranchQuery, () => {
  selectedBaseBranchIndex.value = 0;
});

const hasValidBaseBranch = computed(() =>
  selectedBaseBranch.value !== null && selectableBaseBranches.value.includes(selectedBaseBranch.value),
);

watch([defaultSelectableBaseBranch, selectableBaseBranches], ([defaultBranch, candidates]) => {
  if (selectedBaseBranch.value === null || !candidates.includes(selectedBaseBranch.value)) {
    selectedBaseBranch.value = defaultBranch;
  }
}, { immediate: true });

watch(showBaseBranchPicker, async (open) => {
  if (open) {
    baseBranchQuery.value = "";
    selectedBaseBranchIndex.value = selectedBaseBranch.value === null
      ? 0
      : Math.max(0, visibleBaseBranches.value.indexOf(selectedBaseBranch.value));
    await nextTick();
    baseBranchSearchRef.value?.focus();
    return;
  }

  baseBranchQuery.value = "";
  selectedBaseBranchIndex.value = 0;
});

function handleSubmit() {
  const text = prompt.value.trim();
  if (!text || !hasValidBaseBranch.value || selectedBaseBranch.value === null) return;
  emit("submit", text, agentProvider.value, selectedPipeline.value, selectedBaseBranch.value, displayMode.value);
  prompt.value = "";
}

function handleBaseBranchSelect(branch: string) {
  selectedBaseBranch.value = branch;
  showBaseBranchPicker.value = false;
}

function toggleBaseBranchPicker() {
  showBaseBranchPicker.value = !showBaseBranchPicker.value;
}

function clampSelectedBaseBranchIndex(nextIndex: number): number {
  if (visibleBaseBranches.value.length === 0) return 0;
  return Math.min(Math.max(nextIndex, 0), visibleBaseBranches.value.length - 1);
}

function isSubmitShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.altKey;
}

function handleBaseBranchSearchKeydown(event: KeyboardEvent) {
  if (isSubmitShortcut(event)) {
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    showBaseBranchPicker.value = false;
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    selectedBaseBranchIndex.value = clampSelectedBaseBranchIndex(selectedBaseBranchIndex.value + 1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectedBaseBranchIndex.value = clampSelectedBaseBranchIndex(selectedBaseBranchIndex.value - 1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const branch = visibleBaseBranches.value[selectedBaseBranchIndex.value];
    if (branch) handleBaseBranchSelect(branch);
  }
}

function handlePipelineSelect(pipeline: string) {
  selectedPipeline.value = pipeline;
  showPipelinePicker.value = false;
  nextTick(() => {
    document.getElementById(pipelineToggleId)?.focus();
  });
}

function focusPipelineOption(pipeline: string) {
  nextTick(() => {
    document.getElementById(`pipeline-option-${pipeline}`)?.focus();
  });
}

function focusSelectedPipelineOption() {
  focusPipelineOption(selectedPipeline.value);
}

function handlePipelineToggle() {
  showPipelinePicker.value = !showPipelinePicker.value;
  if (showPipelinePicker.value) focusSelectedPipelineOption();
}

function handlePipelineToggleKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!showPipelinePicker.value) showPipelinePicker.value = true;
    focusSelectedPipelineOption();
    return;
  }

  if (e.key === "Escape" && showPipelinePicker.value) {
    e.preventDefault();
    showPipelinePicker.value = false;
  }
}

function handlePipelineOptionKeydown(e: KeyboardEvent, index: number) {
  const options = pipelineOptions.value;
  const lastIndex = options.length - 1;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    const nextIndex = index === lastIndex ? 0 : index + 1;
    focusPipelineOption(options[nextIndex]);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    const nextIndex = index === 0 ? lastIndex : index - 1;
    focusPipelineOption(options[nextIndex]);
    return;
  }

  if (e.key === "Home") {
    e.preventDefault();
    focusPipelineOption(options[0]);
    return;
  }

  if (e.key === "End") {
    e.preventDefault();
    focusPipelineOption(options[lastIndex]);
    return;
  }

  if (e.key === "Enter" || e.key === " ") {
    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    showPipelinePicker.value = false;
    document.getElementById(pipelineToggleId)?.focus();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) {
    return;
  }

  if (isSubmitShortcut(e)) {
    e.preventDefault();
    handleSubmit();
    return;
  }

  // ⇧⌘[ / ⇧⌘] to switch agent provider
  if (e.metaKey && e.shiftKey && (e.key === "[" || e.key === "{")) {
    e.preventDefault();
    e.stopPropagation();
    cycleProvider(-1);
    return;
  }
  if (e.metaKey && e.shiftKey && (e.key === "]" || e.key === "}")) {
    e.preventDefault();
    e.stopPropagation();
    cycleProvider(1);
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  }
}
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('cancel')">
    <div class="modal" @keydown="handleKeydown">
      <div class="modal-header">
        <h3>{{ $t('tasks.newTask') }}</h3>
        <button class="agent-provider" type="button" @mousedown.prevent @click="cycleProvider(1)">
          {{ providerLabel(agentProvider) }}
        </button>
      </div>
      <div class="modal-body">
        <textarea
          ref="textareaRef"
          v-model="prompt"
          v-bind="macOsTextInputAttrs"
          class="prompt-input"
          :placeholder="$t('tasks.descriptionPlaceholder')"
          rows="6"
        />
        <div class="pipeline-row">
          <label class="pipeline-label">{{ $t("tasks.baseBranch") }}</label>
          <div class="base-branch-dropdown-shell">
            <div class="base-branch-row">
              <span
                class="base-branch-value"
                :class="{ invalid: !hasValidBaseBranch }"
                data-testid="base-branch-value"
              >
                {{ selectedBaseBranch ?? $t("tasks.baseBranchRequired") }}
              </span>
              <button
                id="base-branch-toggle"
                type="button"
                class="change-link"
                data-testid="base-branch-toggle"
                @mousedown.prevent
                @click="toggleBaseBranchPicker"
              >
                <span data-testid="base-branch-change-link">{{ $t("addRepo.change") }}</span>
              </button>
            </div>

            <div
              v-if="showBaseBranchPicker"
              class="base-branch-dropdown"
              data-testid="base-branch-dropdown"
            >
              <input
                ref="baseBranchSearchRef"
                v-model="baseBranchQuery"
                v-bind="macOsTextInputAttrs"
                class="text-input base-branch-search"
                type="text"
                :placeholder="$t('tasks.baseBranchSearchPlaceholder')"
                data-testid="base-branch-search"
                @keydown="handleBaseBranchSearchKeydown"
              />
              <div
                class="base-branch-options"
                :style="{ maxHeight: baseBranchOptionsMaxHeight }"
                data-testid="base-branch-options"
              >
                <button
                  v-for="(branch, index) in visibleBaseBranches"
                  :key="branch"
                  type="button"
                  class="base-branch-option"
                  :class="{ selected: branch === selectedBaseBranch, active: index === selectedBaseBranchIndex }"
                  :data-testid="`base-branch-option-${branch}`"
                  @mouseenter="selectedBaseBranchIndex = index"
                  @mousedown.prevent
                  @click="handleBaseBranchSelect(branch)"
                >
                  {{ branch }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="pipeline-row">
          <label :id="pipelineLabelId" class="pipeline-label">Pipeline</label>
          <div class="base-branch-dropdown-shell">
            <div class="base-branch-row pipeline-value-row">
              <span :id="pipelineActionLabelId" class="sr-only">{{ $t("addRepo.change") }}</span>
              <span :id="pipelineValueId" class="base-branch-value" data-testid="pipeline-value">{{ selectedPipeline }}</span>
              <button
                :id="pipelineToggleId"
                type="button"
                class="change-link"
                data-testid="pipeline-toggle"
                :aria-controls="pipelinePickerId"
                :aria-expanded="showPipelinePicker"
                aria-haspopup="listbox"
                :aria-labelledby="`${pipelineActionLabelId} ${pipelineLabelId} ${pipelineValueId}`"
                @mousedown.prevent
                @click="handlePipelineToggle"
                @keydown="handlePipelineToggleKeydown"
              >
                {{ $t("addRepo.change") }}
              </button>
            </div>

            <div
              v-if="showPipelinePicker"
              :id="pipelinePickerId"
              class="base-branch-dropdown"
              data-testid="pipeline-dropdown"
              role="listbox"
              :aria-labelledby="pipelineLabelId"
            >
              <div
                class="base-branch-options"
                :style="{ maxHeight: baseBranchOptionsMaxHeight }"
                data-testid="pipeline-options"
              >
                <button
                  v-for="(name, index) in pipelineOptions"
                  :key="name"
                  :id="`pipeline-option-${name}`"
                  type="button"
                  class="base-branch-option"
                  role="option"
                  :class="{ selected: name === selectedPipeline }"
                  :aria-selected="name === selectedPipeline"
                  :data-testid="`pipeline-option-${name}`"
                  :tabindex="name === selectedPipeline ? 0 : -1"
                  @mousedown.prevent
                  @click="handlePipelineSelect(name)"
                  @keydown="handlePipelineOptionKeydown($event, index)"
                >
                  {{ name }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="pipeline-row">
          <label class="pipeline-label">Display</label>
          <label class="direct-cli-toggle">
            <input
              type="checkbox"
              v-model="directCli"
              :disabled="!supportsThemedMode"
              data-testid="display-mode-direct-cli"
            />
            Direct CLI
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <span class="hint">{{ $t('modals.submitHint', { action: $t('actions.submit').toLowerCase() }) }}</span>
        <div class="modal-actions">
          <button class="btn btn-cancel" @click="emit('cancel')">{{ $t('actions.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="!prompt.trim() || !hasValidBaseBranch"
            @click="handleSubmit"
          >
            {{ $t('actions.create') }}
          </button>
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

.modal {
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  width: 480px;
  max-width: 90vw;
  box-shadow: var(--kn-shadow-modal);
}

.modal-header {
  padding: 14px 16px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kn-text-primary);
}

.agent-provider {
  padding: 0;
  background: transparent;
  border: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--kn-text-secondary);
  cursor: pointer;
}

.agent-provider:hover {
  color: var(--kn-text-primary);
}

.direct-cli-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--kn-text-secondary);
  cursor: pointer;
}

.direct-cli-toggle:has(input:disabled) {
  cursor: default;
  opacity: 0.5;
}

.modal-body {
  padding: 12px 16px;
}

.prompt-input {
  width: 100%;
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-primary);
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 13px;
  padding: 10px;
  resize: vertical;
  outline: none;
  line-height: 1.5;
}

.prompt-input:focus {
  border-color: var(--kn-accent);
}

.prompt-input::placeholder {
  color: var(--kn-text-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.pipeline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.pipeline-label {
  font-size: 11px;
  color: var(--kn-text-muted);
  white-space: nowrap;
}

.pipeline-value-row {
  flex: 1;
}

.base-branch-dropdown-shell {
  position: relative;
  flex: 1;
  min-width: 0;
}

.base-branch-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.base-branch-value {
  color: var(--kn-text-primary);
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.base-branch-value.invalid {
  color: var(--kn-warning);
}

.change-link {
  padding: 0;
  background: transparent;
  border: none;
  color: var(--kn-accent);
  cursor: pointer;
  font-size: 11px;
}

.change-link:hover {
  color: var(--kn-accent-hover);
  text-decoration: underline;
}

.base-branch-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 4;
  overflow: hidden;
  background: var(--kn-bg-panel);
  border: 1px solid var(--kn-border-strong);
  border-radius: 8px;
  box-shadow: var(--kn-shadow-modal);
}

.text-input {
  width: 100%;
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-primary);
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
}

.text-input:focus {
  border-color: var(--kn-accent);
}

.base-branch-search {
  border: none;
  border-bottom: 1px solid var(--kn-border-default);
  border-radius: 0;
}

.base-branch-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.base-branch-options {
  overflow-y: auto;
}

.base-branch-option {
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--kn-text-secondary);
  cursor: pointer;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  text-align: left;
}

.base-branch-option:hover,
.base-branch-option.active {
  background: var(--kn-bg-panel-raised);
}

.base-branch-option.selected {
  color: var(--kn-text-primary);
  font-weight: 600;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 14px;
}

.hint {
  font-size: 11px;
  color: var(--kn-text-muted);
}

.modal-actions {
  display: flex;
  gap: 8px;
}

.btn {
  padding: 5px 14px;
  border-radius: 4px;
  border: 1px solid var(--kn-border-strong);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.btn-cancel {
  background: var(--kn-bg-panel-raised);
  color: var(--kn-text-secondary);
}

.btn-cancel:hover {
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

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
