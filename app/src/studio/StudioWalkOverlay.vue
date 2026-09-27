<script setup lang="ts">
import { computed, shallowRef, useTemplateRef } from "vue";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import { toLogical, type Viewport } from "../../../src/studio/viewport.ts";
import { maskFillPath } from "./studioView.ts";
import type { StudioTool } from "./studioTools.ts";
import type { StudioWalk } from "./useStudioWalk.ts";
import { edgeAnchor, type WalkDoor } from "./walkView.ts";

/**
 * The Walk view over one picture pane: the walkable tint (an estimate), the
 * room's doors (boxes on the floor, arrows on the edges, each labelled with
 * where it leads), the door box being drawn, and a test walk's start, goal,
 * estimated path and the spot where the engine's walk ended. Doors take the
 * pointer with the Select and walk tools: Select picks a door and drags its
 * box; the test walk tool starts where the player comes in through it, or,
 * with a start already set, walks through it as the goal: to the floor in
 * its box, or to its edge and one step across. A
 * selected door box that can follow the art has a link handle at its lower
 * right corner: drag it onto a picture item and the box follows that item.
 */
const {
  walk,
  viewport,
  tool,
  tint = true,
  itemAt,
  itemLabel,
} = defineProps<{
  walk: StudioWalk;
  viewport: Viewport;
  tool: StudioTool;
  /** Show where the player can stand. */
  tint?: boolean;
  /** The picture item drawn at a cell (the art first): what a link drop binds. */
  itemAt: (x: number, y: number) => string | undefined;
  itemLabel: (id: string) => string;
}>();
/** `hover-item`: the item a link drag is over, for the canvas highlight. */
const emit = defineEmits<{ "hover-item": [id: string | undefined] }>();

const root = useTemplateRef("root");
const unit = computed(() => 1 / viewport.zoom);
const tintPath = computed(() => (tint ? maskFillPath(walk.mask.value) : ""));
/** Doors take presses only with these tools; drawing tools reach the picture. */
const live = computed(() => ["select", "walk", "door", "edge"].includes(tool));

const ARROW = 5;
function arrowPoints(door: WalkDoor): string {
  const at = edgeAnchor(door.edge!, walk.horizon.value);
  const w = ARROW;
  const h = ARROW * 2;
  switch (door.edge!) {
    case "left":
      return `0,${at.y + 0.5} ${w},${at.y + 0.5 - h / 2} ${w},${at.y + 0.5 + h / 2}`;
    case "right":
      return `${SCREEN_WIDTH},${at.y + 0.5} ${SCREEN_WIDTH - w},${at.y + 0.5 - h / 2} ${SCREEN_WIDTH - w},${at.y + 0.5 + h / 2}`;
    case "top":
      return `${at.x},${at.y} ${at.x - w},${at.y + h} ${at.x + w},${at.y + h}`;
    case "bottom":
      return `${at.x},${SCREEN_HEIGHT} ${at.x - w},${SCREEN_HEIGHT - h} ${at.x + w},${SCREEN_HEIGHT - h}`;
  }
}
/** Where a door's "→ Room" label sits and how it anchors. */
function labelAt(door: WalkDoor): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  if (door.box)
    return { x: (door.box.x1 + door.box.x2 + 1) / 2, y: door.box.y1 - 1, anchor: "middle" };
  const at = edgeAnchor(door.edge!, walk.horizon.value);
  switch (door.edge!) {
    case "left":
      return { x: ARROW + 1, y: at.y + 3, anchor: "start" };
    case "right":
      return { x: SCREEN_WIDTH - ARROW - 1, y: at.y + 3, anchor: "end" };
    case "top":
      return { x: at.x, y: at.y + ARROW * 2 + 8, anchor: "middle" };
    case "bottom":
      return { x: at.x, y: SCREEN_HEIGHT - ARROW * 2 - 2, anchor: "middle" };
  }
}
const shownDoors = computed(() =>
  walk.doors.value.filter((door) => door.box !== null || (door.shape === "edge" && door.edge)),
);

/** An ego-sized box standing on baseline point `p`. */
function egoBox(p: Point) {
  const ego = walk.walkInput.value;
  return { x: p.x, y: p.y - ego.egoHeight + 1, width: ego.egoWidth, height: ego.egoHeight };
}
const estimatePoints = computed(
  () => walk.estimate.value?.path?.map((p) => `${p.x + 0.5},${p.y + 0.5}`).join(" ") ?? "",
);
const ended = computed(() => walk.result.value?.result ?? null);

function cellOf(event: PointerEvent): Point {
  const rect = root.value!.getBoundingClientRect();
  return toLogical(viewport, event.clientX - rect.left, event.clientY - rect.top, { clamp: true })!;
}

/** A drag in progress: a door box moving, or a door's link handle. */
let dragging: "box" | "link" | null = null;
const link = shallowRef<{ id: string; at: Point; item: string | undefined } | null>(null);

function onDoorDown(event: PointerEvent, door: WalkDoor): void {
  if (event.button !== 0 || !live.value) return;
  event.stopPropagation();
  event.preventDefault();
  const cell = cellOf(event);
  if (tool === "walk") {
    // A walk waiting for its goal walks into the door; otherwise the door
    // starts one where the player comes in through it.
    if (walk.start.value && !walk.goal.value) walk.walkTo(cell, door.id);
    else walk.startFromDoor(door.id);
    return;
  }
  walk.grabDoor(door.id, cell);
  if (door.box && door.editable && walk.canEditDoors.value) {
    dragging = "box";
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }
}
function onLinkDown(event: PointerEvent, door: WalkDoor): void {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();
  dragging = "link";
  link.value = { id: door.id, at: cellOf(event), item: undefined };
  (event.currentTarget as Element).setPointerCapture(event.pointerId);
}
function onMove(event: PointerEvent): void {
  if (dragging === "box") walk.dragDoor(cellOf(event));
  else if (dragging === "link" && link.value) {
    const at = cellOf(event);
    const item = itemAt(at.x, at.y);
    link.value = { ...link.value, at, item };
    emit("hover-item", item);
  }
}
function onUp(): void {
  if (dragging === "box") walk.dropDoor();
  else if (dragging === "link" && link.value) {
    const { id, item } = link.value;
    link.value = null;
    emit("hover-item", undefined);
    if (item) walk.setFollows(id, item);
  }
  dragging = null;
}
function onLost(): void {
  if (dragging === "box") walk.cancel();
  link.value = null;
  emit("hover-item", undefined);
  dragging = null;
}
const selected = computed(() => walk.selectedDoor.value);
</script>

<template>
  <svg
    ref="root"
    class="walk-overlay"
    :viewBox="`0 0 ${SCREEN_WIDTH} ${SCREEN_HEIGHT}`"
    preserveAspectRatio="none"
    data-role="walk-overlay"
    aria-hidden="true"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onLost"
    @lostpointercapture="onLost"
  >
    <path v-if="tintPath" class="walk-overlay__tint" data-role="walkable-tint" :d="tintPath" />

    <g
      v-for="door in shownDoors"
      :key="door.id"
      class="walk-overlay__door"
      :class="{
        'is-native': !door.editable,
        'is-planned': door.planned,
        'is-selected': selected?.id === door.id,
        'is-live': live,
      }"
      data-role="door"
      :data-door="door.id"
      :data-destination="door.destination"
      @pointerdown="onDoorDown($event, door)"
    >
      <rect
        v-if="door.box"
        class="walk-overlay__box"
        :x="door.box.x1"
        :y="door.box.y1"
        :width="door.box.x2 - door.box.x1 + 1"
        :height="door.box.y2 - door.box.y1 + 1"
        vector-effect="non-scaling-stroke"
      />
      <polygon
        v-else
        class="walk-overlay__arrow"
        :points="arrowPoints(door)"
        vector-effect="non-scaling-stroke"
      />
      <text
        class="walk-overlay__label"
        :text-anchor="labelAt(door).anchor"
        :font-size="11 * unit"
        :transform="`translate(${labelAt(door).x} ${labelAt(door).y}) scale(0.5 1)`"
      >
        {{ walk.labelOf(door) }}
      </text>
    </g>

    <g v-if="selected?.box && selected.editable && walk.canEditDoors.value" data-role="door-link">
      <line
        v-if="link"
        class="walk-overlay__link-line"
        :x1="(selected.box.x1 + selected.box.x2 + 1) / 2"
        :y1="(selected.box.y1 + selected.box.y2 + 1) / 2"
        :x2="link.at.x + 0.5"
        :y2="link.at.y + 0.5"
        vector-effect="non-scaling-stroke"
      />
      <ellipse
        class="walk-overlay__link"
        data-role="door-link-handle"
        :cx="selected.box.x2 + 1"
        :cy="selected.box.y2 + 1"
        :rx="5 * unit"
        :ry="10 * unit"
        vector-effect="non-scaling-stroke"
        @pointerdown="onLinkDown($event, selected)"
      />
      <text
        v-if="link"
        class="walk-overlay__label"
        :font-size="11 * unit"
        :transform="`translate(${link.at.x + 2} ${link.at.y - 2}) scale(0.5 1)`"
      >
        {{ link.item ? `Follows: ${itemLabel(link.item)}` : "Drop on the art to follow it" }}
      </text>
    </g>

    <rect
      v-if="walk.drawnBox.value"
      class="walk-overlay__drawn"
      data-role="door-draft"
      :x="walk.drawnBox.value.x1"
      :y="walk.drawnBox.value.y1"
      :width="walk.drawnBox.value.x2 - walk.drawnBox.value.x1 + 1"
      :height="walk.drawnBox.value.y2 - walk.drawnBox.value.y1 + 1"
      vector-effect="non-scaling-stroke"
    />

    <g data-role="test-walk">
      <polyline
        v-if="estimatePoints && !ended"
        class="walk-overlay__estimate"
        data-role="walk-estimate"
        :points="estimatePoints"
        vector-effect="non-scaling-stroke"
      />
      <rect
        v-if="walk.start.value"
        class="walk-overlay__ego is-start"
        data-role="walk-start"
        v-bind="egoBox(walk.start.value)"
        vector-effect="non-scaling-stroke"
      />
      <g v-if="walk.goal.value" data-role="walk-goal" class="walk-overlay__goal">
        <path
          :d="`M${walk.goal.value.x - 2} ${walk.goal.value.y - 4}l5 9M${walk.goal.value.x + 3} ${walk.goal.value.y - 4}l-5 9`"
          vector-effect="non-scaling-stroke"
        />
      </g>
      <template v-if="ended">
        <line
          v-if="walk.result.value"
          class="walk-overlay__trail"
          :x1="walk.result.value.from.x + 0.5"
          :y1="walk.result.value.from.y + 0.5"
          :x2="ended.end.x + 0.5"
          :y2="ended.end.y + 0.5"
          vector-effect="non-scaling-stroke"
        />
        <rect
          class="walk-overlay__ego is-end"
          :class="`is-${ended.outcome}`"
          data-role="walk-end"
          :data-x="ended.end.x"
          :data-y="ended.end.y"
          v-bind="egoBox(ended.end)"
          vector-effect="non-scaling-stroke"
        />
      </template>
    </g>
  </svg>
</template>

<style scoped>
.walk-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.walk-overlay__tint {
  fill: var(--ok);
  fill-opacity: 0.22;
}
.walk-overlay__door.is-live {
  pointer-events: all;
  cursor: pointer;
}
.walk-overlay__box {
  fill: var(--action);
  fill-opacity: 0.18;
  stroke: var(--action);
  stroke-width: 2px;
}
.walk-overlay__arrow {
  fill: var(--action);
  stroke: var(--surface-0);
  stroke-width: 1px;
}
.walk-overlay__door.is-native .walk-overlay__box,
.walk-overlay__door.is-native .walk-overlay__arrow {
  fill: var(--ink-3);
  stroke: var(--surface-0);
}
.walk-overlay__door.is-planned .walk-overlay__arrow {
  fill: none;
  stroke: var(--ink-3);
  stroke-dasharray: 2 2;
}
.walk-overlay__door.is-selected .walk-overlay__box,
.walk-overlay__door.is-selected .walk-overlay__arrow {
  stroke: var(--focus);
  stroke-width: 3px;
}
.walk-overlay__label {
  font-family: var(--font-sans);
  font-weight: var(--weight-semibold);
  fill: var(--ink);
  paint-order: stroke;
  stroke: var(--surface-0);
  stroke-width: 3px;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  pointer-events: none;
}
.walk-overlay__link {
  fill: var(--surface-0);
  stroke: var(--action);
  stroke-width: 2px;
  pointer-events: all;
  cursor: grab;
}
.walk-overlay__link-line {
  stroke: var(--action);
  stroke-width: 1.5px;
  stroke-dasharray: 3 2;
}
.walk-overlay__drawn {
  fill: var(--action);
  fill-opacity: 0.12;
  stroke: var(--action);
  stroke-width: 1px;
  stroke-dasharray: 3 2;
}
.walk-overlay__estimate {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1.5px;
  stroke-dasharray: 4 3;
  opacity: 0.8;
}
.walk-overlay__trail {
  stroke: var(--ink-2);
  stroke-width: 1px;
  stroke-dasharray: 1 3;
}
.walk-overlay__ego {
  fill: none;
  stroke-width: 2px;
}
.walk-overlay__ego.is-start {
  stroke: var(--ink);
  stroke-dasharray: 2 1;
}
.walk-overlay__ego.is-end {
  fill: var(--warn);
  fill-opacity: 0.5;
  stroke: var(--warn);
}
.walk-overlay__ego.is-end.is-reached {
  fill: var(--ok);
  stroke: var(--ok);
}
.walk-overlay__goal path {
  fill: none;
  stroke: var(--danger);
  stroke-width: 2px;
}
</style>
