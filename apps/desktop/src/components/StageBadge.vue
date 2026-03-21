<script setup lang="ts">
defineProps<{
  stage: string;
}>();

const stageColors: Record<string, string> = {
  in_progress: "#0066cc",
  pr: "#d29922",
  merge: "#8b5cf6",
  done: "#666",
  blocked: "#666",
};

const stageLabels: Record<string, string> = {
  in_progress: "In Progress",
  pr: "PR",
  merge: "Merge",
  done: "Done",
  blocked: "Blocked",
};
</script>

<template>
  <span
    class="stage-badge"
    :style="{ backgroundColor: stageColors[stage] || '#888' }"
  >
    {{ stageLabels[stage] || stage }}
  </span>
</template>

<style scoped>
.stage-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  white-space: nowrap;
  line-height: 1.4;
}
</style>
