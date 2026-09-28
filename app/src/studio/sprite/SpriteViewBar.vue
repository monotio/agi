<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from "vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiExplain from "../../ui/UiExplain.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { explain } from "../studioTerms.ts";
import { backdropKey, parseBackdrop, type SpriteBackdrop } from "./spriteView.ts";

/**
 * The canvas's view toggles, docked at the right of the options bar: the
 * backdrop behind transparent pixels, onion skins (one Onion menu: the cels
 * before and after, and how many of each, 1 to 3), the grid, the baseline
 * where the feet stand, and All cels, every cel in place of the canvas. None
 * of them changes the view: the backdrop shows only while drawing, and the
 * view's transparent colour stays as it is.
 *
 * A narrow options bar folds the least used of them into a More menu
 * (`fold`: 1 the grid, the baseline and All cels; 2 the backdrop too); the
 * Onion menu stays in the bar.
 */
const { roomBackdrop = null, fold = 0 } = defineProps<{
  /** The room a Room backdrop shows, when a room uses the view. */
  roomBackdrop?: number | null;
  /** How many groups are folded into More: 0 none, 1 grid, baseline and All cels, 2 the backdrop too. */
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

/** The Onion menu: Before, After and how many cels, in a small popover under its button. */
const onionOpen = ref(false);
const onionId = useId();
const onionButton = useTemplateRef("onionButton");
const onionPop = useTemplateRef("onionPop");
const DEPTHS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
] as const;
const depthText = computed({
  get: () => String(depth.value) as "1" | "2" | "3",
  set: (value: "1" | "2" | "3") => (depth.value = Number(value)),
});
function closeOnion(refocus: boolean): void {
  onionOpen.value = false;
  if (refocus) void nextTick(() => onionButton.value?.focus({ preventScroll: true }));
}
/** Esc closes the Onion menu first; Studio's own Esc never sees that press. */
function onOnionKey(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  event.preventDefault();
  closeOnion(true);
}
function onOutside(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (onionButton.value?.contains(target) || onionPop.value?.contains(target)) return;
  // An explainer opened from the menu lives outside it: leave the menu open under it.
  if (target instanceof Element && target.closest(".ui-explain__pop")) return;
  closeOnion(false);
}
watch(onionOpen, (open) => {
  if (open) window.addEventListener("pointerdown", onOutside, true);
  else window.removeEventListener("pointerdown", onOutside, true);
});
watch(sheet, (shown) => {
  if (shown) onionOpen.value = false;
});
onBeforeUnmount(() => window.removeEventListener("pointerdown", onOutside, true));
</script>

<template>
  <div class="sprite-view-bar" role="group" aria-label="Canvas view">
    <span v-if="fold < 2" class="sprite-view-bar__backdrop">
      <label for="sprite-backdrop-select">Backdrop</label>
      <UiExplain v-bind="explain('backdrop')" />
      <select id="sprite-backdrop-select" v-model="backdropValue" data-testid="sprite-backdrop">
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
    </span>
    <span v-if="!sheet" class="sprite-view-bar__onion" @keydown="onOnionKey">
      <button
        ref="onionButton"
        type="button"
        class="sprite-view-bar__toggle"
        :class="{ 'is-on': prev || next }"
        :aria-expanded="onionOpen"
        :aria-controls="onionOpen ? onionId : undefined"
        aria-haspopup="dialog"
        data-testid="sprite-onion"
        @click="onionOpen = !onionOpen"
      >
        Onion<UiIcon name="chevron-down" :size="14" />
      </button>
      <div
        v-if="onionOpen"
        :id="onionId"
        ref="onionPop"
        class="sprite-view-bar__pop"
        role="dialog"
        aria-label="Onion skin"
        data-testid="sprite-onion-menu"
      >
        <p class="sprite-view-bar__pop-head">Onion skin <UiExplain v-bind="explain('onion')" /></p>
        <label class="sprite-view-bar__check">
          <input v-model="prev" type="checkbox" data-testid="sprite-onion-prev" />
          <i class="sprite-view-bar__tint is-prev" aria-hidden="true"></i>Before
        </label>
        <label class="sprite-view-bar__check">
          <input v-model="next" type="checkbox" data-testid="sprite-onion-next" />
          <i class="sprite-view-bar__tint is-next" aria-hidden="true"></i>After
        </label>
        <div class="sprite-view-bar__depth">
          <span>Cels</span>
          <UiSegmented v-model="depthText" size="sm" label="Onion skin cels" :options="DEPTHS" />
        </div>
      </div>
    </span>
    <template v-if="fold < 1">
      <button
        v-if="!sheet"
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="grid"
        data-testid="sprite-grid"
        @click="grid = !grid"
      >
        Grid
      </button>
      <span v-if="!sheet" class="sprite-view-bar__with-explain">
        <button
          type="button"
          class="sprite-view-bar__toggle"
          :aria-pressed="baseline"
          @click="baseline = !baseline"
        >
          Baseline
        </button>
        <UiExplain v-bind="explain('feet')" />
      </span>
      <button
        type="button"
        class="sprite-view-bar__toggle"
        :aria-pressed="sheet"
        data-testid="sprite-sheet-toggle"
        @click="sheet = !sheet"
      >
        All cels
      </button>
    </template>
    <ActionMenu v-if="fold > 0" label="More" test-id="sprite-view-more">
      <template v-if="!sheet">
        <button type="button" role="menuitemcheckbox" :aria-checked="grid" @click="grid = !grid">
          <UiIcon name="check" :size="16" class="sprite-more__check" />Grid
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="baseline"
          @click="baseline = !baseline"
        >
          <UiIcon name="check" :size="16" class="sprite-more__check" />Baseline
        </button>
      </template>
      <button type="button" role="menuitemcheckbox" :aria-checked="sheet" @click="sheet = !sheet">
        <UiIcon name="check" :size="16" class="sprite-more__check" />All cels
      </button>
      <template v-if="fold > 1">
        <div role="separator"></div>
        <div role="group" aria-labelledby="sprite-more-backdrop">
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
      </template>
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
.sprite-view-bar__toggle.is-on {
  color: var(--ink);
}
.sprite-view-bar__with-explain,
.sprite-view-bar__onion {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.sprite-view-bar__with-explain {
  margin-right: var(--space-2);
}
.sprite-view-bar__pop {
  position: absolute;
  z-index: var(--z-popover);
  top: calc(100% + var(--space-2));
  right: 0;
  display: grid;
  gap: var(--space-1);
  width: 220px;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font: var(--text-sm) var(--font-sans);
  white-space: normal;
}
.sprite-view-bar__pop-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.sprite-view-bar__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h);
  cursor: pointer;
}
.sprite-view-bar__check input {
  width: var(--space-5);
  height: var(--space-5);
  margin: 0;
  accent-color: var(--action);
}
.sprite-view-bar__check input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sprite-view-bar__depth {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--control-h);
  color: var(--ink-2);
}
.sprite-view-bar__toggle[aria-pressed="true"] {
  color: var(--ink);
  background: var(--surface-3);
}
.sprite-view-bar__toggle:focus-visible {
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
@media (pointer: coarse) {
  .sprite-view-bar__toggle,
  .sprite-view-bar__backdrop select {
    height: var(--control-h-touch);
  }
  .sprite-view-bar__check,
  .sprite-view-bar__depth {
    min-height: var(--control-h-touch);
  }
}
</style>
