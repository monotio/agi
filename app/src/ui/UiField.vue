<script setup lang="ts">
import { useId } from "vue";

/**
 * Label, hint and error around one control. The slot receives the ids to wire
 * up: `<UiField v-slot="{ id, describedBy }"><input :id :aria-describedby="describedBy"></UiField>`.
 */
const { hint = undefined, error = undefined } = defineProps<{
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}>();
const id = useId();
</script>

<template>
  <div class="ui-field" :class="[{ 'ui-field--error': error }]">
    <label class="ui-field__label" :for="id">{{ label }}</label>
    <slot
      :id="id"
      :described-by="error || hint ? `${id}-note` : undefined"
      :invalid="Boolean(error)"
    />
    <p
      v-if="error || hint"
      :id="`${id}-note`"
      class="ui-field__note"
      :role="error ? 'alert' : undefined"
    >
      {{ error ?? hint }}
    </p>
  </div>
</template>

<style scoped>
.ui-field {
  display: grid;
  gap: var(--space-2);
}
.ui-field__label {
  color: var(--ink-2);
  font: var(--weight-semibold) var(--text-sm) / var(--leading-tight) var(--font-sans);
}
.ui-field__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.ui-field--error .ui-field__note {
  color: var(--danger);
}
.ui-field :slotted(:is(input, textarea, select)) {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.ui-field :slotted(:is(input, textarea, select):hover) {
  border-color: var(--ink-3);
}
.ui-field--error :slotted(:is(input, textarea, select)) {
  border-color: var(--danger);
}
</style>
