<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiPanel from "../ui/UiPanel.vue";
import { labelParts, type LabelParts } from "./studioView.ts";
import type { SceneBranch, SceneGroupRow, SceneRow, SceneSectionRow } from "./useStudioDocument.ts";

/**
 * The Scene list: a tree of items in draw order (automatic groups of
 * consecutive look-alike items, then their members; a long list first folds
 * into draw-order sections), then the loose lines as Unassigned. Arrow keys
 * move a cursor that also hovers (so the canvas highlights it), Right and Left
 * open and close a section or group, Enter selects. The filter narrows to a
 * flat list of matching items. A label too long for the column ellipsizes in
 * its middle, so the numbers that tell rows apart stay (studioView.ts
 * `labelParts`); the whole label is its tooltip.
 */
const { branches, sections, matches, loose, hoveredId, selectedId } = defineProps<{
  branches: readonly SceneBranch[];
  /** Draw-order sections over `branches`; empty for a short list. */
  sections: readonly SceneSectionRow[];
  /** Items matching the filter, flat; null while the filter is empty. */
  matches: readonly SceneRow[] | null;
  /** The Unassigned row, when there are loose lines (and it matches the filter). */
  loose: SceneRow | undefined;
  hoveredId: string | undefined;
  selectedId: string | undefined;
}>();
const emit = defineEmits<{ hover: [id: string | undefined]; select: [id: string] }>();
const filter = defineModel<string>("filter", { required: true });

/** Above this many items, groups start closed. Sections always do. */
const OPEN_UP_TO = 40;

interface Entry {
  row: SceneRow;
  level: 1 | 2 | 3;
  /** Set on a section's or group's own row: the rows it folds. */
  fold?: SceneGroupRow;
  /** Set on a section's own row. */
  section?: SceneSectionRow;
  /** The section or group the row sits in. */
  parent?: string;
}

const listId = useId();
const list = useTemplateRef("list");
const cursor = ref<string>();
const itemTotal = computed(() => branches.reduce((n, branch) => n + branch.rows.length, 0));
const folds = computed(() => [...sections, ...branches.flatMap((branch) => branch.group ?? [])]);
const expanded = ref(new Set<string>());
/** The section or group each item and group sits in. */
const parentOf = computed(() => {
  const parent = new Map<string, string>();
  for (const section of sections)
    for (const { group, rows } of section.branches) parent.set(group?.id ?? rows[0].id, section.id);
  for (const { group } of branches)
    if (group) for (const id of group.members) parent.set(id, group.id);
  return parent;
});
/** The sections and groups holding `id`, innermost first. */
function ancestors(id: string): string[] {
  const out: string[] = [];
  for (let up = parentOf.value.get(id); up !== undefined; up = parentOf.value.get(up)) out.push(up);
  return out;
}

watch(
  () => [branches, sections],
  () => {
    const open = sections.length === 0 && itemTotal.value <= OPEN_UP_TO;
    expanded.value = new Set(open ? folds.value.map((fold) => fold.id) : []);
  },
  { immediate: true },
);

function branchEntries(
  list: readonly SceneBranch[],
  level: 1 | 2,
  parent: string | undefined,
): Entry[] {
  const at = (entry: Entry): Entry => (parent === undefined ? entry : { ...entry, parent });
  return list.flatMap(({ group, rows }): Entry[] =>
    group === null
      ? [at({ row: rows[0], level })]
      : [
          at({ row: group, level, fold: group }),
          ...(expanded.value.has(group.id)
            ? rows.map((row): Entry => ({ row, level: level === 1 ? 2 : 3, parent: group.id }))
            : []),
        ],
  );
}
const entries = computed<(Entry & { label: LabelParts })[]>(() => {
  const out: Entry[] =
    matches !== null
      ? matches.map((row) => ({ row, level: 1 }))
      : sections.length === 0
        ? branchEntries(branches, 1, undefined)
        : sections.flatMap((section): Entry[] => [
            { row: section, level: 1, fold: section, section },
            ...(expanded.value.has(section.id)
              ? branchEntries(section.branches, 2, section.id)
              : []),
          ]);
  if (loose) out.push({ row: loose, level: 1 });
  return out.map((entry) => ({
    ...entry,
    label: labelParts(entry.row === loose ? "Loose lines" : entry.row.label),
  }));
});
const itemEntries = computed(() => entries.value.filter((entry) => entry.row !== loose));
const allOpen = computed(() => folds.value.every((fold) => expanded.value.has(fold.id)));

const optionId = (id: string): string => `${listId}-${id.replace(/[^a-z0-9_-]/g, "_")}`;

function setOpen(ids: readonly string[], open: boolean): void {
  const next = new Set(expanded.value);
  for (const id of ids) {
    if (open) next.add(id);
    else next.delete(id);
  }
  expanded.value = next;
}
function toggleAll(): void {
  expanded.value = new Set(allOpen.value ? [] : folds.value.map((fold) => fold.id));
}

/** The row shown for `id`: the row itself, or the outermost closed section or group holding it. */
function shownFor(id: string | undefined): string | undefined {
  if (id === undefined || matches !== null) return id;
  return ancestors(id).findLast((up) => !expanded.value.has(up)) ?? id;
}
function reveal(id: string | undefined): void {
  const shown = shownFor(id);
  if (shown === undefined) return;
  void nextTick(() =>
    list.value
      ?.querySelector(`#${CSS.escape(optionId(shown))}`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}
watch(
  () => hoveredId,
  (id) => {
    if (id !== cursor.value) reveal(id);
  },
);
// A canvas click or an arrow step selects the finest item: open its section and group.
watch(
  () => selectedId,
  (id) => {
    if (id !== undefined && matches === null) setOpen(ancestors(id), true);
    reveal(id);
  },
);

const isHover = (entry: Entry): boolean =>
  entry.row.id === hoveredId || (entry.fold !== undefined && shownFor(hoveredId) === entry.row.id);

function moveTo(index: number): void {
  const rows = entries.value;
  if (rows.length === 0) return;
  cursor.value = rows[Math.min(rows.length - 1, Math.max(0, index))]!.row.id;
  emit("hover", cursor.value);
  reveal(cursor.value);
}
function onKeydown(event: KeyboardEvent): void {
  const rows = entries.value;
  const from = rows.findIndex((entry) => entry.row.id === (cursor.value ?? selectedId));
  const at = rows[from];
  if (event.key === "ArrowDown") moveTo(from < 0 ? 0 : from + 1);
  else if (event.key === "ArrowUp") moveTo(from < 0 ? rows.length - 1 : from - 1);
  else if (event.key === "Home") moveTo(0);
  else if (event.key === "End") moveTo(rows.length - 1);
  else if (event.key === "ArrowRight" && at?.fold) {
    if (expanded.value.has(at.fold.id)) moveTo(from + 1);
    else setOpen([at.fold.id], true);
  } else if (event.key === "ArrowLeft" && at?.fold && expanded.value.has(at.fold.id)) {
    setOpen([at.fold.id], false);
  } else if (event.key === "ArrowLeft" && at?.parent !== undefined) {
    const parent = at.parent;
    moveTo(rows.findIndex((entry) => entry.row.id === parent));
  } else if ((event.key === "Enter" || event.key === " ") && cursor.value !== undefined)
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
      <UiButton
        v-if="folds.length > 0 && matches === null"
        variant="ghost"
        size="sm"
        class="scene-list__all"
        data-testid="scene-toggle-groups"
        @click="toggleAll"
      >
        {{ allOpen ? "Collapse all" : "Expand all" }}
      </UiButton>
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
      role="tree"
      aria-label="Scene items in draw order"
      tabindex="0"
      :aria-activedescendant="cursor === undefined ? undefined : optionId(cursor)"
      @keydown="onKeydown"
      @blur="onBlur"
      @pointerleave="emit('hover', undefined)"
    >
      <li v-if="itemEntries.length > 0" class="scene-list__heading" role="presentation">
        <span>Items</span><span>{{ matches?.length ?? itemTotal }}</span>
      </li>
      <template v-for="entry in entries" :key="entry.row.id">
        <li v-if="entry.row === loose" class="scene-list__heading" role="presentation">
          <span>Unassigned</span>
        </li>
        <li
          :id="optionId(entry.row.id)"
          class="scene-list__row"
          :class="{
            'is-group': entry.fold,
            'is-hover': isHover(entry),
            'is-cursor': entry.row.id === cursor,
            'is-dim': entry.row.entries.length === 0,
          }"
          role="treeitem"
          :aria-level="entry.level"
          :aria-expanded="entry.fold ? expanded.has(entry.fold.id) : undefined"
          :aria-selected="entry.row.id === selectedId"
          :data-row="entry.row.id"
          @pointerenter="emit('hover', entry.row.id)"
          @click="emit('select', entry.row.id)"
        >
          <span
            v-if="entry.fold"
            class="scene-list__twisty"
            data-role="twisty"
            aria-hidden="true"
            @click.stop="setOpen([entry.fold.id], !expanded.has(entry.fold.id))"
            ><UiIcon
              :name="expanded.has(entry.fold.id) ? 'chevron-down' : 'chevron-right'"
              :size="12"
          /></span>
          <i
            v-if="!entry.section"
            class="scene-list__swatch"
            :class="{ 'is-empty': entry.row.swatch === null }"
            :style="
              entry.row.swatch === null
                ? undefined
                : { background: `var(--agi-${entry.row.swatch})` }
            "
            aria-hidden="true"
          ></i>
          <span class="scene-list__label" :title="entry.label.full"
            ><span class="scene-list__head">{{ entry.label.head }}</span
            ><span class="scene-list__tail">{{ entry.label.tail }}</span></span
          >
          <span v-if="entry.section" class="scene-list__swatches" data-role="section-swatches">
            <i
              v-for="colour in entry.section.swatches"
              :key="colour"
              :style="{ background: `var(--agi-${colour})` }"
              aria-hidden="true"
            ></i>
          </span>
          <span v-else class="scene-list__tag" :title="`Kind: ${entry.row.kind}`">{{
            entry.row.tag
          }}</span>
          <span class="scene-list__count" :title="`${entry.row.entries.length} commands`">{{
            entry.row.entries.length
          }}</span>
          <UiIcon v-if="entry.row.locked" name="lock" :size="12" class="scene-list__lock" />
        </li>
      </template>
      <li v-if="entries.length === 0" class="scene-list__empty" role="presentation">
        No items match “{{ filter }}”.
      </li>
    </ul>
    <template #footer>
      <span class="scene-list__foot" data-role="scene-count">
        <template v-if="matches !== null">{{ matches.length }} of {{ itemTotal }} items</template>
        <template v-else-if="sections.length > 0"
          >{{ itemTotal }} items · {{ sections.length }} sections</template
        >
        <template v-else
          >{{ itemTotal }} items<template v-if="folds.length > 0">
            in {{ branches.length }} rows</template
          ></template
        >
      </span>
      <slot name="notice" />
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
  white-space: nowrap;
}
.scene-list__all {
  white-space: nowrap;
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
/* The field itself draws no outline: the ring every control shows goes round the whole box. */
.scene-list__filter:has(.scene-list__input:focus-visible) {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
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
.scene-list__heading {
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
  grid-template-columns: 12px 12px minmax(0, 1fr) auto 28px 12px;
  align-items: center;
  gap: var(--space-2);
  height: 30px;
  padding: 0 var(--space-4) 0 var(--space-3);
  color: var(--ink-2);
  font-size: var(--text-sm);
  cursor: pointer;
}
.scene-list__row > * {
  grid-row: 1;
}
.scene-list__row[aria-level="2"] {
  padding-left: var(--space-7);
}
.scene-list__row[aria-level="3"] {
  padding-left: calc(var(--space-7) + var(--space-6));
}
.scene-list__swatches {
  grid-column: 4;
  display: flex;
  gap: var(--space-0);
}
.scene-list__swatches i {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.scene-list__row.is-group {
  color: var(--ink);
}
.scene-list__twisty {
  grid-column: 1;
  display: grid;
  place-items: center;
  color: var(--ink-3);
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
  grid-column: 2;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
.scene-list__swatch.is-empty {
  background: repeating-linear-gradient(45deg, var(--surface-3) 0 2px, transparent 2px 4px);
}
.scene-list__label {
  grid-column: 3;
  display: flex;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.scene-list__head {
  min-width: 1.5em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scene-list__tail {
  flex: none;
  white-space: pre;
}
.scene-list__tag {
  grid-column: 4;
  padding: 0 var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  font: var(--text-2xs) / 1.4 var(--font-mono);
}
.scene-list__count {
  grid-column: 5;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
  text-align: right;
}
.scene-list__lock {
  grid-column: 6;
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
