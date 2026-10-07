<script setup lang="ts">
import { watch, nextTick, useTemplateRef } from "vue";
import { documentLabel } from "../../../../src/logic/numberedLabels.ts";
const props = defineProps<{
  documentKey: string;
  source: string;
  readOnly?: boolean;
  location?: { start?: number; end?: number; serial: number } | undefined;
}>();
const emit = defineEmits<{ edit: [source: string]; typingEnd: [] }>();
const field = useTemplateRef("field");
watch(
  () => props.location,
  async (location) => {
    if (!location) return;
    await nextTick();
    field.value?.focus();
    field.value?.setSelectionRange(location.start ?? 0, location.end ?? 0);
  },
  { immediate: true },
);
</script>
<template>
  <textarea
    ref="field"
    class="workspace-document"
    :aria-label="documentLabel(documentKey)"
    :value="source"
    :readonly="readOnly"
    spellcheck="false"
    @input="!readOnly && emit('edit', ($event.target as HTMLTextAreaElement).value)"
    @blur="emit('typingEnd')"
  />
</template>
<style scoped>
.workspace-document {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: var(--space-5);
  border: 0;
  resize: none;
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-sm) / 1.6 var(--font-mono);
}
</style>
