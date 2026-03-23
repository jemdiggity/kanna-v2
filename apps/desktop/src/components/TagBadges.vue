<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { parseTags } from "@kanna/core";

const { t } = useI18n();

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

const tagLabelKeys: Record<string, string> = {
  "in progress": "tags.inProgress",
  pr: "tags.pr",
  merge: "tags.merge",
  done: "tags.done",
  blocked: "tags.blocked",
};

function tagLabel(tag: string): string {
  const key = tagLabelKeys[tag];
  return key ? t(key) : tag;
}
</script>

<template>
  <span
    v-for="tag in tagList"
    :key="tag"
    class="tag-badge"
    :style="{ backgroundColor: tagColors[tag] || '#555' }"
  >
    {{ tagLabel(tag) }}
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
