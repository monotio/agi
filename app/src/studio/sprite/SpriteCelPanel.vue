<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiDisclosure from "../../ui/UiDisclosure.vue";
import UiExplain from "../../ui/UiExplain.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import {
  MAX_CEL_HEIGHT,
  MAX_CEL_WIDTH,
  RESIZE_ANCHORS,
  resizeCel,
  type ResizeAnchor,
} from "../../../../src/studio/sprite/spriteCels.ts";
import type { SpriteCel } from "../../../../src/view/spriteDocument.ts";
import { EGA_COLOUR_NAMES } from "../../../../src/studio/sceneGroups.ts";
import { explain } from "../studioTerms.ts";
import { feetOf, feetWarning } from "./spriteView.ts";

/** A cel edit the panel asks for; the studio adds which cel and how it propagates. */
export type CelEdit =
  | {
      readonly type: "resizeCel";
      readonly width: number;
      readonly height: number;
      readonly anchor: ResizeAnchor;
    }
  | { readonly type: "shiftCel"; readonly dx: number; readonly dy: number }
  | { readonly type: "setTransparent"; readonly color: number; readonly remap?: number };

/**
 * The edited cel: "Cel 0 · Loop 0" and its size, the mirror chip in the
 * default slot, then one Details disclosure (closed at first, remembered per
 * viewer) with the expert parts as flat rows: resizing with an anchor picker
 * (bottom-centre keeps the feet on the baseline) and a warning before a
 * resize moves the feet; shifting the pixels, which wraps around the edges;
 * the transparent colour; the mirror bit; and where the feet stand. Esc in a
 * size field puts back the cel's size (spriteKeys.ts then leaves the field,
 * not Studio). `chooseTransparent` opens Details at the transparent colour.
 */
const { cel, loop, index, frozen } = defineProps<{
  cel: SpriteCel;
  loop: number;
  index: number;
  frozen: boolean;
}>();
const emit = defineEmits<{ edit: [edit: CelEdit] }>();

const width = ref(cel.width);
const height = ref(cel.height);
const anchor = ref<ResizeAnchor>("bottom-center");
const transparent = ref(cel.transparent);
const remap = ref<number | undefined>();
function revertSize(): void {
  width.value = cel.width;
  height.value = cel.height;
}
watch(
  () => cel,
  (next, old) => {
    if (next.width !== old?.width || next.height !== old?.height) {
      width.value = next.width;
      height.value = next.height;
    }
    transparent.value = next.transparent;
  },
  { immediate: true },
);

const feet = computed(() => {
  const at = feetOf(cel);
  if (!at) return "no opaque pixels";
  return at.lift === 0 ? "on the baseline" : `${at.lift} px above the baseline`;
});
const validSize = computed(
  () =>
    Number.isInteger(width.value) &&
    Number.isInteger(height.value) &&
    width.value >= 1 &&
    width.value <= MAX_CEL_WIDTH &&
    height.value >= 1 &&
    height.value <= MAX_CEL_HEIGHT,
);
const resized = computed(() => width.value !== cel.width || height.value !== cel.height);
/** The warning a resize would earn, before it is applied. */
const resizeWarning = computed(() => {
  if (!validSize.value || !resized.value) return null;
  try {
    return feetWarning(cel, resizeCel(cel, width.value, height.value, anchor.value));
  } catch {
    return null;
  }
});
/** Why the cel's edits are off, on their tooltips. */
const PAUSED = "Editing pauses while the sprite is read-only or an AI proposal is open";
const resizeBlocked = computed(() => {
  if (frozen) return PAUSED;
  if (!validSize.value)
    return `Width 1 to ${MAX_CEL_WIDTH} and height 1 to ${MAX_CEL_HEIGHT}, in whole pixels`;
  return resized.value ? undefined : "Enter a new width or height";
});
/** Opaque pixels already use the colour chosen as transparent: they need another. */
const clash = computed(
  () =>
    transparent.value !== cel.transparent &&
    cel.pixels.some((value) => value === transparent.value),
);
const transparentBlocked = computed(() => {
  if (frozen) return PAUSED;
  if (transparent.value === cel.transparent)
    return `Colour ${cel.transparent} is transparent already`;
  return clash.value && remap.value === undefined ? "Pick the colour its pixels become" : undefined;
});

const ANCHOR_LABELS: Record<ResizeAnchor, string> = {
  "top-left": "Top left",
  "top-center": "Top centre",
  "top-right": "Top right",
  "middle-left": "Middle left",
  "middle-center": "Centre",
  "middle-right": "Middle right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom centre (keeps the feet on the baseline)",
  "bottom-right": "Bottom right",
};

function resize(): void {
  if (validSize.value && resized.value)
    emit("edit", {
      type: "resizeCel",
      width: width.value,
      height: height.value,
      anchor: anchor.value,
    });
}
function applyTransparent(): void {
  if (transparent.value === cel.transparent) return;
  if (clash.value && remap.value === undefined) return;
  emit("edit", {
    type: "setTransparent",
    color: transparent.value,
    ...(clash.value && remap.value !== undefined ? { remap: remap.value } : {}),
  });
}
const details = useTemplateRef("details");
const disclosure = useTemplateRef("disclosure");
/** Open Details (if closed) and focus the transparent colour's picker: the palette's "Choose another…". */
function chooseTransparent(): void {
  const root = details.value;
  if (!root) return;
  disclosure.value?.show();
  void nextTick(() => {
    const select = root.querySelector<HTMLElement>("[data-testid='sprite-transparent-colour']");
    select?.scrollIntoView({ block: "nearest" });
    select?.focus();
  });
}

function onAnchorKey(event: KeyboardEvent, current: ResizeAnchor): void {
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 };
  if (!(event.key in step)) return;
  event.preventDefault();
  const next = RESIZE_ANCHORS.indexOf(current) + step[event.key]!;
  const target = RESIZE_ANCHORS[(next + 9) % 9]!;
  anchor.value = target;
  (event.currentTarget as HTMLElement).parentElement
    ?.querySelector<HTMLElement>(`[data-anchor="${target}"]`)
    ?.focus();
}
defineExpose({ chooseTransparent });
</script>

<template>
  <section class="cel-panel" data-testid="sprite-cel-panel">
    <header class="cel-panel__head">
      <h3 class="cel-panel__title" data-testid="sprite-cel-summary">
        Cel {{ index }} · Loop {{ loop }}
      </h3>
      <span class="cel-panel__size" data-testid="sprite-cel-size"
        >{{ cel.width }} × {{ cel.height }}</span
      >
    </header>
    <slot />
  </section>
  <div ref="details">
    <UiDisclosure
      id="sprite-cel"
      ref="disclosure"
      hint="Resize · Shift · Transparent · Feet"
      storage-key="monotio_agi.studioDetails"
      test-id="sprite-cel-details"
    >
      <div class="cel-panel__rows">
        <section class="cel-panel__row" aria-labelledby="cel-resize-title">
          <h4 id="cel-resize-title">Resize</h4>
          <div class="cel-panel__form">
            <label>
              W
              <input
                v-model.number="width"
                type="number"
                min="1"
                :max="MAX_CEL_WIDTH"
                aria-label="Width in pixels"
                data-testid="sprite-resize-width"
                @keydown.esc="revertSize"
              />
            </label>
            <label>
              H
              <input
                v-model.number="height"
                type="number"
                min="1"
                :max="MAX_CEL_HEIGHT"
                aria-label="Height in pixels"
                @keydown.esc="revertSize"
              />
            </label>
            <div class="cel-panel__anchors" role="radiogroup" aria-label="Resize anchor">
              <button
                v-for="entry in RESIZE_ANCHORS"
                :key="entry"
                type="button"
                role="radio"
                :aria-checked="anchor === entry"
                :aria-label="ANCHOR_LABELS[entry]"
                :title="ANCHOR_LABELS[entry]"
                :tabindex="anchor === entry ? 0 : -1"
                :data-anchor="entry"
                @click="anchor = entry"
                @keydown="onAnchorKey($event, entry)"
              ></button>
            </div>
          </div>
          <p v-if="resizeWarning" class="cel-panel__warn">
            {{ resizeWarning }}
          </p>
          <UiButton
            size="sm"
            :disabled="frozen || !validSize || !resized"
            :title="resizeBlocked"
            @click="resize"
          >
            Resize to {{ width }} × {{ height }}
          </UiButton>
        </section>

        <section class="cel-panel__row" aria-labelledby="cel-shift-title">
          <h4 id="cel-shift-title">Shift <UiExplain v-bind="explain('shift')" /></h4>
          <div class="cel-panel__shift" role="group" aria-label="Shift pixels">
            <UiIconButton
              icon="chevron-left"
              label="Shift left"
              size="sm"
              :disabled="frozen"
              :title="frozen ? PAUSED : 'Shift left'"
              @click="emit('edit', { type: 'shiftCel', dx: -1, dy: 0 })"
            />
            <UiIconButton
              icon="chevron-up"
              label="Shift up"
              size="sm"
              :disabled="frozen"
              :title="frozen ? PAUSED : 'Shift up'"
              @click="emit('edit', { type: 'shiftCel', dx: 0, dy: -1 })"
            />
            <UiIconButton
              icon="chevron-down"
              label="Shift down"
              size="sm"
              :disabled="frozen"
              :title="frozen ? PAUSED : 'Shift down'"
              @click="emit('edit', { type: 'shiftCel', dx: 0, dy: 1 })"
            />
            <UiIconButton
              icon="chevron-right"
              label="Shift right"
              size="sm"
              :disabled="frozen"
              :title="frozen ? PAUSED : 'Shift right'"
              @click="emit('edit', { type: 'shiftCel', dx: 1, dy: 0 })"
            />
          </div>
        </section>

        <section class="cel-panel__row" aria-labelledby="cel-transparent-title">
          <h4 id="cel-transparent-title">
            Transparent colour <UiExplain v-bind="explain('transparent')" />
          </h4>
          <div class="cel-panel__form">
            <label>
              Colour
              <select v-model.number="transparent" data-testid="sprite-transparent-colour">
                <option v-for="(name, value) in EGA_COLOUR_NAMES" :key="value" :value="value">
                  {{ value }} · {{ name }}
                </option>
              </select>
            </label>
            <label v-if="clash">
              Pixels using it become
              <select v-model.number="remap">
                <option
                  v-for="(name, value) in EGA_COLOUR_NAMES"
                  :key="value"
                  :value="value"
                  :disabled="value === transparent"
                >
                  {{ value }} · {{ name }}
                </option>
              </select>
            </label>
          </div>
          <UiButton
            size="sm"
            :disabled="frozen || transparent === cel.transparent || (clash && remap === undefined)"
            :title="transparentBlocked"
            @click="applyTransparent"
          >
            Make {{ transparent }} transparent
          </UiButton>
        </section>

        <dl class="cel-panel__facts">
          <dt>Mirror bit <UiExplain v-bind="explain('mirror-bit')" /></dt>
          <dd>{{ cel.mirrorBit ? "on" : "off" }}{{ cel.mirrored ? " · shown flipped" : "" }}</dd>
          <dt>Feet <UiExplain v-bind="explain('feet')" /></dt>
          <dd data-testid="sprite-feet">{{ feet }}</dd>
        </dl>
      </div>
    </UiDisclosure>
  </div>
</template>

<style scoped>
.cel-panel {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.cel-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.cel-panel__title {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.cel-panel__size {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.cel-panel__rows {
  display: grid;
  gap: var(--space-4);
  padding: 0 var(--space-5) var(--space-4);
  font-size: var(--text-xs);
}
.cel-panel__row {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.cel-panel__row h4,
.cel-panel__facts dt {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--ink-2);
  font: var(--weight-semibold) var(--text-xs) / var(--leading) var(--font-sans);
}
.cel-panel__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: var(--space-1) var(--space-5);
  margin: 0;
}
.cel-panel__facts dd {
  margin: 0;
  font-family: var(--font-mono);
}
.cel-panel__form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}
.cel-panel__form label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-2);
}
.cel-panel__form input {
  width: 4.5em;
}
.cel-panel__form input,
.cel-panel__form select {
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-2);
  font: var(--text-xs) var(--font-mono);
}
.cel-panel__anchors {
  display: grid;
  grid-template-columns: repeat(3, var(--space-4));
  gap: 2px;
}
.cel-panel__anchors button {
  width: var(--space-4);
  height: var(--space-4);
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  cursor: pointer;
}
.cel-panel__anchors button[aria-checked="true"] {
  border-color: var(--action);
  background: var(--action);
}
.cel-panel__anchors button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.cel-panel__warn {
  margin: 0;
  color: var(--warn);
}
.cel-panel__shift {
  display: flex;
  gap: var(--space-1);
}
</style>
