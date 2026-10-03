<script setup lang="ts">
defineProps<{ source: string; readOnly?: boolean }>();
const emit = defineEmits<{ edit: [text: string] }>();
</script>
<template>
  <textarea
    class="workspace-notes"
    aria-label="Game notes"
    :value="source"
    :readonly="readOnly"
    placeholder="Style, tone and rules for this game…"
    @input="emit('edit', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>
<style scoped>
.workspace-notes {
  flex: 1;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  resize: none;
  border: 0;
  background: var(--surface-0);
  color: var(--ink);
  padding: var(--space-5);
  font: var(--text-sm) / 1.6 var(--font-sans);
}
</style>
