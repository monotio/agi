<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  ref,
  useId,
  useTemplateRef,
  watch,
} from "vue";
import UiIcon from "./UiIcon.vue";
import { openExplainer, type HelpTarget } from "./explain.ts";
import { shellBridgeKey } from "../shell/shellBridge.ts";

/**
 * The ⓘ after a label: a small round button that opens one sentence about
 * the thing it follows, in a popover under it (role dialog, clamped to the
 * window): its name, the sentence, an optional action (the `action` slot,
 * handed `close`) and "Learn more ›" into the Help guide at `help`. Click,
 * Enter or Space opens it; a mouse resting on the button for 600 ms opens it
 * too, and leaving button and popover closes it again. One explainer is open
 * at a time. Esc closes it before any other Esc handler runs (a Studio's
 * chain never sees that press) and focus returns to the button; so do Learn
 * more and the action. A click outside or Tab past its last control closes it
 * where focus went. The visible dot is 16 px; the target around it is a full
 * control's height, left out of any measure of what a bar can fit.
 */
const {
  term,
  name,
  says,
  help = undefined,
} = defineProps<{
  /** The registry id: `data-term` and the test id `explain-{term}`. */
  term: string;
  name: string;
  says: string;
  help?: HelpTarget | undefined;
}>();

const bridge = inject(shellBridgeKey, null);
const me = Symbol(term);
const open = computed(() => openExplainer.value === me);
const trigger = useTemplateRef("trigger");
const pop = useTemplateRef("pop");
const popId = useId();
const nameId = useId();
/** Where the popover sits, and its arrow under the button. */
const place = ref<{ left: number; top: number; arrow: number; above: boolean }>();
/** Opened by a resting mouse: it closes when the mouse leaves, unless focus went in. */
let hovered = false;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let anchor: { left: number; top: number } | undefined;

const WIDTH = 280;
const GUTTER = 8;
const GAP = 8;
const HOVER_OPEN_MS = 600;
const HOVER_CLOSE_MS = 200;

async function show(how: "click" | "hover"): Promise<void> {
  clearTimeout(hoverTimer);
  hovered = how === "hover";
  openExplainer.value = me;
  place.value = undefined;
  await nextTick();
  position();
  if (how === "click") pop.value?.focus({ preventScroll: true });
}

function position(): void {
  const button = trigger.value;
  const box = pop.value;
  if (!button || !box || !open.value) return;
  const rect = button.getBoundingClientRect();
  const width = Math.min(WIDTH, window.innerWidth - 2 * GUTTER);
  const height = box.getBoundingClientRect().height;
  const centre = rect.left + rect.width / 2;
  const left = Math.min(Math.max(GUTTER, centre - 28), window.innerWidth - width - GUTTER);
  const below = window.innerHeight - rect.bottom - GAP - GUTTER;
  const above = height > below && rect.top - GAP - GUTTER > below;
  const top = above
    ? Math.max(GUTTER, rect.top - GAP - height)
    : Math.min(rect.bottom + GAP, window.innerHeight - height - GUTTER);
  place.value = { left, top, arrow: centre - left, above };
  anchor = { left: rect.left, top: rect.top };
}

/** Close; `refocus` hands focus back to the button. */
function close(refocus: boolean): void {
  clearTimeout(hoverTimer);
  if (openExplainer.value === me) openExplainer.value = null;
  if (refocus) void nextTick(() => trigger.value?.focus({ preventScroll: true }));
}

function toggle(): void {
  if (open.value && !hovered) close(true);
  else void show("click");
}

function learnMore(): void {
  if (!help) return;
  close(true);
  bridge?.openHelp(help.section, help.topic);
}

function onEnter(event: PointerEvent): void {
  if (event.pointerType !== "mouse") return;
  clearTimeout(hoverTimer);
  if (open.value) return;
  hoverTimer = setTimeout(() => void show("hover"), HOVER_OPEN_MS);
}
function onLeave(event: PointerEvent): void {
  if (event.pointerType !== "mouse") return;
  clearTimeout(hoverTimer);
  if (!open.value || !hovered) return;
  hoverTimer = setTimeout(() => {
    if (!pop.value?.contains(document.activeElement)) close(false);
  }, HOVER_CLOSE_MS);
}

/** Esc, wherever focus is, closes the popover first and stops there: no other Esc runs. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  event.preventDefault();
  // Opened by a resting mouse, focus stayed where it was (the canvas): it stays there.
  const active = document.activeElement;
  close(!hovered || active === trigger.value || !!pop.value?.contains(active));
}
function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!trigger.value?.contains(target) && !pop.value?.contains(target)) close(false);
}
/** Tab past the last control (or Shift+Tab before the first) leaves and closes it. */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && (pop.value?.contains(next) || trigger.value?.contains(next))) return;
  if (next !== null) close(false);
}
function onScroll(event: Event): void {
  if (event.target instanceof Node && pop.value?.contains(event.target)) return;
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect || !anchor) return;
  if (Math.abs(rect.left - anchor.left) > 0.5 || Math.abs(rect.top - anchor.top) > 0.5)
    close(false);
}
function onResize(): void {
  close(false);
}

function listen(on: boolean): void {
  if (on) {
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return;
  }
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("pointerdown", onPointerDown, true);
  window.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
}
watch(open, listen);
onBeforeUnmount(() => {
  close(false);
  listen(false);
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="ui-explain"
    :class="{ 'is-open': open }"
    :aria-label="`What is ${name}?`"
    :aria-expanded="open"
    :aria-controls="open ? popId : undefined"
    aria-haspopup="dialog"
    :data-testid="`explain-${term}`"
    :data-term="term"
    @click.stop="toggle"
    @pointerenter="onEnter"
    @pointerleave="onLeave"
  >
    <UiIcon name="info" :size="12" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      :id="popId"
      ref="pop"
      class="ui-explain__pop"
      :class="{ 'is-placed': place, 'is-above': place?.above }"
      role="dialog"
      :aria-labelledby="nameId"
      tabindex="-1"
      data-testid="explain-pop"
      :data-term="term"
      :style="
        place
          ? { left: `${place.left}px`, top: `${place.top}px`, '--arrow': `${place.arrow}px` }
          : undefined
      "
      @pointerenter="onEnter"
      @pointerleave="onLeave"
      @focusout="onFocusOut"
    >
      <h4 :id="nameId" class="ui-explain__name">{{ name }}</h4>
      <p class="ui-explain__says" data-testid="explain-says">{{ says }}</p>
      <div v-if="$slots['action'] || (help && bridge)" class="ui-explain__row">
        <slot name="action" :close="() => close(true)" />
        <button
          v-if="help && bridge"
          type="button"
          class="ui-explain__more"
          data-testid="explain-more"
          @click="learnMore"
        >
          Learn more ›
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ui-explain {
  position: relative;
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--ink-3);
  background: transparent;
  vertical-align: middle;
  cursor: help;
  transition: color var(--duration-fast) var(--ease-out);
}
/* The target a pointer can hit is a full control around the 16 px dot; a bar
   measuring what it can fit sets --explain-target to 0 (explain.ts). */
.ui-explain::after {
  content: "";
  position: absolute;
  inset: calc((16px - var(--control-h)) / 2 * var(--explain-target, 1));
  border-radius: 50%;
}
@media (pointer: coarse) {
  .ui-explain::after {
    inset: calc((16px - var(--control-h-touch)) / 2 * var(--explain-target, 1));
  }
}
.ui-explain:hover,
.ui-explain:focus-visible,
.ui-explain.is-open {
  color: var(--action);
}
.ui-explain:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.ui-explain__pop {
  position: fixed;
  z-index: var(--z-popover);
  box-sizing: border-box;
  width: min(280px, calc(100vw - 16px));
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font: var(--text-sm) / var(--leading) var(--font-sans);
  text-align: left;
  text-transform: none;
  letter-spacing: normal;
  white-space: normal;
  visibility: hidden;
  outline: 0;
}
.ui-explain__pop.is-placed {
  visibility: visible;
  animation: ui-menu-in var(--duration-fast) var(--ease-out);
}
@media (prefers-reduced-motion: reduce) {
  .ui-explain__pop.is-placed {
    animation: none;
  }
}
.ui-explain__pop::before {
  content: "";
  position: absolute;
  top: -6px;
  left: calc(var(--arrow, 28px) - 5px);
  width: 10px;
  height: 10px;
  border-top: 1px solid var(--hairline-strong);
  border-left: 1px solid var(--hairline-strong);
  background: var(--surface-overlay);
  transform: rotate(45deg);
}
.ui-explain__pop.is-above::before {
  top: auto;
  bottom: -6px;
  transform: rotate(225deg);
}
.ui-explain__name {
  margin: 0 0 var(--space-2);
  color: var(--ink);
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
}
.ui-explain__says {
  margin: 0;
  color: var(--ink-2);
}
.ui-explain__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.ui-explain__more {
  min-height: var(--control-h);
  margin-left: auto;
  padding: 0 var(--space-1);
  border: 0;
  color: var(--action);
  background: none;
  font: var(--text-xs) var(--font-sans);
  cursor: pointer;
}
.ui-explain__more:hover {
  text-decoration: underline;
}
.ui-explain__more:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
@media (pointer: coarse) {
  .ui-explain__more {
    min-height: var(--control-h-touch);
  }
}
</style>
