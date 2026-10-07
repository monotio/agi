<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { numberedSlot, type NumberedLabelContext } from "../../../../src/logic/numberedLabels.ts";
import { itemRoomOptions } from "./itemRoomOptions.ts";

const {
  value,
  context,
  label,
  disabled = false,
  testId = undefined,
} = defineProps<{
  value: number;
  context: NumberedLabelContext;
  label: string;
  disabled?: boolean | undefined;
  testId?: string;
}>();
const emit = defineEmits<{ change: [value: number] }>();
const options = computed(() => itemRoomOptions(context));
const custom = ref(false);
const unknown = computed(() => !options.value.some((option) => option.num === value));
const numberVisible = computed(() => custom.value || unknown.value);
watch(
  () => value,
  () => {
    custom.value = false;
  },
);

function select(event: Event): void {
  const selected = (event.target as HTMLSelectElement).value;
  custom.value = selected === "other";
  if (!custom.value) emit("change", Number(selected));
}
function enterNumber(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.value !== "" && input.validity.valid) emit("change", input.valueAsNumber);
}
</script>
<template>
  <div class="item-room-picker">
    <select
      :data-testid="testId"
      :aria-label="label"
      :disabled
      :value="custom ? 'other' : value"
      @change="select"
    >
      <option v-for="option in options" :key="option.num" :value="option.num">
        {{ option.label }}
      </option>
      <option v-if="unknown" :value>{{ numberedSlot("room", value) }}</option>
      <option value="other">Other number…</option>
    </select>
    <input
      v-if="numberVisible"
      type="number"
      min="1"
      max="254"
      step="1"
      :aria-label="`${label} number`"
      :disabled
      :value="value >= 1 && value <= 254 ? value : ''"
      @change="enterNumber"
    />
  </div>
</template>
<style scoped>
.item-room-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}
select,
input {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  font: var(--text-sm) var(--font-sans);
  background: var(--surface-0);
  color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
}
select {
  width: 100%;
}
input {
  width: 5rem;
}
</style>
