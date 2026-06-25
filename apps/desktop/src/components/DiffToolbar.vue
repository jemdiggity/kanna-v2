<script setup lang="ts">
type DiffScope = "branch" | "working";

defineProps<{
  scope: DiffScope;
  workingFilterLabel: string;
  branchIncludeLabel: string;
}>();

defineEmits<{
  (e: "set-scope", scope: DiffScope): void;
  (e: "cycle-working-filter"): void;
  (e: "cycle-branch-include"): void;
}>();
</script>

<template>
  <div class="diff-toolbar">
    <div class="scope-selector">
      <button :class="{ active: scope === 'working' }" @click="$emit('set-scope', 'working')">{{ $t('diffView.scopeWorking') }}</button>
      <button :class="{ active: scope === 'branch' }" @click="$emit('set-scope', 'branch')">{{ $t('diffView.scopeBranch') }}</button>
    </div>
    <button
      v-if="scope === 'working'"
      class="staged-toggle"
      @click="$emit('cycle-working-filter')"
    >{{ workingFilterLabel }}</button>
    <button
      v-if="scope === 'branch'"
      class="branch-include-toggle staged-toggle"
      @click="$emit('cycle-branch-include')"
    >{{ branchIncludeLabel }}</button>
  </div>
</template>

<style scoped>
.diff-toolbar {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--kn-border-default);
  background: var(--kn-bg-sidebar);
  flex-shrink: 0;
}

.scope-selector {
  display: flex;
  gap: 0;
}

.scope-selector button {
  padding: 3px 12px;
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  color: var(--kn-text-muted);
  font-size: 11px;
  cursor: pointer;
}

.scope-selector button:first-child { border-radius: 4px 0 0 4px; }
.scope-selector button:last-child { border-radius: 0 4px 4px 0; }
.scope-selector button:not(:first-child) { border-left: none; }

.scope-selector button.active {
  background: var(--kn-accent);
  border-color: var(--kn-accent-hover);
  color: var(--kn-text-inverse);
}

.staged-toggle {
  margin-left: 12px;
  padding: 3px 10px;
  background: var(--kn-bg-panel-raised);
  border: 1px solid var(--kn-border-strong);
  color: var(--kn-text-muted);
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
}
</style>
