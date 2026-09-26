<script setup lang="ts">
import { computed, nextTick, onWatcherCleanup, ref, useTemplateRef, watch } from "vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { IconName } from "../ui/icons.ts";
import StudioCurrentValues from "./StudioCurrentValues.vue";
import type { LensUnlocks } from "./studioLocks.ts";
import type { CurrentValues, StudioTool } from "./studioTools.ts";
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
 * clipped. An edge fades where more tools lie beyond it, and the pressed
 * tool (picked by its key) or a focused one is scrolled clear of the fades.
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
const emit = defineEmits<{ probe: []; values: [patch: Partial<CurrentValues>] }>();
const tool = defineModel<StudioTool>("tool", { required: true });
interface RailTool {
  readonly id: StudioTool;
  readonly icon: IconName;
  readonly label: string;
  readonly key: string;
  readonly draws?: boolean;
  /** Adds a door: needs the room's editable logic. */
  readonly doors?: boolean;
}
const GROUPS: readonly (readonly RailTool[])[] = [
  [
    { id: "select", icon: "select", label: "Select and move", key: "V" },
    { id: "point", icon: "spline", label: "Points only", key: "A" },
  ],
  [
    { id: "line", icon: "line", label: "Line", key: "L", draws: true },
    { id: "rect", icon: "rect", label: "Rectangle", key: "R", draws: true },
    { id: "polygon", icon: "polygon", label: "Polygon", key: "P", draws: true },
    { id: "fill", icon: "fill", label: "Fill", key: "F", draws: true },
    { id: "brush", icon: "brush", label: "Brush", key: "B", draws: true },
    { id: "pipette", icon: "pipette", label: "Pick colour and priority", key: "I" },
  ],
];
/** The Walk view's own tools: a test walk the game runs, and the room's doors. */
const WALK_GROUP: readonly RailTool[] = [
  { id: "walk", icon: "footprints", label: "Test walk", key: "T" },
  { id: "door", icon: "exit", label: "Door box", key: "D", doors: true },
  { id: "edge", icon: "move", label: "Edge exit", key: "E", doors: true },
];
const groups = computed(() => (lens === "walk" ? [...GROUPS, WALK_GROUP] : GROUPS));

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
              :shortcut="entry.key"
              :pressed="tool === entry.id"
              :disabled="(entry.draws && frozen) || (entry.doors && (frozen || !doorsEditable))"
              :data-tool="entry.id"
              @click="tool = entry.id"
            />
            <kbd aria-hidden="true">{{ entry.key }}</kbd>
          </div>
        </template>
        <span class="tool-rail__sep" aria-hidden="true"></span>
        <div class="tool-rail__tool">
          <UiIconButton
            icon="actor"
            :label="probeAvailable ? 'Actor probe' : 'Actor probe (this game has no VIEWs)'"
            shortcut="G"
            :pressed="probeActive"
            :disabled="!probeAvailable"
            data-testid="studio-probe-toggle"
            @click="emit('probe')"
          />
          <kbd aria-hidden="true">G</kbd>
        </div>
        <div class="tool-rail__tool">
          <UiIconButton
            icon="hand"
            label="Pan (or hold Space)"
            shortcut="H"
            :pressed="tool === 'hand'"
            data-tool="hand"
            @click="tool = 'hand'"
          />
          <kbd aria-hidden="true">H</kbd>
        </div>
      </div>
    </div>
    <span class="tool-rail__spacer"></span>
    <StudioCurrentValues
      :lens
      :unlocks
      :values
      :cursor-y="cursorY"
      @values="emit('values', $event)"
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
