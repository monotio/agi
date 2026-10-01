<script setup lang="ts">
import { computed, nextTick, onWatcherCleanup, ref, useTemplateRef, watch } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { IconName } from "../ui/icons.ts";
import StudioCurrentValues from "./StudioCurrentValues.vue";
import type { LensUnlocks } from "./studioLocks.ts";
import { TOOL_SHORTCUTS, type CurrentValues, type StudioTool } from "./studioTools.ts";
import type { StudioLens } from "./studioView.ts";

/**
 * The tool rail on the canvas's left edge: select and point, the drawing
 * tools, the pipette, in the Walk view the test walk and door tools, the
 * actor probe and the hand, each with its key, and under them the values
 * new content draws with.
 *
 * The tools scroll inside the rail's column when it is shorter than they are
 * (the Walk lens's three extra tools at 1280×720, any lens on a short
 * screen); the values stay pinned under them, so their pickers are never
 * clipped. An edge where more tools lie beyond it fades and carries a
 * chevron button that scrolls the next tools into view (a short screen's
 * rail shows only a few at a time, and a hidden scrollbar says nothing);
 * the pressed tool (picked by its key) or a focused one is scrolled clear
 * of the fades. The chevrons are for the pointer and never take focus from
 * the canvas: focus reaches every tool.
 */
const {
  frozen,
  probeActive,
  probeAvailable,
  lens,
  unlocks,
  values,
  cursorY = undefined,
  doorsEditable = false,
} = defineProps<{
  /** Drawing is blocked: the drawing tools are disabled. */
  frozen: boolean;
  probeActive: boolean;
  /** The game has VIEWs for the probe to stand. */
  probeAvailable: boolean;
  lens: StudioLens;
  unlocks: LensUnlocks;
  values: CurrentValues;
  cursorY?: number | undefined;
  /** The Walk view can add doors: the room's logic is editable. */
  doorsEditable?: boolean;
}>();
const emit = defineEmits<{
  probe: [];
  values: [patch: Partial<CurrentValues>];
  unlocks: [next: LensUnlocks];
}>();
const tool = defineModel<StudioTool>("tool", { required: true });
interface RailTool {
  readonly id: StudioTool;
  readonly icon: IconName;
  readonly label: string;
  readonly draws?: boolean;
  /** Adds a door: needs the room's editable logic. */
  readonly doors?: boolean;
}
const GROUPS: readonly (readonly RailTool[])[] = [
  [
    { id: "select", icon: "select", label: "Select" },
    { id: "point", icon: "spline", label: "Points" },
  ],
  [
    { id: "line", icon: "line", label: "Line", draws: true },
    { id: "rect", icon: "rect", label: "Rectangle", draws: true },
    { id: "polygon", icon: "polygon", label: "Polygon", draws: true },
    { id: "fill", icon: "fill", label: "Fill", draws: true },
    { id: "brush", icon: "brush", label: "Brush", draws: true },
    { id: "pipette", icon: "pipette", label: "Pipette" },
  ],
];
/** The Walk view's own tools: a test walk the game runs, and the room's doors. */
const WALK_GROUP: readonly RailTool[] = [
  { id: "walk", icon: "footprints", label: "Test walk" },
  { id: "door", icon: "exit", label: "Door box", doors: true },
  { id: "edge", icon: "move", label: "Edge exit", doors: true },
];
const groups = computed(() => (lens === "walk" ? [...GROUPS, WALK_GROUP] : GROUPS));
/** Why a tool is off, on its tooltip; its name and key while it is on. */
const PAUSED = "Drawing pauses while the picture is read-only or an AI proposal is open";
const NEEDS_LOGIC = "Edit this room's scripted exits in Logic Studio or ask the assistant";
const PROBE_NEEDS_VIEWS = "Ghost · G · needs a character in the game";
function toolTitle(entry: RailTool): string {
  if ((entry.draws || entry.doors) && frozen) return PAUSED;
  if (entry.doors && !doorsEditable) return NEEDS_LOGIC;
  return `${entry.label} · ${TOOL_SHORTCUTS[entry.id]}`;
}

const scroller = useTemplateRef("scroller");
/** More tools lie above or below the visible part: that edge fades. */
const more = ref({ above: false, below: false });
function measure(): void {
  const el = scroller.value;
  if (!el) return;
  const above = el.scrollTop > 0;
  const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  if (above !== more.value.above || below !== more.value.below) more.value = { above, below };
}
/** Scroll `button` fully into the column, clear of the fades (the scroll padding). */
function reveal(button: Element | null | undefined): void {
  const el = scroller.value;
  if (!el || !button) return;
  const fade = parseFloat(getComputedStyle(el).scrollPaddingTop) || 0;
  const box = button.getBoundingClientRect();
  const view = el.getBoundingClientRect();
  if (box.top < view.top + fade) el.scrollTop -= view.top + fade - box.top;
  else if (box.bottom > view.bottom - fade) el.scrollTop += box.bottom - (view.bottom - fade);
  measure();
}
/** Scroll the tools a column's height less one tool, so one stays in sight. */
function page(direction: 1 | -1): void {
  const el = scroller.value;
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const step = Math.max(32, el.clientHeight - 48);
  el.scrollBy({ top: direction * step, behavior: reduce ? "auto" : "smooth" });
}
const revealPressed = () => reveal(scroller.value?.querySelector('[aria-pressed="true"]'));
watch([tool, () => probeActive, () => lens], () => void nextTick(revealPressed));
watch(scroller, (el) => {
  if (!el) return;
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  // The tool list changes with the lens: its height is the content to watch.
  if (el.firstElementChild) observer.observe(el.firstElementChild);
  onWatcherCleanup(() => observer.disconnect());
  revealPressed();
});
</script>

<template>
  <aside class="tool-rail" role="toolbar" aria-orientation="vertical" aria-label="Tools">
    <div class="tool-rail__column">
      <div
        ref="scroller"
        class="tool-rail__scroll"
        :class="{ 'is-more-above': more.above, 'is-more-below': more.below }"
        data-testid="studio-rail-tools"
        @scroll.passive="measure"
        @focusin="reveal($event.target as Element)"
      >
        <div class="tool-rail__tools">
          <template v-for="(group, g) in groups" :key="g">
            <span v-if="g > 0" class="tool-rail__sep" aria-hidden="true"></span>
            <div v-for="entry in group" :key="entry.id" class="tool-rail__tool">
              <UiIconButton
                :icon="entry.icon"
                :label="entry.label"
                :shortcut="TOOL_SHORTCUTS[entry.id]"
                :pressed="tool === entry.id"
                :disabled="(entry.draws && frozen) || (entry.doors && (frozen || !doorsEditable))"
                :title="toolTitle(entry)"
                :data-tool="entry.id"
                @click="tool = entry.id"
              />
              <kbd aria-hidden="true">{{ TOOL_SHORTCUTS[entry.id] }}</kbd>
            </div>
          </template>
          <span class="tool-rail__sep" aria-hidden="true"></span>
          <div class="tool-rail__tool">
            <UiIconButton
              icon="actor"
              label="Ghost"
              :shortcut="TOOL_SHORTCUTS.probe"
              :pressed="probeActive"
              :disabled="!probeAvailable"
              :title="probeAvailable ? `Ghost · ${TOOL_SHORTCUTS.probe}` : PROBE_NEEDS_VIEWS"
              data-testid="studio-probe-toggle"
              @click="emit('probe')"
            />
            <kbd aria-hidden="true">{{ TOOL_SHORTCUTS.probe }}</kbd>
          </div>
          <div class="tool-rail__tool">
            <UiIconButton
              icon="hand"
              label="Hand"
              title="Hand · H · or hold Space"
              :shortcut="TOOL_SHORTCUTS.hand"
              :pressed="tool === 'hand'"
              data-tool="hand"
              @click="tool = 'hand'"
            />
            <kbd aria-hidden="true">{{ TOOL_SHORTCUTS.hand }}</kbd>
          </div>
        </div>
      </div>
      <button
        v-show="more.above"
        type="button"
        class="tool-rail__more is-above"
        tabindex="-1"
        aria-hidden="true"
        title="More tools above"
        data-testid="studio-rail-more-above"
        @mousedown.prevent
        @click="page(-1)"
      >
        <UiIcon name="chevron-up" :size="16" />
      </button>
      <button
        v-show="more.below"
        type="button"
        class="tool-rail__more is-below"
        tabindex="-1"
        aria-hidden="true"
        title="More tools below"
        data-testid="studio-rail-more-below"
        @mousedown.prevent
        @click="page(1)"
      >
        <UiIcon name="chevron-down" :size="16" />
      </button>
    </div>
    <span class="tool-rail__spacer"></span>
    <StudioCurrentValues
      :lens
      :unlocks
      :values
      :cursor-y="cursorY"
      @values="emit('values', $event)"
      @unlocks="emit('unlocks', $event)"
    />
  </aside>
</template>

<style scoped>
.tool-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 0;
  padding: 0 0 var(--space-2);
  border-right: 1px solid var(--hairline);
  background: var(--surface-1);
}
/* The tools' column: the scrolling list with its chevrons laid over its edges. */
.tool-rail__column {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  align-self: stretch;
  min-height: 0;
}
.tool-rail__more {
  position: absolute;
  left: 0;
  right: 0;
  display: grid;
  place-items: center;
  height: var(--space-5);
  padding: 0;
  border: 0;
  color: var(--ink-2);
  background: var(--surface-1);
  cursor: pointer;
}
.tool-rail__more:hover {
  color: var(--ink);
  background: var(--surface-2);
}
.tool-rail__more.is-above {
  top: 0;
  border-bottom: 1px solid var(--hairline);
}
.tool-rail__more.is-below {
  bottom: 0;
  border-top: 1px solid var(--hairline);
}
/* The tools take the column's height left over by the values and scroll in
   it, with no scrollbar (a classic one would narrow the 48 px column below a
   tool's width): the wheel, a swipe, focus and the keys reach every tool. */
.tool-rail__scroll {
  --fade: var(--space-5);
  flex: 0 1 auto;
  align-self: stretch;
  min-height: 0;
  overflow: hidden auto;
  overscroll-behavior: contain;
  scroll-padding-block: var(--fade);
  scrollbar-width: none;
  --fade-top: var(--surface-1);
  --fade-bottom: var(--surface-1);
  mask-image: linear-gradient(
    to bottom,
    var(--fade-top),
    var(--surface-1) var(--fade),
    var(--surface-1) calc(100% - var(--fade)),
    var(--fade-bottom)
  );
}
.tool-rail__scroll::-webkit-scrollbar {
  display: none;
}
.tool-rail__scroll.is-more-above {
  --fade-top: transparent;
}
.tool-rail__scroll.is-more-below {
  --fade-bottom: transparent;
}
.tool-rail__spacer {
  flex: 1;
}
.tool-rail__tools {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-0);
  padding: var(--space-2) 0;
}
/* The focus ring sits inside the button: the scrolling column would clip one outside it. */
.tool-rail__tool .ui-icon-btn:focus-visible {
  outline-offset: -3px;
}
.tool-rail__tool {
  position: relative;
}
.tool-rail__tool kbd {
  position: absolute;
  right: 1px;
  bottom: 0;
  color: var(--ink-3);
  font: var(--text-2xs) / 1 var(--font-mono);
  pointer-events: none;
}
.tool-rail__sep {
  width: var(--space-6);
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--hairline);
}
</style>
