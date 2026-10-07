<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import {
  PICTURE_ITEM_KINDS,
  type PictureItem,
  type PictureItemKind,
} from "../../../src/studio/pictureDocument.ts";
import { priorityForY } from "../../../src/runtime/priority.ts";
import { SCREEN_HEIGHT } from "../../../src/types.ts";
import { DEFAULT_BAND } from "./studioTools.ts";
import StudioValuePicker from "./StudioValuePicker.vue";
import { explain } from "./studioTerms.ts";
import { keyLabel } from "../ui/keyLabel.ts";
import { CONTROL_VALUES } from "./studioView.ts";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The inspector's editor for the selected item, at its essentials: its kind
 * and Lock, its art colour and its depth (each checked against the lens
 * locks; a locked one says so), and its actions: Duplicate, Delete, Earlier and
 * Later in the draw order, and Ungroup for an item grouped here. Its
 * points wait under Details (StudioItemPoints.vue). Every change is one
 * kernel edit; a refused one leaves the field showing the item as it is.
 */
const {
  item,
  visual,
  priority,
  locks,
  edit,
  grouped = false,
} = defineProps<{
  item: PictureItem;
  /** The one colour the item draws, null when it draws none, undefined for several. */
  visual: number | null | undefined;
  priority: number | null | undefined;
  /** Why each plane's value is locked now, or null when it is open. */
  locks: {
    visual: string | null;
    priority: string | null;
  };
  edit: StudioEditing;
  /** The item was grouped here: Ungroup gives its parts back. */
  grouped?: boolean;
}>();
const emit = defineEmits<{ ungroup: [] }>();

/** Item kinds in the layers' own words. */
const KIND_LABELS: Record<PictureItemKind, string> = {
  art: "Visual",
  depth: "Priority",
  walk: "Walls",
  mixed: "Mixed",
};
const KINDS = PICTURE_ITEM_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] }));

/** The first row whose band is `value`, or undefined. */
function bandTop(value: number): number | undefined {
  for (let y = 0; y < SCREEN_HEIGHT; y++) if (priorityForY(y) === value) return y;
  return undefined;
}
/** What the item's priority does to a character, in a few words. */
const depthNote = computed(() => {
  const value = priority;
  if (value === undefined) return "mixed";
  if (value === null) return "off";
  const control = CONTROL_VALUES[value];
  if (control) return control.name;
  if (value === 4) return "behind every character";
  const top = bandTop(value);
  return top === undefined ? "hides every character" : `hides characters above y ${top}`;
});
/** The pen's distance band: its own when the item draws one, else a middle band. */
const band = computed(() =>
  typeof priority === "number" && priority >= 4 ? priority : DEFAULT_BAND,
);
const penDisabled = computed(() => locks.priority !== null || item.locked);
const penReason = computed(
  () => locks.priority ?? (item.locked ? "Unlock the item first." : undefined),
);
</script>

<template>
  <div class="item-editor" data-testid="item-editor">
    <section class="item-editor__sec">
      <div class="item-editor__row">
        <UiSegmented
          size="sm"
          label="Kind"
          :model-value="item.kind"
          :options="KINDS"
          @update:model-value="edit.setMeta({ kind: $event as PictureItemKind })"
        />
        <span class="item-editor__with">
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
          <UiExplain v-bind="explain('item-lock')" />
        </span>
      </div>
    </section>

    <section class="item-editor__sec" data-role="visual">
      <h3>
        Visual pen
        <em v-if="locks.visual" class="item-editor__lock"
          ><UiIcon name="lock" :size="12" />locked</em
        >
        <em v-else-if="visual === undefined">mixed</em>
      </h3>
      <StudioValuePicker
        plane="visual"
        label="Visual colour"
        :value="visual"
        :disabled="locks.visual !== null || item.locked"
        :title="locks.visual ?? undefined"
        @pick="edit.setColour('visual', $event)"
      />
    </section>

    <section class="item-editor__sec" data-role="priority">
      <h3>
        <span class="item-editor__with">Priority pen <UiExplain v-bind="explain('depth')" /></span>
        <em v-if="locks.priority" class="item-editor__lock"
          ><UiIcon name="lock" :size="12" />locked</em
        >
        <em v-else>{{ depthNote }}</em>
      </h3>
      <div
        class="item-editor__pen"
        role="radiogroup"
        aria-label="Priority pen"
        :title="locks.priority ?? undefined"
      >
        <button
          type="button"
          role="radio"
          class="item-editor__choice"
          :aria-checked="priority === null"
          :disabled="penDisabled"
          :title="penDisabled ? penReason : undefined"
          data-value="off"
          @click="edit.setColour('priority', null)"
        >
          Off
        </button>
        <button
          type="button"
          role="radio"
          class="item-editor__choice"
          :aria-checked="typeof priority === 'number' && priority >= 4"
          :disabled="penDisabled"
          :title="penDisabled ? penReason : undefined"
          data-value="distance"
          @click="edit.setColour('priority', band)"
        >
          Distance
        </button>
        <button
          v-for="control in CONTROL_VALUES"
          :key="control.value"
          type="button"
          role="radio"
          class="item-editor__choice"
          :aria-checked="priority === control.value"
          :disabled="penDisabled"
          :data-value="control.value"
          :title="control.help"
          @click="edit.setColour('priority', control.value)"
        >
          {{ control.name }}
        </button>
      </div>
      <label
        v-if="typeof priority === 'number' && priority >= 4"
        class="item-editor__slider"
        :class="{ 'is-locked': penDisabled }"
        ><span>Far</span>
        <input
          type="range"
          min="4"
          max="15"
          step="1"
          :value="priority"
          :disabled="penDisabled"
          aria-label="Distance band"
          data-testid="priority-band"
          @input="edit.setColour('priority', Number(($event.target as HTMLInputElement).value))"
        />
        <span>Near</span>
        <b class="item-editor__band">{{ priority }}</b>
      </label>
    </section>

    <section class="item-editor__sec item-editor__actions" aria-label="Item actions">
      <UiButton size="sm" icon="copy" :shortcut="keyLabel('Mod+D')" @click="edit.duplicate()"
        >Duplicate</UiButton
      >
      <UiButton size="sm" variant="danger" icon="trash" shortcut="Del" @click="edit.remove()"
        >Delete</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        icon="arrow-left"
        shortcut="["
        title="Draw it earlier: later items cover it"
        @click="edit.reorder(-1)"
        >Earlier</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        icon="arrow-right"
        shortcut="]"
        title="Draw it later: it covers earlier items"
        @click="edit.reorder(1)"
        >Later</UiButton
      >
      <UiButton
        v-if="grouped"
        size="sm"
        icon="unlink"
        :shortcut="keyLabel('Mod+Shift+G')"
        data-testid="item-ungroup"
        @click="emit('ungroup')"
        >Ungroup</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        data-testid="stand-in-room"
        title="Sets its distance from its base and draws the wall line along it"
        @click="edit.standInRoom()"
        >Stand in the room</UiButton
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
  align-items: center;
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
.item-editor__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.item-editor__pen {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.item-editor__choice {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: transparent;
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}
.item-editor__choice:disabled {
  opacity: 0.45;
  cursor: default;
}
.item-editor__choice[aria-checked="true"] {
  color: var(--action);
  border-color: var(--action-line);
  background: var(--action-soft);
}
.item-editor__slider {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.item-editor__slider input {
  flex: 1;
  min-width: 0;
}
.item-editor__band {
  min-width: 2ch;
  color: var(--ink);
  font-family: var(--font-mono);
  text-align: right;
}
.item-editor__slider.is-locked {
  opacity: 0.45;
}
.item-editor__with {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.item-editor__sec h3 em.item-editor__lock {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--warn);
}
.item-editor__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
