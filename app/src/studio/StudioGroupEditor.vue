<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import { keyLabel } from "../ui/keyLabel.ts";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The inspector's editor for several selected items: the actions that apply
 * to all of them as one step (Duplicate, Delete, Group). How they move
 * together is the inspector's foot line.
 */
const { edit } = defineProps<{ edit: StudioEditing }>();
const emit = defineEmits<{ combine: [] }>();
</script>

<template>
  <section class="group-editor" data-testid="group-editor" aria-label="Selected items">
    <div class="group-editor__actions">
      <UiButton size="sm" icon="copy" :shortcut="keyLabel('Mod+D')" @click="edit.duplicate()"
        >Duplicate</UiButton
      >
      <UiButton size="sm" variant="danger" icon="trash" shortcut="Del" @click="edit.remove()"
        >Delete</UiButton
      >
      <UiButton size="sm" icon="layers" :shortcut="keyLabel('Mod+G')" @click="emit('combine')"
        >Group</UiButton
      >
    </div>
  </section>
</template>

<style scoped>
.group-editor {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.group-editor__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
