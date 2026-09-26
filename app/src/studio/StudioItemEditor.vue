<script setup lang="ts">
import { computed, ref } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { priorityForY } from "../../../src/runtime/priority.ts";
import type { LineHandle } from "../../../src/studio/editPoints.ts";
import { MAX_X, MAX_Y } from "../../../src/studio/editSource.ts";
import {
  PICTURE_ITEM_KINDS,
  type PictureItem,
  type PictureItemKind,
} from "../../../src/studio/pictureDocument.ts";
import { SCREEN_HEIGHT } from "../../../src/types.ts";
import StudioValuePicker from "./StudioValuePicker.vue";
import { CONTROL_VALUES } from "./studioView.ts";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The inspector's editor for the selected item: label, kind and lock, its
 * colour and priority (each checked against the lens locks), its points as
 * numbers, and the item commands. Every change is one kernel edit; a refused
 * one leaves the field showing the item as it is.
 */
const { item, visual, priority, handles, locks, edit } = defineProps<{
  item: PictureItem;
  /** The one colour the item draws, null when it draws none, undefined for several. */
  visual: number | null | undefined;
  priority: number | null | undefined;
  handles: readonly LineHandle[];
  /** Why each plane's value is locked now, or null when it is open. */
  locks: {
    visual: string | null;
    priority: string | null;
    /** Depth values 4–15 are locked (the Walk lens). */
    depthValues: boolean;
  };
  edit: StudioEditing;
}>();

const KINDS = PICTURE_ITEM_KINDS.map((kind) => ({
  value: kind,
  label: `${kind[0]!.toUpperCase()}${kind.slice(1)}`,
}));
/** Point rows shown before "Show all". */
const FEW = 6;
const showAll = ref(false);
const shown = computed(() => (showAll.value ? handles : handles.slice(0, FEW)));

/** The first row whose baseline band is `value`, or undefined. */
function bandTop(value: number): number | undefined {
  for (let y = 0; y < SCREEN_HEIGHT; y++) if (priorityForY(y) === value) return y;
  return undefined;
}
const priorityNote = computed(() => {
  const value = priority;
  if (value === undefined) return "draws several values";
  if (value === null) return "draws no priority";
  const control = CONTROL_VALUES[value];
  if (control) return `${control.name}: a control line, not depth`;
  if (value === 4) return "background: hides no actor";
  const top = bandTop(value);
  return top === undefined ? "hides every actor" : `hides actors above y ${top}`;
});

function commitLabel(event: Event): void {
  const input = event.target as HTMLInputElement;
  const label = input.value.trim();
  if (label === item.label || !edit.setMeta({ label })) input.value = item.label;
}
function commitPoint(event: Event, handle: LineHandle, axis: "x" | "y"): void {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  const x = axis === "x" ? value : handle.x;
  const y = axis === "y" ? value : handle.y;
  if (!Number.isInteger(value) || !edit.setPoint(handle.line, handle.index, x, y))
    input.value = String(handle[axis]);
}
</script>

<template>
  <div class="item-editor" data-testid="item-editor">
    <section class="item-editor__sec">
      <label class="item-editor__field">
        <span>Label</span>
        <input
          class="item-editor__input"
          :value="item.label"
          data-testid="item-label"
          @change="commitLabel"
        />
      </label>
      <div class="item-editor__row">
        <UiSegmented
          size="sm"
          label="Kind"
          :model-value="item.kind"
          :options="KINDS"
          @update:model-value="edit.setMeta({ kind: $event as PictureItemKind })"
        />
        <UiButton
          variant="ghost"
          size="sm"
          :icon="item.locked ? 'lock' : 'lock-open'"
          :aria-pressed="item.locked"
          data-testid="item-lock"
          @click="edit.setMeta({ locked: !item.locked })"
        >
          {{ item.locked ? "Locked" : "Lock" }}
        </UiButton>
      </div>
    </section>

    <section class="item-editor__sec" data-role="priority">
      <h3>
        Priority <em>{{ locks.priority ?? priorityNote }}</em>
      </h3>
      <StudioValuePicker
        plane="priority"
        label="Priority value"
        :value="priority"
        :disabled="locks.priority !== null || item.locked"
        :allowed="(v) => !locks.depthValues || v < 4"
        @pick="edit.setColour('priority', $event)"
      />
      <p class="item-editor__note">
        0 barrier · 1 conditional · 2 signal · 3 water are control lines; 4–15 are depth bands.
        <template v-if="locks.depthValues">The Walk lens keeps depth values locked.</template>
      </p>
    </section>

    <section class="item-editor__sec" data-role="visual">
      <h3>
        Appearance <em>{{ locks.visual ?? (visual === undefined ? "several colours" : "") }}</em>
      </h3>
      <StudioValuePicker
        plane="visual"
        label="Visual colour"
        :value="visual"
        :disabled="locks.visual !== null || item.locked"
        @pick="edit.setColour('visual', $event)"
      />
    </section>

    <section v-if="handles.length > 0" class="item-editor__sec" data-role="points">
      <h3>Points <em>arrow keys nudge 1 px</em></h3>
      <div class="item-editor__points">
        <template v-for="handle in shown" :key="`${handle.line}:${handle.index}`">
          <span class="item-editor__pt" :title="`Source line ${handle.line}`"
            >{{ handle.kind === "seed" ? "seed" : "line" }} {{ handle.line }} ·
            {{ handle.index + 1 }}</span
          >
          <input
            class="item-editor__input item-editor__num"
            type="number"
            min="0"
            :max="MAX_X"
            :value="handle.x"
            :aria-label="`Point ${handle.index} of line ${handle.line}, x`"
            :disabled="item.locked"
            @change="commitPoint($event, handle, 'x')"
          />
          <input
            class="item-editor__input item-editor__num"
            type="number"
            min="0"
            :max="MAX_Y"
            :value="handle.y"
            :aria-label="`Point ${handle.index} of line ${handle.line}, y`"
            :disabled="item.locked"
            @change="commitPoint($event, handle, 'y')"
          />
        </template>
      </div>
      <UiButton
        v-if="handles.length > FEW"
        variant="ghost"
        size="sm"
        class="item-editor__more"
        @click="showAll = !showAll"
      >
        {{ showAll ? "Show fewer" : `Show all ${handles.length} points` }}
      </UiButton>
    </section>

    <section class="item-editor__sec item-editor__actions" aria-label="Item commands">
      <UiButton size="sm" icon="copy" shortcut="⌘D" @click="edit.duplicate()">Duplicate</UiButton>
      <UiButton size="sm" variant="danger" icon="trash" shortcut="Del" @click="edit.remove()"
        >Delete</UiButton
      >
      <UiButton size="sm" variant="ghost" shortcut="[" @click="edit.reorder(-1)"
        >Move back</UiButton
      >
      <UiButton size="sm" variant="ghost" shortcut="]" @click="edit.reorder(1)"
        >Move forward</UiButton
      >
    </section>
  </div>
</template>

<style scoped>
.item-editor__sec {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.item-editor__sec h3 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.item-editor__sec h3 em {
  min-width: 0;
  overflow: hidden;
  font-style: normal;
  font-weight: var(--weight-medium);
  letter-spacing: 0;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
}
.item-editor__field {
  display: grid;
  gap: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.item-editor__input {
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h-sm);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.item-editor__input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
.item-editor__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.item-editor__note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.item-editor__points {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
  align-items: center;
  gap: var(--space-1) var(--space-2);
}
.item-editor__pt {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
  white-space: nowrap;
}
.item-editor__num {
  min-height: 28px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.item-editor__more {
  justify-self: start;
}
.item-editor__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
