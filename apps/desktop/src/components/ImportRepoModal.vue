<script setup lang="ts">
import { ref } from "vue";
import { open } from "../dialog";
import { invoke } from "../invoke";

const emit = defineEmits<{
  (e: "import", path: string, name: string, defaultBranch: string): void;
  (e: "cancel"): void;
}>();

const selectedPath = ref<string | null>(null);
const detectedBranch = ref<string>("main");
const repoName = ref("");
const loading = ref(false);
const error = ref<string | null>(null);

async function chooseDirectory() {
  error.value = null;
  const result = await open({
    directory: true,
    multiple: false,
    title: "Select a Git Repository",
  });

  if (!result) return;

  const dirPath = typeof result === "string" ? result : result;
  selectedPath.value = dirPath;

  // Extract repo name from path
  const parts = dirPath.split("/");
  repoName.value = parts[parts.length - 1] || "repo";

  // Try to detect default branch
  loading.value = true;
  try {
    const branch = await invoke<string>("git_default_branch", { path: dirPath });
    detectedBranch.value = branch || "main";
  } catch {
    detectedBranch.value = "main";
  }
  loading.value = false;
}

function handleSubmit() {
  if (!selectedPath.value || !repoName.value.trim()) return;
  emit("import", selectedPath.value, repoName.value.trim(), detectedBranch.value);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')" @keydown="handleKeydown">
    <div class="modal">
      <div class="modal-header">
        <h3>Import Repository</h3>
      </div>
      <div class="modal-body">
        <button class="btn-choose" @click="chooseDirectory">
          Choose Directory
        </button>

        <div v-if="selectedPath" class="selected-info">
          <div class="info-row">
            <span class="info-label">Path:</span>
            <span class="info-value path">{{ selectedPath }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Name:</span>
            <input
              v-model="repoName"
              class="name-input"
              type="text"
            />
          </div>
          <div class="info-row">
            <span class="info-label">Branch:</span>
            <span v-if="loading" class="info-value">detecting...</span>
            <span v-else class="info-value branch">{{ detectedBranch }}</span>
          </div>
        </div>

        <div v-if="error" class="error">{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-cancel" @click="emit('cancel')">Cancel</button>
        <button
          class="btn btn-primary"
          :disabled="!selectedPath || !repoName.trim() || loading"
          @click="handleSubmit"
        >
          Import
        </button>
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
  z-index: 1000;
}

.modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 500px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.modal-header {
  padding: 14px 16px 0;
}

.modal-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.modal-body {
  padding: 14px 16px;
}

.btn-choose {
  width: 100%;
  padding: 10px;
  background: #2a2a2a;
  border: 1px dashed #555;
  border-radius: 4px;
  color: #aaa;
  font-size: 13px;
  cursor: pointer;
}

.btn-choose:hover {
  background: #333;
  border-color: #777;
  color: #e0e0e0;
}

.selected-info {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.info-label {
  color: #888;
  min-width: 50px;
}

.info-value {
  color: #ccc;
}

.path {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch {
  font-family: "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: #2a2a2a;
  padding: 1px 6px;
  border-radius: 3px;
}

.name-input {
  flex: 1;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 3px;
  color: #e0e0e0;
  font-size: 12px;
  padding: 3px 8px;
  outline: none;
}

.name-input:focus {
  border-color: #0066cc;
}

.error {
  margin-top: 10px;
  color: #f85149;
  font-size: 12px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 16px 14px;
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
