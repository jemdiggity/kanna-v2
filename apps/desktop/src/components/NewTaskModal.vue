<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useModalZIndex } from "../composables/useModalZIndex";
const { zIndex } = useModalZIndex();

const props = defineProps<{
  defaultAgentProvider?: "claude" | "copilot";
  pipelines?: string[];
  defaultPipeline?: string;
}>();

const emit = defineEmits<{
  submit: [prompt: string, agentProvider: "claude" | "copilot", pipelineName: string];
  cancel: [];
}>();

const prompt = ref("");
const agentProvider = ref<"claude" | "copilot">(props.defaultAgentProvider ?? "claude");
const selectedPipeline = ref<string>(props.defaultPipeline ?? props.pipelines?.[0] ?? "default");
const textareaRef = ref<HTMLTextAreaElement>();

const providers: Array<"claude" | "copilot"> = ["claude", "copilot"];

function cycleProvider(direction: -1 | 1) {
  const idx = providers.indexOf(agentProvider.value);
  agentProvider.value = providers[(idx + direction + providers.length) % providers.length];
}

onMounted(() => {
  textareaRef.value?.focus();
});

function handleSubmit() {
  const text = prompt.value.trim();
  if (!text) return;
  emit("submit", text, agentProvider.value, selectedPipeline.value);
  prompt.value = "";
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
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
    <div class="modal">
      <div class="modal-header">
        <h3>{{ $t('tasks.newTask') }}</h3>
        <div class="agent-toggle">
          <button
            :class="['toggle-btn', { active: agentProvider === 'claude' }]"
            @click="agentProvider = 'claude'"
          >Claude</button>
          <button
            :class="['toggle-btn', { active: agentProvider === 'copilot' }]"
            @click="agentProvider = 'copilot'"
          >Copilot</button>
        </div>
      </div>
      <div class="modal-body">
        <textarea
          ref="textareaRef"
          v-model="prompt"
          class="prompt-input"
          :placeholder="$t('tasks.descriptionPlaceholder')"
          rows="6"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          @keydown="handleKeydown"
        />
        <div class="pipeline-row">
          <label class="pipeline-label" for="pipeline-select">Pipeline</label>
          <select
            id="pipeline-select"
            v-model="selectedPipeline"
            class="pipeline-select"
          >
            <option
              v-if="!pipelines || pipelines.length === 0"
              value="default"
            >default</option>
            <option
              v-for="name in pipelines"
              :key="name"
              :value="name"
            >{{ name }}</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <span class="hint">{{ $t('modals.submitHint', { action: $t('actions.submit').toLowerCase() }) }}</span>
        <div class="modal-actions">
          <button class="btn btn-cancel" @click="emit('cancel')">{{ $t('actions.cancel') }}</button>
          <button
            class="btn btn-primary"
            :disabled="!prompt.trim()"
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
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
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
  color: #e0e0e0;
}

.agent-toggle {
  display: flex;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  overflow: hidden;
}

.toggle-btn {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #888;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.toggle-btn:hover {
  color: #ccc;
}

.toggle-btn.active {
  background: #333;
  color: #e0e0e0;
}

.modal-body {
  padding: 12px 16px;
}

.prompt-input {
  width: 100%;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 13px;
  padding: 10px;
  resize: vertical;
  outline: none;
  line-height: 1.5;
}

.prompt-input:focus {
  border-color: #0066cc;
}

.prompt-input::placeholder {
  color: #555;
}

.pipeline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.pipeline-label {
  font-size: 11px;
  color: #888;
  white-space: nowrap;
}

.pipeline-select {
  flex: 1;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
  cursor: pointer;
}

.pipeline-select:focus {
  border-color: #0066cc;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 14px;
}

.hint {
  font-size: 11px;
  color: #555;
}

.modal-actions {
  display: flex;
  gap: 8px;
}

.btn {
  padding: 5px 14px;
  border-radius: 4px;
  border: 1px solid #444;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.btn-cancel {
  background: #2a2a2a;
  color: #ccc;
}

.btn-cancel:hover {
  background: #333;
}

.btn-primary {
  background: #0066cc;
  border-color: #0077ee;
  color: #fff;
}

.btn-primary:hover {
  background: #0077ee;
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
