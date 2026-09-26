<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import UiPanel from "../ui/UiPanel.vue";
import { UNASSIGNED, type SceneRow } from "./useStudioDocument.ts";

/**
 * The Scene list: items in draw order, then the loose lines as Unassigned.
 * Arrow keys move a cursor that also hovers (so the canvas highlights it),
 * Enter selects; the filter narrows by label, id or tag.
 */
const { rows, total, hoveredId, selectedId } = defineProps<{
  /** Rows after the filter. */
  rows: readonly SceneRow[];
  /** Row count before the filter. */
  total: number;
  hoveredId: string | undefined;
  selectedId: string | undefined;
}>();
const emit = defineEmits<{ hover: [id: string | undefined]; select: [id: string] }>();
const filter = defineModel<string>("filter", { required: true });

const listId = useId();
const list = useTemplateRef("list");
const cursor = ref<string>();
const items = computed(() => rows.filter((row) => row.id !== UNASSIGNED));
const loose = computed(() => rows.find((row) => row.id === UNASSIGNED));
const optionId = (id: string): string => `${listId}-${id.replace(/[^a-z0-9_-]/g, "_")}`;

function reveal(id: string | undefined): void {
  if (id === undefined) return;
  void nextTick(() =>
    list.value?.querySelector(`#${CSS.escape(optionId(id))}`)?.scrollIntoView({ block: "nearest" }),
  );
}
watch(
  () => hoveredId,
  (id) => {
    if (id !== cursor.value) reveal(id);
  },
);

function move(step: number): void {
  if (rows.length === 0) return;
  const from = rows.findIndex((row) => row.id === (cursor.value ?? selectedId));
  const to =
    from < 0
      ? step > 0
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, from + step));
  cursor.value = rows[to]!.id;
  emit("hover", cursor.value);
  reveal(cursor.value);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp")
    move(event.key === "ArrowDown" ? 1 : -1);
  else if (event.key === "Home" || event.key === "End")
    move(event.key === "Home" ? -rows.length : rows.length);
  else if ((event.key === "Enter" || event.key === " ") && cursor.value !== undefined)
    emit("select", cursor.value);
  else return;
  event.preventDefault();
}
function onBlur(): void {
  cursor.value = undefined;
  emit("hover", undefined);
}
function onFilterKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && filter.value !== "") {
    filter.value = "";
    event.preventDefault();
  }
}
</script>

<template>
  <UiPanel title="Scene" flush class="scene-list">
    <template #actions>
      <span class="scene-list__meta">draw order ↓</span>
    </template>
    <div class="scene-list__filter">
      <UiIcon name="search" :size="14" />
      <input
        v-model="filter"
        type="search"
        class="scene-list__input"
        placeholder="Filter items"
        aria-label="Filter items"
        @keydown="onFilterKeydown"
      />
    </div>
    <ul
      :id="listId"
      ref="list"
      class="scene-list__rows"
      role="listbox"
      aria-label="Scene items in draw order"
      tabindex="0"
      :aria-activedescendant="cursor === undefined ? undefined : optionId(cursor)"
      @keydown="onKeydown"
      @blur="onBlur"
      @pointerleave="emit('hover', undefined)"
    >
      <li v-if="items.length > 0" class="scene-list__group" role="presentation">
        <span>Items</span><span>{{ items.length }}</span>
      </li>
      <template v-for="row in [...items, ...(loose ? [loose] : [])]" :key="row.id">
        <li v-if="row.id === UNASSIGNED" class="scene-list__group" role="presentation">
          <span>Unassigned</span><span>{{ row.entries.length }}</span>
        </li>
        <li
          :id="optionId(row.id)"
          class="scene-list__row"
          :class="{
            'is-hover': row.id === hoveredId,
            'is-cursor': row.id === cursor,
            'is-dim': row.entries.length === 0,
          }"
          role="option"
          :aria-selected="row.id === selectedId"
          :data-row="row.id"
          @pointerenter="emit('hover', row.id)"
          @click="emit('select', row.id)"
        >
          <i
            class="scene-list__swatch"
            :class="{ 'is-empty': row.swatch === null }"
            :style="row.swatch === null ? undefined : { background: `var(--agi-${row.swatch})` }"
            aria-hidden="true"
          ></i>
          <span class="scene-list__label">{{
            row.id === UNASSIGNED ? "Loose lines" : row.label
          }}</span>
          <span class="scene-list__tag" :title="`Kind: ${row.kind}`">{{ row.tag }}</span>
          <span class="scene-list__count" :title="`${row.entries.length} commands`">{{
            row.entries.length
          }}</span>
          <UiIcon v-if="row.locked" name="lock" :size="12" class="scene-list__lock" />
        </li>
      </template>
      <li v-if="rows.length === 0" class="scene-list__empty" role="presentation">
        No items match “{{ filter }}”.
      </li>
    </ul>
    <template #footer>
      <span class="scene-list__foot">{{ rows.length }} of {{ total }} shown · read-only</span>
    </template>
  </UiPanel>
</template>

<style scoped>
.scene-list {
  min-height: 0;
  height: 100%;
}
.scene-list :deep(.ui-panel__body) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.scene-list__meta {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.scene-list__filter {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--control-h-sm);
  margin: 0 var(--space-4) var(--space-3);
  padding: 0 var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink-3);
  background: var(--surface-0);
}
.scene-list__filter:focus-within {
  border-color: var(--action-line);
}
.scene-list__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  color: var(--ink);
  background: transparent;
  font: var(--text-xs) var(--font-sans);
}
.scene-list__rows {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0 0 var(--space-3);
  overflow-y: auto;
  list-style: none;
  outline: 0;
}
.scene-list__rows:focus-visible {
  box-shadow: inset 0 0 0 2px var(--focus);
}
.scene-list__group {
  display: flex;
  justify-content: space-between;
  padding: var(--space-2) var(--space-5) var(--space-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.scene-list__row {
  position: relative;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr) auto 22px 12px;
  align-items: center;
  gap: var(--space-3);
  height: 30px;
  padding: 0 var(--space-4) 0 var(--space-5);
  color: var(--ink-2);
  font-size: var(--text-sm);
  cursor: pointer;
}
.scene-list__row.is-dim {
  color: var(--ink-3);
}
.scene-list__row.is-hover,
.scene-list__row.is-cursor {
  background: var(--surface-2);
}
.scene-list__row.is-cursor {
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.scene-list__row[aria-selected="true"] {
  color: var(--ink);
  background: var(--action-soft);
}
.scene-list__row[aria-selected="true"]::before {
  content: "";
  position: absolute;
  top: var(--space-1);
  bottom: var(--space-1);
  left: 0;
  width: 2px;
  border-radius: var(--radius-sm);
  background: var(--action);
}
.scene-list__swatch {
  width: 12px;
  height: 12px;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.scene-list__swatch.is-empty {
  background: repeating-linear-gradient(45deg, var(--surface-3) 0 2px, transparent 2px 4px);
}
.scene-list__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scene-list__tag {
  padding: 0 var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  font: var(--text-2xs) / 1.4 var(--font-mono);
}
.scene-list__count {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
  text-align: right;
}
.scene-list__lock {
  color: var(--ink-3);
}
.scene-list__empty {
  padding: var(--space-4) var(--space-5);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.scene-list__foot {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
