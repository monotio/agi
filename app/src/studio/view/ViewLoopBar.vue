<script setup lang="ts">
import { numberedLabel } from "../../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "../../shell/useProjectLabels.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from "vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiExplain from "../../ui/UiExplain.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { explain } from "../studioTerms.ts";
import { backgroundKey, parseBackground, type CelBackground } from "./viewStudioView.ts";

/**
 * The canvas's view toggles, docked at the right of the options bar: the
 * background behind transparent pixels, onion skins (one Onion menu: the cels
 * before and after, and how many of each, 1 to 3), the grid, the baseline
 * where the feet stand, and All cels, every cel in place of the canvas. None
 * of them changes the view: the background shows only while drawing, and the
 * view's transparent colour stays as it is.
 *
 * A narrow options bar folds the least used of them into a More menu
 * (`fold`: 1 the grid, the baseline and All cels; 2 the background too); the
 * Onion menu stays in the bar.
 */
const { roomBackground = null, fold = 0 } = defineProps<{
  /** The room a Room background shows, when a room uses the view. */
  roomBackground?: number | null;
  /** How many groups are folded into More: 0 none, 1 grid, baseline and All cels, 2 the background too. */
  fold?: number;
}>();
const sheet = defineModel<boolean>("sheet", { required: true });
const prev = defineModel<boolean>("prev", { required: true });
const next = defineModel<boolean>("next", { required: true });
const depth = defineModel<number>("depth", { required: true });
const grid = defineModel<boolean>("grid", { required: true });
const baseline = defineModel<boolean>("baseline", { required: true });
const background = defineModel<CelBackground>("background", { required: true });
const labels = useProjectLabels();
const backgroundValue = computed({
  get: () => backgroundKey(background.value),
  set: (value: string) => (background.value = parseBackground(value)),
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
  <div class="view-view-bar" role="group" aria-label="Canvas view">
    <span v-if="fold < 2" class="view-view-bar__background">
      <label for="view-background-select">Background</label>
      <UiExplain v-bind="explain('background')" />
      <select id="view-background-select" v-model="backgroundValue" data-testid="view-background">
        <option value="checker-dark">Dark checker</option>
        <option value="checker-light">Light checker</option>
        <option v-if="roomBackground !== null" value="room">
          {{ numberedLabel("room", roomBackground!, labels, "option") }}
        </option>
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
    <span v-if="!sheet" class="view-view-bar__onion" @keydown="onOnionKey">
      <button
        ref="onionButton"
        type="button"
        class="view-view-bar__toggle"
        :class="{ 'is-on': prev || next }"
        :aria-expanded="onionOpen"
        :aria-controls="onionOpen ? onionId : undefined"
        aria-haspopup="dialog"
        :title="VOCABULARY.onionSkin.help"
        data-testid="view-onion"
        @click="onionOpen = !onionOpen"
      >
        {{ VOCABULARY.onionSkin.label }}<UiIcon name="chevron-down" :size="14" />
      </button>
      <div
        v-if="onionOpen"
        :id="onionId"
        ref="onionPop"
        class="view-view-bar__pop"
        role="dialog"
        aria-label="Onion skin"
        data-testid="view-onion-menu"
      >
        <p class="view-view-bar__pop-head">Onion skin <UiExplain v-bind="explain('onion')" /></p>
        <label class="view-view-bar__check">
          <input v-model="prev" type="checkbox" data-testid="view-onion-prev" />
          <i class="view-view-bar__tint is-prev" aria-hidden="true"></i>Before
        </label>
        <label class="view-view-bar__check">
          <input v-model="next" type="checkbox" data-testid="view-onion-next" />
          <i class="view-view-bar__tint is-next" aria-hidden="true"></i>After
        </label>
        <div class="view-view-bar__depth">
          <span>Cels</span>
          <UiSegmented v-model="depthText" size="sm" label="Onion skin cels" :options="DEPTHS" />
        </div>
      </div>
    </span>
    <template v-if="fold < 1">
      <button
        v-if="!sheet"
        type="button"
        class="view-view-bar__toggle"
        :aria-pressed="grid"
        data-testid="view-grid"
        @click="grid = !grid"
      >
        Grid
      </button>
      <span v-if="!sheet" class="view-view-bar__with-explain">
        <button
          type="button"
          class="view-view-bar__toggle"
          :aria-pressed="baseline"
          @click="baseline = !baseline"
        >
          Feet
        </button>
        <UiExplain v-bind="explain('feet')" />
      </span>
      <button
        type="button"
        class="view-view-bar__toggle"
        :aria-pressed="sheet"
        data-testid="view-sheet-toggle"
        @click="sheet = !sheet"
      >
        All cels
      </button>
    </template>
    <ActionMenu v-if="fold > 0" label="More" test-id="actor-view-more">
      <template v-if="!sheet">
        <button type="button" role="menuitemcheckbox" :aria-checked="grid" @click="grid = !grid">
          <UiIcon name="check" :size="16" class="view-more__check" />Grid
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          :aria-checked="baseline"
          @click="baseline = !baseline"
        >
          <UiIcon name="check" :size="16" class="view-more__check" />Feet
        </button>
      </template>
      <button type="button" role="menuitemcheckbox" :aria-checked="sheet" @click="sheet = !sheet">
        <UiIcon name="check" :size="16" class="view-more__check" />All cels
      </button>
      <template v-if="fold > 1">
        <div role="separator"></div>
        <div role="group" aria-labelledby="view-more-background">
          <p id="view-more-background" class="view-more__heading">Background</p>
          <button
            v-for="choice in CHECKERS"
            :key="choice.key"
            type="button"
            role="menuitemradio"
            :aria-checked="backgroundValue === choice.key"
            @click="backgroundValue = choice.key"
          >
            <UiIcon name="check" :size="16" class="view-more__check" />{{ choice.label }}
          </button>
          <button
            v-if="roomBackground !== null"
            type="button"
            role="menuitemradio"
            :aria-checked="backgroundValue === 'room'"
            @click="backgroundValue = 'room'"
          >
            <UiIcon name="check" :size="16" class="view-more__check" />{{
              numberedLabel("room", roomBackground!, labels, "option")
            }}
          </button>
          <div class="view-more__swatches">
            <button
              v-for="(name, colour) in EGA_COLOUR_NAMES"
              :key="colour"
              type="button"
              role="menuitemradio"
              :aria-checked="backgroundValue === `colour-${colour}`"
              :aria-label="`Solid colour ${colour} · ${name}`"
              :title="`${colour} · ${name}`"
              :style="{ background: `var(--agi-${colour})` }"
              @click="backgroundValue = `colour-${colour}`"
            ></button>
          </div>
        </div>
      </template>
    </ActionMenu>
  </div>
</template>

<style scoped>
.view-view-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-0);
  white-space: nowrap;
}
.view-view-bar__toggle {
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
.view-view-bar__toggle:hover {
  color: var(--ink);
}
.view-view-bar__toggle.is-on {
  color: var(--ink);
}
.view-view-bar__with-explain,
.view-view-bar__onion {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.view-view-bar__with-explain {
  margin-right: var(--space-2);
}
.view-view-bar__pop {
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
.view-view-bar__pop-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.view-view-bar__check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--control-h);
  cursor: pointer;
}
.view-view-bar__check input {
  width: var(--space-5);
  height: var(--space-5);
  margin: 0;
  accent-color: var(--action);
}
.view-view-bar__check input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.view-view-bar__depth {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--control-h);
  color: var(--ink-2);
}
.view-view-bar__toggle[aria-pressed="true"] {
  color: var(--ink);
  background: var(--surface-3);
}
.view-view-bar__toggle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.view-view-bar__tint {
  width: var(--space-5);
  height: var(--space-2);
  border-radius: var(--radius-pill);
}
.view-view-bar__tint.is-prev {
  background: var(--agi-12);
}
.view-view-bar__tint.is-next {
  background: var(--agi-11);
}
.view-view-bar__background {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-right: var(--space-2);
  color: var(--ink-2);
  font: var(--weight-bold) var(--text-sm) / 1 var(--font-sans);
}
.view-view-bar__background select {
  max-width: 9.5rem;
  height: var(--control-h);
  padding: 0 var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-2);
  font: var(--text-sm) var(--font-sans);
}
.view-view-bar__background select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
[aria-checked="false"] > .view-more__check {
  visibility: hidden;
}
.view-more__heading {
  margin: var(--space-2) var(--space-3) var(--space-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
/* The sixteen solid colours as swatches, four to a row: a pressed one is ringed. */
.view-more__swatches {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2) var(--space-2);
}
.view-more__swatches [role="menuitemradio"] {
  min-height: var(--control-h);
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
}
.view-more__swatches [role="menuitemradio"][aria-checked="true"] {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
@media (pointer: coarse) {
  .view-view-bar__toggle,
  .view-view-bar__background select {
    height: var(--control-h-touch);
  }
  .view-view-bar__check,
  .view-view-bar__depth {
    min-height: var(--control-h-touch);
  }
}
</style>
