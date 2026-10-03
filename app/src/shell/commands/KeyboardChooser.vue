<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import UiDialog from "../../ui/UiDialog.vue";
import UiKbd from "../../ui/UiKbd.vue";
import { keyLabel } from "../../ui/keyLabel.ts";
import { fuzzyFilter } from "./fuzzyFilter.ts";
import type { ChooserItem } from "./chooserItems.ts";

const props = defineProps<{
  title: string;
  placeholder: string;
  items: readonly ChooserItem[];
  commandPrefix?: boolean;
}>();
const emit = defineEmits<{ mode: [commands: boolean] }>();
const open = defineModel<boolean>("open", { required: true });
const query = ref("");
const index = ref(0);
const input = useTemplateRef("input");
const listId = useId();
const commandMode = computed(() => props.commandPrefix === true && query.value.startsWith(">"));
const filtered = computed(() =>
  fuzzyFilter(
    props.items,
    commandMode.value ? query.value.slice(1) : query.value,
    (item) => item.title,
  ),
);
const selected = computed(() => filtered.value[index.value]);
const optionId = (position: number): string => `${listId}-${position}`;
watch(commandMode, (value) => emit("mode", value));
watch(filtered, () => {
  index.value = 0;
});
watch(
  open,
  async (value) => {
    if (!value) return;
    query.value = "";
    index.value = 0;
    await nextTick();
    await nextTick();
    input.value?.focus();
  },
  { immediate: true },
);
watch(index, async (value) => {
  await nextTick();
  document.getElementById(optionId(value))?.scrollIntoView({ block: "nearest" });
});

function choose(item: ChooserItem | undefined): void {
  if (!item || item.disabled || !item.run) return;
  open.value = false;
  // Let the modal restore focus before the action opens or focuses another surface.
  void nextTick()
    .then(() => nextTick())
    .then(() => item.run?.());
}
function onKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  const length = filtered.value.length;
  switch (event.key) {
    case "ArrowDown":
      index.value = length ? (index.value + 1) % length : 0;
      break;
    case "ArrowUp":
      index.value = length ? (index.value - 1 + length) % length : 0;
      break;
    case "Home":
      index.value = 0;
      break;
    case "End":
      index.value = Math.max(0, length - 1);
      break;
    case "Enter":
      choose(selected.value);
      break;
    case "Escape":
      open.value = false;
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
}
</script>

<template>
  <UiDialog v-model:open="open" :title="title" class="keyboard-chooser" data-shell-keys>
    <input
      ref="input"
      v-model="query"
      class="keyboard-chooser__input"
      type="text"
      role="combobox"
      :aria-label="title"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="selected ? optionId(index) : undefined"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      @keydown="onKey"
    />
    <ul :id="listId" class="keyboard-chooser__list" role="listbox" :aria-label="title">
      <li
        v-for="(item, position) in filtered"
        :id="optionId(position)"
        :key="item.id"
        role="option"
        :aria-selected="position === index"
        :aria-disabled="item.disabled || undefined"
        class="keyboard-chooser__option"
        @mousedown.prevent
        @click="choose(item)"
      >
        <span>{{ item.title }}</span>
        <span class="keyboard-chooser__keys"
          ><UiKbd v-for="key in item.keys" :key="key">{{ keyLabel(key) }}</UiKbd></span
        >
        <span v-if="item.disabled" class="keyboard-chooser__unavailable">Unavailable</span>
      </li>
    </ul>
    <p v-if="!filtered.length" class="keyboard-chooser__empty" role="status">No matches</p>
  </UiDialog>
</template>

<style scoped>
.keyboard-chooser.ui-dialog {
  margin-top: min(12dvh, 100px);
  width: min(640px, calc(100vw - 32px));
}
.keyboard-chooser__input {
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-0);
  color: var(--ink);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.keyboard-chooser__input:focus-visible {
  outline: 2px solid var(--action);
  outline-offset: 2px;
}
.keyboard-chooser__list {
  max-height: 45dvh;
  overflow: auto;
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}
.keyboard-chooser__option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--text-sm);
}
.keyboard-chooser__option[aria-selected="true"] {
  background: var(--action-soft);
}
.keyboard-chooser__option[aria-disabled="true"] {
  color: var(--ink-3);
  cursor: default;
}
.keyboard-chooser__keys {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
  white-space: nowrap;
}
.keyboard-chooser__unavailable,
.keyboard-chooser__empty {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
