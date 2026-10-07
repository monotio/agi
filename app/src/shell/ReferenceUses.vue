<script setup lang="ts">
import type { BindingInfo } from "../../../src/logic/projectNames.ts";
import { documentLabel } from "../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "./useProjectLabels.ts";
import { useWorkspaceEditor } from "./workspaceEditor.ts";
const { uses } = defineProps<{ uses: BindingInfo["uses"] }>();
const emit = defineEmits<{ opened: [] }>();
const labels = useProjectLabels();
const workspace = useWorkspaceEditor();
function openUse(use: BindingInfo["uses"][number]): void {
  workspace.revealUse(use);
  emit("opened");
}
</script>
<template>
  <ul class="reference-uses" v-if="uses.length">
    <li
      v-for="use in uses"
      :key="`${use.key}:${use.range.start.line}:${use.range.start.character}`"
    >
      <button type="button" @click="openUse(use)">
        {{ use.role }} · {{ documentLabel(use.key, labels) }} · line {{ use.range.start.line + 1 }}
        <small v-if="use.text">{{ use.text }}</small>
      </button>
    </li>
  </ul>
  <p v-else class="reference-empty">Not used yet.</p>
</template>
<style scoped>
.reference-uses {
  padding: 0;
  margin: var(--space-2) 0;
  list-style: none;
}
.reference-uses button {
  display: grid;
  width: 100%;
  gap: var(--space-1);
  padding: var(--space-2);
  text-align: left;
  font: var(--text-xs) var(--font-sans);
  color: var(--action);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.reference-uses button:hover {
  background: var(--surface-1);
}
.reference-uses small {
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.reference-empty {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
