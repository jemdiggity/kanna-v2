<script setup lang="ts">
import { computed } from "vue";
import { parseTags } from "@kanna/core";

const props = defineProps<{
  tags: string;
}>();

const tagList = computed(() => parseTags(props.tags));

const tagColors: Record<string, string> = {
  "in progress": "#3b82f6",
  pr: "#d29922",
  merge: "#8b5cf6",
  done: "#666",
  blocked: "#666",
};

const tagLabels: Record<string, string> = {
  "in progress": "In Progress",
  pr: "PR",
  merge: "Merge",
  done: "Done",
  blocked: "Blocked",
};
</script>

<template>
  <span
    v-for="tag in tagList"
    :key="tag"
    class="tag-badge"
    :style="{ backgroundColor: tagColors[tag] || '#555' }"
  >
    {{ tagLabels[tag] || tag }}
  </span>
</template>

<style scoped>
.tag-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  line-height: 1.4;
  margin-right: 4px;
}
</style>
