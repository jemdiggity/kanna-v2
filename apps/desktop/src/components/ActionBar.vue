<script setup lang="ts">
import type { PipelineItem } from "@kanna/db";
import { hasTag } from "@kanna/core";
import { computed } from "vue";

const props = defineProps<{
  item: PipelineItem;
}>();

const emit = defineEmits<{
  (e: "make-pr"): void;
}>();

const showMakePR = computed(() => {
  return !hasTag(props.item, "done") && !hasTag(props.item, "pr") && !hasTag(props.item, "merge") && !hasTag(props.item, "blocked");
});
</script>

<template>
  <div class="action-bar">
    <button
      v-if="showMakePR"
      class="btn btn-primary"
      @click="emit('make-pr')"
    >
      Make PR
    </button>
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid #333;
  background: #1e1e1e;
}

.btn {
  padding: 5px 14px;
  border-radius: 4px;
  border: 1px solid #444;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  background: #2a2a2a;
  color: #ccc;
  transition: background 0.15s;
}

.btn:hover {
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

.btn-success {
  background: #2ea043;
  border-color: #3ab553;
  color: #fff;
}

.btn-success:hover {
  background: #3ab553;
}

.btn-danger {
  background: #333;
  border-color: #555;
  color: #ccc;
}

.btn-danger:hover {
  background: #b62324;
  border-color: #d13435;
  color: #fff;
}
</style>
