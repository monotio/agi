<script setup lang="ts">
import { computed } from "vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { backdropKey, parseBackdrop, type SpriteBackdrop } from "./spriteView.ts";

/**
 * The canvas's view toggles, docked at the right of the options bar: the
 * contact sheet of every cel in place of the canvas, onion skins of the
 * previous and next cels (and how many of each, 1 to 3), the grid, the
 * baseline, and the backdrop behind transparent pixels. None of them
 * changes the view: the backdrop is only while drawing, never the view's
 * transparent colour.
 *
 * A narrow options bar folds the least used of them into a More menu
 * (`fold`: 1 the backdrop, the grid and the baseline; 2 the contact sheet
 * too); the onion skins stay in the bar.
 */
const { roomBackdrop = null, fold = 0 } = defineProps<{
  /** The room a Room backdrop shows, when a room uses the view. */
  roomBackdrop?: number | null;
  /** How many groups are folded into More: 0 none, 1 backdrop, grid and baseline, 2 the contact sheet too. */
  fold?: number;
}>();
const sheet = defineModel<boolean>("sheet", { required: true });
const prev = defineModel<boolean>("prev", { required: true });
const next = defineModel<boolean>("next", { required: true });
const depth = defineModel<number>("depth", { required: true });
const grid = defineModel<boolean>("grid", { required: true });
const baseline = defineModel<boolean>("baseline", { required: true });
const backdrop = defineModel<SpriteBackdrop>("backdrop", { required: true });
const backdropValue = computed({
  get: () => backdropKey(backdrop.value),
  set: (value: string) => (backdrop.value = parseBackdrop(value)),
});
const CHECKERS = [
  { key: "checker-dark", label: "Dark checker" },
  { key: "checker-light", label: "Light checker" },
] as const;
</script>

<template>
  <div class="sprite-view-bar" role="group" aria-label="Canvas view">
    <label
      v-if="fold < 1"
      class="sprite-view-bar__backdrop"
      title="Only while drawing: the view's transparent colour stays as it is"
    >
      <span>Backdrop</span>
      <select v-model="backdropValue" data-testid="sprite-backdrop">
        <option value="checker-dark">Dark checker</option>
        <option value="checker-light">Light checker</option>
        <option v-if="roomBackdrop !== null" value="room">Room {{ roomBackdrop }}</option>
        <optgroup label="Solid colour">
          <option
            v-for="(name, colour) in EGA_COLOUR_NAMES"
            :key="colour"
            :value="`colour-${colour}`"
          >
            {{ colour }} · {{ name }}
          </option>
        </optgroup>
      </select>
    </label>
    <button
      v-if="fold < 2"
      type="button"
      class="sprite-view-bar__toggle"
      :aria-pressed="sheet"
      data-testid="sprite-sheet-toggle"
      @click="sheet = !sheet"
    >
      Contact sheet
    </button>
    <template v-if="!sheet">
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="prev"
        data-testid="sprite-onion-prev"
        @click="prev = !prev"
      >
        <i class="sprite-view-bar__tint is-prev" aria-hidden="true"></i>Onion −{{ depth }}
      </button>
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="next"
        data-testid="sprite-onion-next"
        @click="next = !next"
      >
        <i class="sprite-view-bar__tint is-next" aria-hidden="true"></i>+{{ depth }}
      </button>
      <label class="sprite-view-bar__depth">
        <span class="sprite-view-bar__sr">Onion skin cels</span>
        <select v-model.number="depth" data-testid="sprite-onion-depth">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>
      </label>
      <template v-if="fold < 1">
        <button
          type="button"
          class="sprite-view-bar__toggle"
          :aria-pressed="grid"
          data-testid="sprite-grid"
          @click="grid = !grid"
        >
          Grid
        </button>
        <button
          type="button"
          class="sprite-view-bar__toggle"
          :aria-pressed="baseline"
          data-testid="sprite-baseline-toggle"
          @click="baseline = !baseline"
        >
          Baseline
        </button>
      </template>
    </template>
    <ActionMenu v-if="fold > 0" label="More" test-id="sprite-view-more">
      <button
        v-if="fold > 1"
        type="button"
        role="menuitemcheckbox"
        :aria-checked="sheet"
        data-testid="sprite-more-sheet"
        @click="sheet = !sheet"
      >
        <UiIcon name="check" :size="16" class="sprite-more__check" />Contact sheet
      </button>
      <template v-if="!sheet">
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="grid"
          data-testid="sprite-more-grid"
          @click="grid = !grid"
        >
          <UiIcon name="check" :size="16" class="sprite-more__check" />Grid
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="baseline"
          data-testid="sprite-more-baseline"
          @click="baseline = !baseline"
        >
          <UiIcon name="check" :size="16" class="sprite-more__check" />Baseline
        </button>
      </template>
      <div role="separator"></div>
      <div
        role="group"
        aria-labelledby="sprite-more-backdrop"
        title="Only while drawing: the view's transparent colour stays as it is"
      >
        <p id="sprite-more-backdrop" class="sprite-more__heading">Backdrop</p>
        <button
          v-for="choice in CHECKERS"
          :key="choice.key"
          type="button"
          role="menuitemradio"
          :aria-checked="backdropValue === choice.key"
          @click="backdropValue = choice.key"
        >
          <UiIcon name="check" :size="16" class="sprite-more__check" />{{ choice.label }}
        </button>
        <button
          v-if="roomBackdrop !== null"
          type="button"
          role="menuitemradio"
          :aria-checked="backdropValue === 'room'"
          @click="backdropValue = 'room'"
        >
          <UiIcon name="check" :size="16" class="sprite-more__check" />Room {{ roomBackdrop }}
        </button>
        <div class="sprite-more__swatches">
          <button
            v-for="(name, colour) in EGA_COLOUR_NAMES"
            :key="colour"
            type="button"
            role="menuitemradio"
            :aria-checked="backdropValue === `colour-${colour}`"
            :aria-label="`Solid colour ${colour} · ${name}`"
            :title="`${colour} · ${name}`"
            :style="{ background: `var(--agi-${colour})` }"
            @click="backdropValue = `colour-${colour}`"
          ></button>
        </div>
      </div>
    </ActionMenu>
  </div>
</template>

<style scoped>
.sprite-view-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0);
  white-space: nowrap;
}
.sprite-view-bar__toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--control-h);
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  font: var(--weight-bold) var(--text-sm) / 1 var(--font-sans);
  cursor: pointer;
}
.sprite-view-bar__toggle:hover {
  color: var(--ink);
}
.sprite-view-bar__toggle[aria-pressed="true"] {
  color: var(--ink);
  background: var(--surface-3);
}
.sprite-view-bar__toggle:focus-visible,
.sprite-view-bar__depth select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sprite-view-bar__tint {
  width: var(--space-5);
  height: var(--space-2);
  border-radius: var(--radius-pill);
}
.sprite-view-bar__tint.is-prev {
  background: var(--agi-12);
}
.sprite-view-bar__tint.is-next {
  background: var(--agi-11);
}
.sprite-view-bar__backdrop {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-right: var(--space-2);
  color: var(--ink-2);
  font: var(--weight-bold) var(--text-sm) / 1 var(--font-sans);
}
.sprite-view-bar__backdrop select {
  max-width: 9.5rem;
  height: var(--control-h);
  padding: 0 var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-2);
  font: var(--text-sm) var(--font-sans);
}
.sprite-view-bar__backdrop select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sprite-view-bar__depth select {
  height: var(--control-h);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink-2);
  background: var(--surface-2);
  font: var(--text-xs) var(--font-mono);
}
[aria-checked="false"] > .sprite-more__check {
  visibility: hidden;
}
.sprite-more__heading {
  margin: var(--space-2) var(--space-3) var(--space-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
/* The sixteen solid colours as swatches, four to a row: a pressed one is ringed. */
.sprite-more__swatches {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2) var(--space-2);
}
.sprite-more__swatches [role="menuitemradio"] {
  min-height: var(--control-h);
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
}
.sprite-more__swatches [role="menuitemradio"][aria-checked="true"] {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sprite-view-bar__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (pointer: coarse) {
  .sprite-view-bar__toggle,
  .sprite-view-bar__backdrop select,
  .sprite-view-bar__depth select {
    height: var(--control-h-touch);
  }
}
</style>
