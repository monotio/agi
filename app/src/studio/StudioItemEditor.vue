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
import StudioValuePicker from "./StudioValuePicker.vue";
import { explain } from "./studioTerms.ts";
import { keyLabel } from "../ui/keyLabel.ts";
import { CONTROL_VALUES } from "./studioView.ts";
import type { StudioEditing } from "./useStudioEditing.ts";

/**
 * The inspector's editor for the selected item, at its essentials: its kind
 * and Lock, its art colour and its depth (each checked against the lens
 * locks; a locked one says so), and its actions: Duplicate, Delete, Back and
 * Forward in the draw order, and Ungroup for an item grouped here. Its
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
    /** Depth values 4–15 are locked (the Walk lens). */
    depthValues: boolean;
  };
  edit: StudioEditing;
  /** The item was grouped here: Ungroup gives its parts back. */
  grouped?: boolean;
}>();
const emit = defineEmits<{ ungroup: [] }>();

const KINDS = PICTURE_ITEM_KINDS.map((kind) => ({
  value: kind,
  label: `${kind[0]!.toUpperCase()}${kind.slice(1)}`,
}));

/** The first row whose band is `value`, or undefined. */
function bandTop(value: number): number | undefined {
  for (let y = 0; y < SCREEN_HEIGHT; y++) if (priorityForY(y) === value) return y;
  return undefined;
}
/** What the item's depth does to a character, in a few words. */
const depthNote = computed(() => {
  const value = priority;
  if (value === undefined) return "mixed";
  if (value === null) return "off";
  const control = CONTROL_VALUES[value];
  if (control) return `${control.name} walk line`;
  if (value === 4) return "behind every character";
  const top = bandTop(value);
  return top === undefined ? "hides every character" : `hides characters above y ${top}`;
});
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
        Art
        <em v-if="locks.visual" class="item-editor__lock"
          ><UiIcon name="lock" :size="12" />locked</em
        >
        <em v-else-if="visual === undefined">mixed</em>
      </h3>
      <StudioValuePicker
        plane="visual"
        label="Art colour"
        :value="visual"
        :disabled="locks.visual !== null || item.locked"
        :title="locks.visual ?? undefined"
        @pick="edit.setColour('visual', $event)"
      />
    </section>

    <section class="item-editor__sec" data-role="priority">
      <h3>
        <span class="item-editor__with">Depth <UiExplain v-bind="explain('depth')" /></span>
        <em v-if="locks.priority" class="item-editor__lock"
          ><UiIcon name="lock" :size="12" />locked</em
        >
        <em v-else-if="locks.depthValues" class="item-editor__lock"
          ><UiIcon name="lock" :size="12" />walk lines only</em
        >
        <em v-else>{{ depthNote }}</em>
      </h3>
      <StudioValuePicker
        plane="priority"
        label="Depth value"
        :value="priority"
        :disabled="locks.priority !== null || item.locked"
        :allowed="(v) => !locks.depthValues || v < 4"
        :title="locks.priority ?? undefined"
        @pick="edit.setColour('priority', $event)"
      />
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
        shortcut="["
        title="Draw it earlier: later items cover it"
        @click="edit.reorder(-1)"
        >Back</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        shortcut="]"
        title="Draw it later: it covers earlier items"
        @click="edit.reorder(1)"
        >Forward</UiButton
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
