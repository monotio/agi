<script setup lang="ts">
import { computed } from "vue";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
import type { Point } from "../../../src/studio/shapes.ts";
import type { RectCorners } from "./studioTools.ts";

/**
 * What a drawing tool shows over a pane before the kernel has drawn it: the
 * clicked points of a line or polygon with the segment to the cursor (the
 * first point ringed when a click there closes the polygon), the rectangle
 * being dragged, the cells a fill under the cursor would flood, and the
 * keyboard cursor's crosshair on its pixel. The picture's own pixels come
 * from the draft's preview underneath.
 */
const {
  points = [],
  polygon = false,
  cursor = undefined,
  rect = null,
  flood = "",
  crosshair = null,
} = defineProps<{
  points?: readonly Point[];
  polygon?: boolean;
  cursor?: Point | undefined;
  rect?: RectCorners | null;
  /** maskFillPath of the cells a fill would change. */
  flood?: string;
  /** The keyboard cursor's pixel, while the keys drive the canvas. */
  crosshair?: Point | null;
}>();
/** The crosshair's arms reach this many rows past its pixel (half as many columns: pixels are 2:1). */
const ARM = 12;

const centre = (p: Point): string => `${p.x + 0.5},${p.y + 0.5}`;
const trail = computed(() => {
  const all = cursor && points.length > 0 ? [...points, cursor] : points;
  return all.map(centre).join(" ");
});
const closing = computed(() => {
  const first = points[0];
  return (
    polygon &&
    points.length >= 3 &&
    first !== undefined &&
    cursor?.x === first.x &&
    cursor.y === first.y
  );
});
</script>

<template>
  <svg
    class="tool-overlay"
    :viewBox="`0 0 ${SCREEN_WIDTH} ${SCREEN_HEIGHT}`"
    preserveAspectRatio="none"
    aria-hidden="true"
    data-role="tool-overlay"
  >
    <path v-if="flood" class="tool-overlay__flood" data-role="fill-preview" :d="flood" />
    <rect
      v-if="rect"
      class="tool-overlay__line"
      :x="rect.x1"
      :y="rect.y1"
      :width="rect.x2 - rect.x1 + 1"
      :height="rect.y2 - rect.y1 + 1"
      vector-effect="non-scaling-stroke"
    />
    <polyline
      v-if="points.length > 0"
      class="tool-overlay__line"
      data-role="path-preview"
      :points="trail"
      vector-effect="non-scaling-stroke"
    />
    <rect
      v-for="(p, k) in points"
      :key="k"
      class="tool-overlay__point"
      :class="{ 'is-first': k === 0 && polygon, 'is-closing': k === 0 && closing }"
      :x="p.x"
      :y="p.y"
      width="1"
      height="1"
      vector-effect="non-scaling-stroke"
    />
    <g
      v-if="crosshair"
      class="tool-overlay__crosshair"
      data-role="key-cursor"
      :data-x="crosshair.x"
      :data-y="crosshair.y"
    >
      <path
        v-for="layer in ['under', 'over']"
        :key="layer"
        :class="`tool-overlay__cross-${layer}`"
        :d="`M${crosshair.x + 0.5} ${crosshair.y - ARM}V${crosshair.y}M${crosshair.x + 0.5} ${crosshair.y + 1}V${crosshair.y + 1 + ARM}M${crosshair.x - ARM / 2} ${crosshair.y + 0.5}H${crosshair.x}M${crosshair.x + 1} ${crosshair.y + 0.5}H${crosshair.x + 1 + ARM / 2}`"
        vector-effect="non-scaling-stroke"
      />
      <rect
        v-for="layer in ['under', 'over']"
        :key="`box-${layer}`"
        :class="`tool-overlay__cross-${layer}`"
        :x="crosshair.x"
        :y="crosshair.y"
        width="1"
        height="1"
        vector-effect="non-scaling-stroke"
      />
    </g>
  </svg>
</template>

<style scoped>
.tool-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.tool-overlay__flood {
  fill: var(--action);
  fill-opacity: 0.35;
}
.tool-overlay__line {
  fill: none;
  stroke: var(--action);
  stroke-width: 1px;
  stroke-dasharray: 3 2;
}
.tool-overlay__point {
  fill: var(--surface-0);
  stroke: var(--action);
  stroke-width: 1.5px;
}
.tool-overlay__point.is-first {
  stroke: var(--warn);
}
.tool-overlay__point.is-closing {
  fill: var(--warn);
  stroke-width: 3px;
}
/* A dark casing under a light line: legible over any of the 16 colours. */
.tool-overlay__cross-under {
  fill: none;
  stroke: var(--agi-0);
  stroke-width: 3px;
}
.tool-overlay__cross-over {
  fill: none;
  stroke: var(--agi-15);
  stroke-width: 1px;
}
</style>
