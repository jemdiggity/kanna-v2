<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { open } from "../dialog";
import { invoke } from "../invoke";
import { parseRepoInput } from "../utils/parseRepoInput";
import type { ParsedInput } from "../utils/parseRepoInput";
import { defaultReposHome } from "../utils/reposHome";
import { useModalZIndex } from "../composables/useModalZIndex";
import { macOsTextInputAttrs } from "../utils/textInput";

interface GitRepositoryState {
  defaultBranch: string;
  defaultBranchSource: string;
  hasCommits: boolean;
}

const { t } = useI18n();
const { zIndex } = useModalZIndex();

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
watch(() => props.initialTab, (tab) => {
  activeTab.value = tab;
  focusActiveInput();
});

// ── Create New tab state ──
const createName = ref("");
const createParentDir = ref("");
const homeDir = ref("");

// ── Import / Clone tab state ──
const importInput = ref("");
const selectedLocalPath = ref<string | null>(null);
const localDerivedRepoName = ref("");
const localRepoName = ref("");
const localRepoNameDraft = ref("");
const localRepoNamePath = ref<string | null>(null);
const localBranch = ref("main");
const localRemote = ref("");
const localPathExists = ref(false);
const localIsGitRepo = ref(false);
const localLoading = ref(false);
const localInspectVersion = ref(0);
const isEditingLocalRepoName = ref(false);

// ── Shared state ──
const error = ref<string | null>(null);
const createInputRef = ref<HTMLInputElement>();
const importInputRef = ref<HTMLInputElement>();
const localRepoNameInputRef = ref<HTMLInputElement>();

function focusActiveInput() {
  void nextTick(() => {
    if (activeTab.value === "create") {
      createInputRef.value?.focus();
      return;
    }

    if (shouldFocusLocalRepoName.value) {
      localRepoNameInputRef.value?.focus();
      return;
    }

    importInputRef.value?.focus();
  });
}

onMounted(async () => {
  try {
    const { homeDir: tauri_homeDir } = await import("@tauri-apps/api/path");
    const raw = await tauri_homeDir();
    homeDir.value = raw.endsWith("/") ? raw : raw + "/";
  } catch (error) {
    console.debug("[add-repo] failed to resolve home directory; using fallback:", error);
    homeDir.value = "/Users/unknown/";
  }
  createParentDir.value = defaultReposHome(homeDir.value);
  focusActiveInput();
  window.addEventListener("keydown", handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
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

const createNameError = computed(() => {
  const name = createName.value.trim();
  if (!name) return null;
  return /\s/.test(name) ? t("addRepo.nameNoSpaces") : null;
});

const createDisabled = computed(() => !createName.value.trim() || !!createNameError.value);

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

const manualLocalPath = computed(() => {
  const localPath = parsed.value.type === "local" ? parsed.value.localPath : null;
  if (!localPath) return null;
  return canonicalizeLocalPath(normalizeLocalPath(localPath));
});

const activeLocalPath = computed(() => selectedLocalPath.value ?? manualLocalPath.value);
const shouldFocusLocalRepoName = computed(() =>
  activeTab.value === "import" &&
  !!activeLocalPath.value &&
  localIsGitRepo.value &&
  isEditingLocalRepoName.value &&
  !localLoading.value,
);
const resolvedLocalRepoName = computed(() => localRepoName.value.trim() || localDerivedRepoName.value);

const importDisabled = computed(() => {
  if (props.cloning) return true;
  if (activeLocalPath.value) {
    return localLoading.value || !localPathExists.value || !localIsGitRepo.value || !resolvedLocalRepoName.value;
  }
  return parsed.value.type !== "clone";
});

watch(manualLocalPath, async (path) => {
  if (selectedLocalPath.value) return;
  if (!path) {
    resetLocalRepoState();
    return;
  }
  await inspectLocalPath(path);
}, { immediate: true });

watch(shouldFocusLocalRepoName, (shouldFocus) => {
  if (shouldFocus) {
    focusActiveInput();
  }
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
  } catch (error) {
    console.debug("[add-repo] failed to enumerate available repo name; using base name:", error);
    return baseName;
  }
}

function normalizeLocalPath(path: string): string {
  if (path === "~") return homeDir.value.slice(0, -1) || path;
  if (path.startsWith("~/") && homeDir.value) return `${homeDir.value}${path.slice(2)}`;
  return path;
}

function canonicalizeLocalPath(path: string): string {
  if (path === "/") return path;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}

function resetLocalRepoState() {
  localDerivedRepoName.value = "";
  localRepoName.value = "";
  localRepoNameDraft.value = "";
  localRepoNamePath.value = null;
  localBranch.value = "main";
  localRemote.value = "";
  localPathExists.value = false;
  localIsGitRepo.value = false;
  localLoading.value = false;
  isEditingLocalRepoName.value = false;
}

function deriveRepoName(path: string): string {
  const trimmedPath = path.replace(/\/+$/, "");
  const parts = trimmedPath.split("/");
  return parts[parts.length - 1] || "repo";
}

async function inspectLocalPath(dirPath: string) {
  const canonicalDirPath = canonicalizeLocalPath(dirPath);
  const inspectionId = ++localInspectVersion.value;
  localLoading.value = true;
  const derivedRepoName = deriveRepoName(canonicalDirPath);
  localDerivedRepoName.value = derivedRepoName;
  const isNewPath = localRepoNamePath.value !== canonicalDirPath;
  if (isNewPath) {
    localRepoName.value = derivedRepoName;
    localRepoNameDraft.value = "";
    localRepoNamePath.value = canonicalDirPath;
    isEditingLocalRepoName.value = false;
  }
  localPathExists.value = false;

  try {
    const exists = await invoke<boolean>("file_exists", { path: canonicalDirPath });
    if (inspectionId !== localInspectVersion.value) return;

    localPathExists.value = exists;
    if (!exists) {
      localIsGitRepo.value = false;
      localBranch.value = "main";
      localRemote.value = "";
      return;
    }

    try {
      const state = await invoke<GitRepositoryState>("git_repository_state", {
        repoPath: canonicalDirPath,
      });
      if (inspectionId !== localInspectVersion.value) return;
      localBranch.value = state.defaultBranch || "main";
      localIsGitRepo.value = true;
      try {
        const remote = await invoke<string>("git_remote_url", { repoPath: canonicalDirPath });
        if (inspectionId !== localInspectVersion.value) return;
        localRemote.value = remote;
      } catch (error) {
        console.debug("[add-repo] failed to inspect repo remote; treating as no remote:", error);
        if (inspectionId !== localInspectVersion.value) return;
        localRemote.value = "";
      }
    } catch (error) {
      console.debug("[add-repo] failed to inspect default branch; treating path as non-git repo:", error);
      if (inspectionId !== localInspectVersion.value) return;
      localIsGitRepo.value = false;
      localBranch.value = "main";
      localRemote.value = "";
    }
  } finally {
    if (inspectionId === localInspectVersion.value) {
      localLoading.value = false;
    }
  }
}

async function startLocalRepoRename() {
  if (!activeLocalPath.value || !localIsGitRepo.value || localLoading.value) return;
  localRepoNameDraft.value = localRepoName.value;
  isEditingLocalRepoName.value = true;
  await nextTick();
  localRepoNameInputRef.value?.focus();
  localRepoNameInputRef.value?.select();
}

function commitLocalRepoRename() {
  localRepoName.value = localRepoNameDraft.value.trim() || localDerivedRepoName.value;
  localRepoNameDraft.value = "";
  isEditingLocalRepoName.value = false;
}

function cancelLocalRepoRename() {
  isEditingLocalRepoName.value = false;
  localRepoNameDraft.value = "";
}

function isMetaEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && event.metaKey && !event.ctrlKey && !event.altKey;
}

function submitFromInput(event: KeyboardEvent) {
  if (!isMetaEnter(event)) return;
  event.preventDefault();
  event.stopPropagation();
  handleSubmit();
}

function commitLocalRepoRenameAndSubmit(event: KeyboardEvent) {
  if (!isMetaEnter(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  commitLocalRepoRename();
  handleSubmit();
}

async function handleChangeCreateDir() {
  const result = await open({ directory: true, multiple: false, title: t('modals.chooseDirectory') });
  if (!result) return;
  const dir = Array.isArray(result) ? result[0] : result;
  if (dir) createParentDir.value = dir;
}

async function handleChangeCloneDir() {
  const result = await open({ directory: true, multiple: false, title: t('modals.chooseCloneDirectory') });
  if (!result) return;
  const dir = Array.isArray(result) ? result[0] : result;
  if (dir) createParentDir.value = dir;
}

async function handleChooseLocalFolder() {
  error.value = null;
  const result = await open({ directory: true, multiple: false, title: t('modals.selectRepo') });
  if (!result) return;
  const dirPath = Array.isArray(result) ? result[0] : result;
  if (!dirPath) return;

  const canonicalDirPath = canonicalizeLocalPath(dirPath);
  selectedLocalPath.value = canonicalDirPath;
  importInput.value = canonicalDirPath;
  await inspectLocalPath(canonicalDirPath);
}

function handleSubmit() {
  if (activeTab.value === "create") {
    if (createDisabled.value) return;
    const name = enumeratedCreateName.value || createName.value.trim();
    const path = `${createParentDir.value}/${name}`;
    emit("create", name, path);
  } else {
    if (importDisabled.value) return;
    if (activeLocalPath.value && localIsGitRepo.value) {
      emit("import", activeLocalPath.value, resolvedLocalRepoName.value, localBranch.value);
    } else if (parsed.value.type === "clone" && parsed.value.cloneUrl) {
      emit("clone", parsed.value.cloneUrl, cloneDestination.value);
    }
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
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
  focusActiveInput();
}
</script>

<template>
  <div class="modal-overlay" :style="{ zIndex }" @click.self="emit('cancel')">
    <div class="modal">
      <div class="tabs">
        <button
          type="button"
          class="tab"
          :class="{ active: activeTab === 'create' }"
          @mousedown.prevent
          @click="switchTab('create')"
        >
          {{ $t('addRepo.tabCreate') }}
        </button>
        <button
          type="button"
          class="tab"
          :class="{ active: activeTab === 'import' }"
          @mousedown.prevent
          @click="switchTab('import')"
        >
          {{ $t('addRepo.tabImport') }}
        </button>
      </div>

      <div v-if="activeTab === 'create'" class="modal-body">
        <input
          ref="createInputRef"
          v-model="createName"
          v-bind="macOsTextInputAttrs"
          class="text-input"
          type="text"
          :placeholder="$t('addRepo.namePlaceholder')"
          @keydown="submitFromInput"
        />
        <div v-if="createNameError" class="error-inline">{{ createNameError }}</div>
        <div class="path-hint">
          <span class="path-text">{{ displayCreatePath }}</span>
          <a v-if="createName.trim()" class="change-link" @click="handleChangeCreateDir">{{ $t('addRepo.change') }}</a>
        </div>
      </div>

      <div v-if="activeTab === 'import'" class="modal-body">
        <template v-if="!selectedLocalPath">
          <input
            ref="importInputRef"
            v-model="importInput"
            v-bind="macOsTextInputAttrs"
            class="text-input"
            type="text"
            :placeholder="$t('addRepo.importPlaceholder')"
            :disabled="cloning"
            @keydown="submitFromInput"
          />
          <template v-if="parsed.type === 'clone' && parsed.owner && parsed.repo">
            <div class="resolved-url">↳ github.com/{{ parsed.owner }}/{{ parsed.repo }}</div>
            <div class="path-hint">
              <span class="path-text">{{ displayCloneDestination }}</span>
              <a class="change-link" @click="handleChangeCloneDir">{{ $t('addRepo.change') }}</a>
            </div>
          </template>
          <template v-else-if="manualLocalPath">
            <div class="selected-path-row">
              <div class="selected-path">{{ manualLocalPath }}</div>
            </div>
            <div v-if="localLoading" class="path-hint">{{ $t('addRepo.detecting') }}</div>
            <div v-else-if="localIsGitRepo" class="resolved-url">
              {{ $t('addRepo.gitRepoConfirmed') }} {{ localBranch }}<template v-if="localRemote"> · {{ localRemote }}</template>
            </div>
            <div v-else-if="localPathExists" class="error-inline">
              {{ $t('addRepo.notAGitRepo') }}
            </div>
            <div v-if="localIsGitRepo && !localLoading">
              <div v-if="isEditingLocalRepoName">
                <input
                  ref="localRepoNameInputRef"
                  v-model="localRepoNameDraft"
                  v-bind="macOsTextInputAttrs"
                  class="text-input"
                  type="text"
                  :placeholder="$t('addRepo.repoNamePlaceholder')"
                  @keydown="commitLocalRepoRenameAndSubmit"
                  @blur="commitLocalRepoRename"
                  @keydown.enter.stop.prevent="commitLocalRepoRename"
                  @keydown.escape.stop.prevent="cancelLocalRepoRename"
                />
              </div>
              <div v-else class="repo-name-row">
                <span class="repo-name-label">{{ $t('addRepo.repoNameLabel') }}</span>
                <span class="repo-name-value">{{ resolvedLocalRepoName }}</span>
                <a class="repo-name-change change-link" @click="startLocalRepoRename">{{ $t('addRepo.change') }}</a>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="path-hint">
              {{ $t('addRepo.or') }} <a class="change-link" @click="handleChooseLocalFolder">{{ $t('addRepo.chooseLocalFolder') }}</a>
            </div>
          </template>
        </template>

        <template v-else>
          <div class="selected-path-row">
            <div class="selected-path">{{ selectedLocalPath }}</div>
            <a class="change-link" @click="selectedLocalPath = null">{{ $t('addRepo.change') }}</a>
          </div>
          <div v-if="localLoading" class="path-hint">{{ $t('addRepo.detecting') }}</div>
          <div v-else-if="localIsGitRepo" class="resolved-url">
            {{ $t('addRepo.gitRepoConfirmed') }} {{ localBranch }}<template v-if="localRemote"> · {{ localRemote }}</template>
          </div>
          <div v-else class="error-inline">
            {{ $t('addRepo.notAGitRepo') }}
          </div>
          <div v-if="localIsGitRepo && !localLoading">
            <div v-if="isEditingLocalRepoName">
              <input
                ref="localRepoNameInputRef"
                v-model="localRepoNameDraft"
                v-bind="macOsTextInputAttrs"
                class="text-input"
                type="text"
                :placeholder="$t('addRepo.repoNamePlaceholder')"
                @keydown="commitLocalRepoRenameAndSubmit"
                @blur="commitLocalRepoRename"
                @keydown.enter.stop.prevent="commitLocalRepoRename"
                @keydown.escape.stop.prevent="cancelLocalRepoRename"
              />
            </div>
            <div v-else class="repo-name-row">
              <span class="repo-name-label">{{ $t('addRepo.repoNameLabel') }}</span>
              <span class="repo-name-value">{{ resolvedLocalRepoName }}</span>
              <a class="repo-name-change change-link" @click="startLocalRepoRename">{{ $t('addRepo.change') }}</a>
            </div>
          </div>
        </template>

        <div v-if="error" class="error-inline">{{ error }}</div>
      </div>

      <div class="modal-footer">
        <span class="hint">
          {{ $t('modals.submitHint', { action: activeTab === 'create' ? $t('actions.create').toLowerCase() : $t('actions.import').toLowerCase() }) }}
        </span>
        <div class="modal-actions">
          <button class="btn btn-cancel" @click="emit('cancel')">{{ $t('actions.cancel') }}</button>
          <button
            v-if="activeTab === 'create'"
            class="btn btn-primary"
            :disabled="createDisabled"
            @click="handleSubmit"
          >
            {{ $t('actions.create') }}
          </button>
          <button
            v-else
            class="btn btn-primary"
            :disabled="importDisabled"
            @click="handleSubmit"
          >
            <template v-if="cloning">
              <span class="spinner" /> {{ $t('addRepo.cloning') }}
            </template>
            <template v-else>{{ $t('actions.import') }}</template>
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

.tabs {
  display: flex;
  border-bottom: 1px solid var(--kn-border-strong);
}

.tab {
  flex: 1;
  padding: 12px 16px;
  font-size: 13px;
  color: var(--kn-text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  text-align: center;
}

.tab:hover {
  color: var(--kn-text-secondary);
}

.tab.active {
  color: var(--kn-accent);
  font-weight: 500;
  border-bottom-color: var(--kn-accent);
  background: var(--kn-bg-accent-subtle);
}

.modal-body {
  padding: 16px;
}

.text-input {
  width: 100%;
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  color: var(--kn-text-primary);
  font-size: 13px;
  padding: 10px;
  outline: none;
}

.text-input:focus {
  border-color: var(--kn-accent);
}

.text-input::placeholder {
  color: var(--kn-text-muted);
}

.text-input:disabled {
  opacity: 0.5;
}

.path-hint {
  font-size: 11px;
  color: var(--kn-text-muted);
  padding: 6px 2px 0;
}

.path-text {
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 11px;
}

.change-link {
  color: var(--kn-accent);
  cursor: pointer;
  margin-left: 4px;
}

.change-link:hover {
  color: var(--kn-accent-hover);
  text-decoration: underline;
}

.resolved-url {
  font-size: 11px;
  color: var(--kn-accent);
  padding: 4px 2px 0;
}

.repo-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px 0;
  font-size: 11px;
}

.repo-name-label {
  color: var(--kn-text-muted);
}

.repo-name-value {
  color: var(--kn-text-secondary);
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
}

.selected-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.selected-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: "JetBrains Mono", "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--kn-text-secondary);
  background: var(--kn-bg-input);
  border: 1px solid var(--kn-border-strong);
  border-radius: 4px;
  padding: 10px;
}

.error-inline {
  font-size: 11px;
  color: var(--kn-danger);
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

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--kn-border-strong);
  border-top-color: var(--kn-text-inverse);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  vertical-align: middle;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
