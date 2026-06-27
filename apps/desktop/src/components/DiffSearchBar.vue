<script setup lang="ts">
import { ref } from "vue";
import { macOsTextInputAttrs } from "../utils/textInput";

defineProps<{
  modelValue: string;
  searchCountLabel: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "keydown", event: KeyboardEvent): void;
}>();

const searchInputRef = ref<HTMLInputElement | null>(null);

function focus() {
  searchInputRef.value?.focus();
}

function handleInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}

defineExpose({ focus });
</script>

<template>
  <div class="search-bar">
    <span class="search-prefix">/</span>
    <input
      ref="searchInputRef"
      :value="modelValue"
      v-bind="macOsTextInputAttrs"
      class="search-input"
      :placeholder="$t('diffView.searchPlaceholder')"
      @input="handleInput"
      @keydown="$emit('keydown', $event)"
    />
    <span v-if="modelValue" class="search-count">{{ searchCountLabel }}</span>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--kn-border-default);
  background: var(--kn-bg-app);
  flex-shrink: 0;
}

.search-prefix {
  font-family: "SF Mono", Menlo, monospace;
  color: var(--kn-text-muted);
  font-size: 13px;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--kn-text-primary);
  font-size: 13px;
}

.search-input::placeholder {
  color: var(--kn-text-muted);
}

.search-count {
  font-size: 12px;
  color: var(--kn-text-muted);
  white-space: nowrap;
}
</style>
