<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { open } from "../dialog";
import { invoke } from "../invoke";
import { parseRepoInput } from "../utils/parseRepoInput";
import type { ParsedInput } from "../utils/parseRepoInput";

const props = defineProps<{
  initialTab: "create" | "import";
  cloning?: boolean;
}>();

const emit = defineEmits<{
  (e: "create", name: string, path: string): void;
  (e: "import", path: string, name: string, defaultBranch: string): void;
  (e: "clone", url: string, destination: string): void;
  (e: "cancel"): void;
}>();

const activeTab = ref<"create" | "import">(props.initialTab);

// ── Create New tab state ──
const createName = ref("");
const createParentDir = ref("");
const homeDir = ref("");

// ── Import / Clone tab state ──
const importInput = ref("");
const selectedLocalPath = ref<string | null>(null);
const localRepoName = ref("");
const localBranch = ref("main");
const localRemote = ref("");
const localIsGitRepo = ref(false);
const localLoading = ref(false);

// ── Shared state ──
const error = ref<string | null>(null);
const inputRef = ref<HTMLInputElement>();

onMounted(async () => {
  try {
    const { homeDir: tauri_homeDir } = await import("@tauri-apps/api/path");
    const raw = await tauri_homeDir();
    homeDir.value = raw.endsWith("/") ? raw : raw + "/";
  } catch {
    homeDir.value = "/Users/unknown/";
  }
  createParentDir.value = `${homeDir.value}.kanna/repos`;
  inputRef.value?.focus();
});

// ── Create New tab logic ──
const enumeratedCreateName = ref("");

watch([createName, createParentDir], async () => {
  const name = createName.value.trim();
  if (!name) { enumeratedCreateName.value = ""; return; }
  const enumerated = await findAvailableName(createParentDir.value, name);
  enumeratedCreateName.value = enumerated;
}, { immediate: true });

const displayCreatePath = computed(() => {
  const name = enumeratedCreateName.value || createName.value.trim();
  const parent = createParentDir.value;
  if (!name) {
    const display = parent;
    if (homeDir.value && display.startsWith(homeDir.value)) {
      return "~/" + display.slice(homeDir.value.length) + "/";
    }
    return display + "/";
  }
  const full = `${parent}/${name}`;
  if (homeDir.value && full.startsWith(homeDir.value)) {
    return "~/" + full.slice(homeDir.value.length);
  }
  return full;
});

const createDisabled = computed(() => !createName.value.trim());

// ── Import / Clone tab logic ──
const parsed = computed<ParsedInput>(() => parseRepoInput(importInput.value));

const enumeratedCloneName = ref("");

watch(() => parsed.value, async (p) => {
  error.value = null;
  if (p.type === "clone" && p.repo) {
    const enumerated = await findAvailableName(createParentDir.value, p.repo);
    enumeratedCloneName.value = enumerated;
  } else {
    enumeratedCloneName.value = "";
  }
}, { immediate: true });

const cloneDestination = computed(() => {
  const p = parsed.value;
  if (p.type !== "clone" || !p.repo) return "";
  const name = enumeratedCloneName.value || p.repo;
  return `${createParentDir.value}/${name}`;
});

const displayCloneDestination = computed(() => {
  const full = cloneDestination.value;
  if (!full) return "";
  if (homeDir.value && full.startsWith(homeDir.value)) {
    return "~/" + full.slice(homeDir.value.length);
  }
  return full;
});

const importDisabled = computed(() => {
  if (props.cloning) return true;
  if (selectedLocalPath.value) return false;
  return parsed.value.type === "unknown";
});

// ── Shared helpers ──
async function findAvailableName(parentDir: string, baseName: string): Promise<string> {
  try {
    const exists = await invoke<boolean>("file_exists", { path: `${parentDir}/${baseName}` });
    if (!exists) return baseName;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${baseName}-${i}`;
      const candidateExists = await invoke<boolean>("file_exists", { path: `${parentDir}/${candidate}` });
      if (!candidateExists) return candidate;
    }
    return `${baseName}-${Date.now()}`;
  } catch {
    return baseName;
  }
}

async function handleChangeCreateDir() {
  const result = await open({ directory: true, multiple: false, title: "Choose parent directory" });
  if (!result) return;
  const dir = Array.isArray(result) ? result[0] : result;
  if (dir) createParentDir.value = dir;
}

async function handleChangeCloneDir() {
  const result = await open({ directory: true, multiple: false, title: "Choose clone directory" });
  if (!result) return;
  const dir = Array.isArray(result) ? result[0] : result;
  if (dir) createParentDir.value = dir;
}

async function handleChooseLocalFolder() {
  error.value = null;
  const result = await open({ directory: true, multiple: false, title: "Select a Git Repository" });
  if (!result) return;
  const dirPath = Array.isArray(result) ? result[0] : result;
  if (!dirPath) return;

  selectedLocalPath.value = dirPath;
  importInput.value = dirPath;
  const parts = dirPath.split("/");
  localRepoName.value = parts[parts.length - 1] || "repo";

  localLoading.value = true;
  try {
    const branch = await invoke<string>("git_default_branch", { repoPath: dirPath });
    localBranch.value = branch || "main";
    localIsGitRepo.value = true;
    try {
      const remote = await invoke<string>("git_remote_url", { repoPath: dirPath });
      localRemote.value = remote;
    } catch {
      localRemote.value = "";
    }
  } catch {
    localIsGitRepo.value = false;
    localBranch.value = "main";
    localRemote.value = "";
  }
  localLoading.value = false;
}

function handleSubmit() {
  if (activeTab.value === "create") {
    if (createDisabled.value) return;
    const name = enumeratedCreateName.value || createName.value.trim();
    const path = `${createParentDir.value}/${name}`;
    emit("create", name, path);
  } else {
    if (importDisabled.value) return;
    if (selectedLocalPath.value) {
      emit("import", selectedLocalPath.value, localRepoName.value, localBranch.value);
    } else if (parsed.value.type === "clone" && parsed.value.cloneUrl) {
      emit("clone", parsed.value.cloneUrl, cloneDestination.value);
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    handleSubmit();
  }
  if (e.metaKey && e.shiftKey && (e.key === "[" || e.key === "{")) {
    e.preventDefault();
    switchTab("create");
  }
  if (e.metaKey && e.shiftKey && (e.key === "]" || e.key === "}")) {
    e.preventDefault();
    switchTab("import");
  }
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  }
}

function switchTab(tab: "create" | "import") {
  activeTab.value = tab;
  error.value = null;
  if (tab === "create") {
    selectedLocalPath.value = null;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')" @keydown="handleKeydown">
    <div class="modal">
      <div class="tabs">
        <button
          class="tab"
          :class="{ active: activeTab === 'create' }"
          @click="switchTab('create')"
        >
          Create New
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'import' }"
          @click="switchTab('import')"
        >
          Import / Clone
        </button>
      </div>

      <div v-if="activeTab === 'create'" class="modal-body">
        <input
          ref="inputRef"
          v-model="createName"
          class="text-input"
          type="text"
          placeholder="my-awesome-project"
        />
        <div class="path-hint">
          <span class="path-text">{{ displayCreatePath }}</span>
          <a v-if="createName.trim()" class="change-link" @click="handleChangeCreateDir">change</a>
        </div>
      </div>

      <div v-if="activeTab === 'import'" class="modal-body">
        <template v-if="!selectedLocalPath">
          <input
            ref="inputRef"
            v-model="importInput"
            class="text-input"
            type="text"
            placeholder="owner/repo, URL, or gh repo clone..."
            :disabled="cloning"
            @keydown="handleKeydown"
          />
          <template v-if="parsed.type === 'clone' && parsed.owner && parsed.repo">
            <div class="resolved-url">↳ github.com/{{ parsed.owner }}/{{ parsed.repo }}</div>
            <div class="path-hint">
              <span class="path-text">{{ displayCloneDestination }}</span>
              <a class="change-link" @click="handleChangeCloneDir">change</a>
            </div>
          </template>
          <template v-else>
            <div class="path-hint">
              or <a class="change-link" @click="handleChooseLocalFolder">choose a local folder</a>
            </div>
          </template>
        </template>

        <template v-else>
          <div class="selected-path">{{ selectedLocalPath }}</div>
          <div v-if="localLoading" class="path-hint">detecting...</div>
          <div v-else-if="localIsGitRepo" class="resolved-url">
            ✓ Git repo · branch: {{ localBranch }}<template v-if="localRemote"> · {{ localRemote }}</template>
          </div>
          <div v-else class="error-inline">
            Not a git repo. Use Create New tab to initialize one.
          </div>
          <div v-if="localIsGitRepo && !localLoading" class="name-field">
            <input
              v-model="localRepoName"
              class="text-input"
              type="text"
              placeholder="Repository name"
              @keydown="handleKeydown"
            />
          </div>
        </template>

        <div v-if="error" class="error-inline">{{ error }}</div>
      </div>

      <div class="modal-footer">
        <span class="hint">
          ⌘Enter to {{ activeTab === "create" ? "create" : "import" }}
        </span>
        <div class="modal-actions">
          <button class="btn btn-cancel" @click="emit('cancel')">Cancel</button>
          <button
            v-if="activeTab === 'create'"
            class="btn btn-primary"
            :disabled="createDisabled"
            @click="handleSubmit"
          >
            Create
          </button>
          <button
            v-else
            class="btn btn-primary"
            :disabled="importDisabled"
            @click="handleSubmit"
          >
            <template v-if="cloning">
              <span class="spinner" /> Cloning...
            </template>
            <template v-else>Import</template>
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
  z-index: 1000;
}

.modal {
  background: #252525;
  border: 1px solid #444;
  border-radius: 8px;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.tabs {
  display: flex;
  border-bottom: 1px solid #444;
}

.tab {
  flex: 1;
  padding: 12px 16px;
  font-size: 13px;
  color: #888;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  text-align: center;
}

.tab:hover {
  color: #ccc;
}

.tab.active {
  color: #fff;
  font-weight: 500;
  border-bottom-color: #0066cc;
  background: rgba(0, 102, 204, 0.08);
}

.modal-body {
  padding: 16px;
}

.text-input {
  width: 100%;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
  padding: 10px;
  outline: none;
}

.text-input:focus {
  border-color: #0066cc;
}

.text-input::placeholder {
  color: #555;
}

.text-input:disabled {
  opacity: 0.5;
}

.path-hint {
  font-size: 11px;
  color: #555;
  padding: 6px 2px 0;
}

.path-text {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
}

.change-link {
  color: #0066cc;
  cursor: pointer;
  margin-left: 4px;
}

.change-link:hover {
  color: #0077ee;
  text-decoration: underline;
}

.resolved-url {
  font-size: 11px;
  color: #0066cc;
  padding: 4px 2px 0;
}

.selected-path {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #ccc;
  background: #1a1a1a;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 10px;
}

.name-field {
  margin-top: 10px;
}

.error-inline {
  font-size: 11px;
  color: #f85149;
  padding: 6px 2px 0;
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

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  vertical-align: middle;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
