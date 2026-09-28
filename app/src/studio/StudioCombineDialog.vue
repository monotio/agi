<script setup lang="ts">
import { ref, useId, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

/**
 * Group: the selected items become one item with the name typed here
 * (Group by default); Ungroup (Shift+Cmd/Ctrl+G) gives them back. Only neighbours in the draw order can: the
 * picture draws its commands in order, so the items drawn between them would
 * have to move and change the picture. For a gap of items the dialog offers
 * to include them; loose drawing between them rules it out. The picture's
 * bytes never change, only its notes.
 */
const {
  count,
  between,
  loose = false,
} = defineProps<{
  /** How many items are selected. */
  count: number;
  /** Labels of the items drawn between the selected ones, in draw order. */
  between: readonly string[];
  /** Drawing that belongs to no item sits between them. */
  loose?: boolean;
}>();
const emit = defineEmits<{ make: [name: string]; include: [] }>();
const open = defineModel<boolean>("open", { required: true });
const name = ref("Group");
const fieldId = useId();
watch(open, (now) => {
  if (now) name.value = "Group";
});

function quoteList(labels: readonly string[]): string {
  const quoted = labels.slice(0, 3).map((label) => `“${label}”`);
  const more = labels.length - quoted.length;
  return more > 0 ? `${quoted.join(", ")} and ${more} more` : quoted.join(" and ");
}
function make(): void {
  if (between.length > 0 || loose) return;
  emit("make", name.value.trim() || "Group");
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    size="sm"
    title="Group"
    :description="`The ${count} selected items become one group in the Scene list. The picture stays exactly as it is.`"
    close-testid="combine-close"
  >
    <form class="combine" data-testid="combine-dialog" @submit.prevent="make">
      <label class="combine__label" :for="fieldId">Name</label>
      <input
        :id="fieldId"
        v-model="name"
        class="combine__input"
        maxlength="60"
        autocomplete="off"
        autofocus
        data-testid="combine-name"
      />
      <p
        v-if="between.length > 0"
        id="combine-gap"
        class="combine__gap"
        role="alert"
        data-testid="combine-gap"
      >
        {{ quoteList(between) }} {{ between.length === 1 ? "is" : "are" }} drawn between them. Only
        neighbours in the draw order can be grouped.
      </p>
      <p
        v-else-if="loose"
        id="combine-gap"
        class="combine__gap"
        role="alert"
        data-testid="combine-gap"
      >
        Drawing that belongs to no item sits between them, so they can't be grouped.
      </p>
    </form>
    <template #footer>
      <UiButton variant="ghost" data-testid="combine-cancel" @click="open = false">Cancel</UiButton>
      <UiButton
        v-if="between.length > 0 && !loose"
        data-testid="combine-include"
        @click="emit('include')"
      >
        Include {{ between.length === 1 ? "the item" : `the ${between.length} items` }} between
      </UiButton>
      <UiButton
        variant="primary"
        :disabled="between.length > 0 || loose"
        :aria-describedby="between.length > 0 || loose ? 'combine-gap' : undefined"
        data-testid="combine-make"
        @click="make"
        >Group</UiButton
      >
    </template>
  </UiDialog>
</template>

<style scoped>
.combine {
  display: grid;
  gap: var(--space-2);
}
.combine__label {
  color: var(--ink-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}
.combine__input {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.combine__input:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
.combine__gap {
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius);
  color: var(--warn);
  background: var(--warn-soft);
  font-size: var(--text-sm);
}
</style>
