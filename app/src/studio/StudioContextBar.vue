<script setup lang="ts">
import { useId } from "vue";
import UiButton from "../ui/UiButton.vue";
import StudioValuePicker from "./StudioValuePicker.vue";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The contextual toolbar beside the selection: Duplicate, the priority value
 * (a picker that opens below it), Delete, and Ask — which is a stub until AI
 * edits arrive. Placed by its parent in the pane's CSS pixels.
 */
const { priority, priorityLocked, depthValuesLocked, edit } = defineProps<{
  /** The one priority the item draws; null for none, undefined for several. */
  priority: number | null | undefined;
  /** Why priority is locked now, or null. */
  priorityLocked: string | null;
  depthValuesLocked: boolean;
  edit: StudioEditing;
}>();
const open = defineModel<boolean>("open", { required: true });
const pickerId = useId();

function pick(value: number | null): void {
  if (edit.setColour("priority", value)) open.value = false;
}
</script>

<template>
  <div
    class="ctx-bar"
    role="toolbar"
    aria-label="Selection"
    data-testid="studio-context-bar"
    @pointerdown.stop
  >
    <UiButton variant="ghost" size="sm" icon="copy" @click="edit.duplicate()">Duplicate</UiButton>
    <UiButton
      variant="ghost"
      size="sm"
      trailing-icon="chevron-down"
      :aria-expanded="open"
      :aria-controls="pickerId"
      :title="priorityLocked ?? 'Set the priority this item draws'"
      data-testid="ctx-priority"
      @click="open = !open"
    >
      Priority {{ priority === undefined ? "mixed" : priority === null ? "off" : priority }}
    </UiButton>
    <UiButton variant="ghost" size="sm" icon="trash" @click="edit.remove()">Delete</UiButton>
    <span class="ctx-bar__ask" title="AI edits arrive in a later update">
      <UiButton variant="ghost" size="sm" icon="sparkles" disabled> Ask </UiButton>
    </span>
    <div v-if="open" :id="pickerId" class="ctx-bar__picker" @keydown.esc.stop="open = false">
      <StudioValuePicker
        plane="priority"
        label="Priority value"
        :value="priority"
        :disabled="priorityLocked !== null"
        :allowed="(v) => !depthValuesLocked || v < 4"
        @pick="pick"
      />
      <p v-if="priorityLocked" class="ctx-bar__note">{{ priorityLocked }}</p>
    </div>
  </div>
</template>

<style scoped>
.ctx-bar {
  position: absolute;
  z-index: var(--z-popover);
  display: flex;
  align-items: center;
  gap: var(--space-0);
  padding: var(--space-0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  white-space: nowrap;
  cursor: default;
}
.ctx-bar__ask {
  display: inline-flex;
}
.ctx-bar__picker {
  position: absolute;
  top: calc(100% + var(--space-2));
  left: 0;
  width: 280px;
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
  white-space: normal;
}
.ctx-bar__note {
  margin: var(--space-2) 0 0;
  color: var(--warn);
  font-size: var(--text-2xs);
}
</style>
