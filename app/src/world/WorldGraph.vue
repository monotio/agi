<script setup lang="ts">
/**
 * The world graph: rooms as thumbnail nodes over their exits, in plain SVG.
 * No graph library: compared with the candidates (d3-force, Cytoscape.js,
 * vis-network, sigma.js), a library buys force layout and viewport culling
 * but costs 60–200 kB gzipped, carries its own input model (pan/zoom/keys
 * we'd have to cage so Space still types into the parser), and its editing
 * APIs assume node/edge ownership — while this editor needs drag and inline
 * edits on OUR merge of three provenances. Hand-rolled SVG keeps every node
 * a real focusable element, pinch/drag free, and zero dependency surface.
 *
 * Shared by the world-map window and the Create mode's World panel; the
 * compact form opens zoomed out to fit the dock.
 */
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { useEngineApi } from "../engineContext.ts";
import {
  CAP_H,
  IMG_H,
  NODE_H,
  NODE_W,
  edgeGeometry,
  edgeTooltip,
  nodeLabel,
} from "./graphGeometry.ts";
import { useNodeThumbs } from "./nodeThumbs.ts";
import { useNodeDrag } from "./useNodeDrag.ts";

const { compact = false } = defineProps<{ compact?: boolean }>();

const map = useEngineApi().roomMap;
const { selected } = map;
const graph = computed(() => map.graph.value);
const currentRoom = computed(() => map.currentRoom.value);

const graphOpen = ref(true);
/** Until the user takes the viewport (pan, zoom, select), it tracks the live room. */
let followLive = true;

const EDGE_KINDS = ["observed", "planned", "static"] as const;

/** Layout version subscription: positionFor() results are plain Map entries. */
const positioned = computed(() => {
  void map.layoutVersion.value;
  const out = new Map<number, { x: number; y: number }>();
  for (const node of graph.value.nodes) out.set(node.room, map.positionFor(node.room));
  return out;
});

const bounds = computed(() => {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pos of positioned.value.values()) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + NODE_W);
    maxY = Math.max(maxY, pos.y + NODE_H);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 640, h: 400 };
  return { x: minX - 40, y: minY - 40, w: maxX - minX + 80, h: maxY - minY + 80 };
});
const viewBox = computed(
  () => `${bounds.value.x} ${bounds.value.y} ${bounds.value.w} ${bounds.value.h}`,
);

/** Position lookup for the template — every edge endpoint is a graph node. */
function posOf(room: number): { x: number; y: number } {
  return positioned.value.get(room) ?? { x: 0, y: 0 };
}

// ---- pan and zoom -------------------------------------------------------------
// The svg is sized to the world times the zoom factor, so the pane scrolls
// in both axes at any zoom; a background drag pans and ctrl/cmd+wheel zooms.

const graphScroll = useTemplateRef("graphScroll");
const zoom = ref(1);
const svgW = computed(() => Math.max(1, Math.round(bounds.value.w * zoom.value)));
const svgH = computed(() => Math.max(1, Math.round(bounds.value.h * zoom.value)));

function fitZoom(): number {
  const el = graphScroll.value;
  if (!el) return 1;
  return Math.min(el.clientWidth / bounds.value.w, el.clientHeight / bounds.value.h, 1.5);
}

function setZoom(next: number, clientX?: number, clientY?: number): void {
  followLive = false;
  const el = graphScroll.value;
  const z = Math.min(3, Math.max(0.15, next));
  if (!el || z === zoom.value) {
    zoom.value = z;
    return;
  }
  // Keep the point under the cursor (or the viewport centre) stable.
  const r = el.getBoundingClientRect();
  const ox = (clientX ?? r.left + r.width / 2) - r.left;
  const oy = (clientY ?? r.top + r.height / 2) - r.top;
  const px = ox + el.scrollLeft;
  const py = oy + el.scrollTop;
  const ratio = z / zoom.value;
  zoom.value = z;
  void nextTick(() => {
    el.scrollLeft = px * ratio - ox;
    el.scrollTop = py * ratio - oy;
  });
}

function onGraphWheel(ev: WheelEvent): void {
  followLive = false; // any wheel is the user taking the viewport
  if (!ev.ctrlKey && !ev.metaKey) return;
  ev.preventDefault();
  setZoom(zoom.value * (ev.deltaY < 0 ? 1.2 : 1 / 1.2), ev.clientX, ev.clientY);
}

let panning: { x: number; y: number; left: number; top: number; moved: number } | null = null;
const panningActive = ref(false);

function onBgPointerDown(ev: PointerEvent): void {
  followLive = false;
  if (ev.pointerType === "touch") return; // native touch scrolling already pans
  if ((ev.target as Element).closest(".map-node")) return;
  const el = graphScroll.value;
  if (!el) return;
  panning = { x: ev.clientX, y: ev.clientY, left: el.scrollLeft, top: el.scrollTop, moved: 0 };
  panningActive.value = true;
  (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
}

function onBgPointerMove(ev: PointerEvent): void {
  const el = graphScroll.value;
  if (!panning || !el) return;
  if ((ev.buttons & 1) === 0) {
    // Released outside the window: the captured pointerup never arrived.
    panning = null;
    panningActive.value = false;
    return;
  }
  const dx = ev.clientX - panning.x;
  const dy = ev.clientY - panning.y;
  panning.moved = Math.max(panning.moved, Math.abs(dx) + Math.abs(dy));
  el.scrollLeft = panning.left - dx;
  el.scrollTop = panning.top - dy;
}

function onBgPointerUp(): void {
  // A press that never moved is a click on empty space: dismiss the detail.
  if (panning && panning.moved < 5) map.select(undefined);
  panning = null;
  panningActive.value = false;
}

/** Scroll the graph so a node sits at the pane's centre. */
function centerNode(room: number, instant = false): void {
  const el = graphScroll.value;
  if (!el || !graphOpen.value) return;
  const pos = posOf(room);
  const z = zoom.value;
  el.scrollTo({
    left: (pos.x - bounds.value.x + NODE_W / 2) * z - el.clientWidth / 2,
    top: (pos.y - bounds.value.y + NODE_H / 2) * z - el.clientHeight / 2,
    behavior: instant || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

/** Select a room and hand the viewport to the user; `center` answers a list pick visually. */
function selectRoom(room: number, center = false): void {
  followLive = false;
  map.select(room);
  if (center) void nextTick(() => centerNode(room));
}

onMounted(() => {
  // Phones read the list first; the graph stays one tap away.
  if (matchMedia("(max-width: 700px)").matches) graphOpen.value = false;
  // A dock is narrow: open zoomed out so neighbours show around the room.
  if (compact) zoom.value = Math.min(0.75, Math.max(0.4, fitZoom()));
  // The scroll canvas opens on the pane's top-left corner — usually empty
  // world margin. Centre the world at mount; once the live room is known the
  // view follows it while evidence settles (each layout change re-centres
  // instantly, so async graph data can't leave it behind). The first user
  // pan, wheel-zoom or selection hands the view over.
  void nextTick(() => {
    const el = graphScroll.value;
    el?.scrollTo({
      left: (el.scrollWidth - el.clientWidth) / 2,
      top: (el.scrollHeight - el.clientHeight) / 2,
    });
  });
  watch(
    () => [currentRoom.value, map.layoutVersion.value] as const,
    () => {
      const room = currentRoom.value;
      if (!followLive || room == null || !positioned.value.has(room)) return;
      void nextTick(() => {
        if (followLive) centerNode(room, true);
      });
    },
    { immediate: true },
  );
});

const edgeGeoms = computed(() => {
  void positioned.value;
  return edgeGeometry(graph.value.edges, posOf);
});
const nodeThumbs = useNodeThumbs(map, () => graph.value.nodes);

const { onNodePointerDown, onNodePointerMove, onNodePointerUp, onNodeKeydown } = useNodeDrag({
  map,
  positionOf: (room) => positioned.value.get(room),
  takeViewport: () => {
    followLive = false;
  },
  select: (room) => selectRoom(room),
});

defineExpose({ selectRoom });
</script>

<template>
  <section
    class="map-graph-pane"
    :class="{ closed: !graphOpen, compact }"
    aria-label="Room graph"
    data-testid="map-graph-pane"
  >
    <div class="map-graph-bar">
      <button
        type="button"
        class="map-graph-fold"
        :aria-expanded="graphOpen"
        data-testid="map-graph-fold"
        @click="graphOpen = !graphOpen"
      >
        {{ graphOpen ? "▾" : "▸" }} Graph
      </button>
      <span v-show="graphOpen" class="map-zoom">
        <button
          type="button"
          class="map-zoom-btn"
          data-testid="map-zoom-out"
          aria-label="Zoom out"
          @click="setZoom(zoom / 1.25)"
        >
          −
        </button>
        <button
          type="button"
          class="map-zoom-btn map-zoom-level"
          data-testid="map-zoom-level"
          title="Reset zoom to 100%"
          @click="setZoom(1)"
        >
          {{ Math.round(zoom * 100) }}%
        </button>
        <button
          type="button"
          class="map-zoom-btn"
          data-testid="map-zoom-in"
          aria-label="Zoom in"
          @click="setZoom(zoom * 1.25)"
        >
          +
        </button>
        <button
          type="button"
          class="map-zoom-btn"
          data-testid="map-zoom-fit"
          @click="setZoom(fitZoom())"
        >
          Fit
        </button>
      </span>
    </div>
    <div
      v-show="graphOpen"
      ref="graphScroll"
      class="map-graph-scroll"
      :class="{ panning: panningActive }"
      data-testid="map-graph-scroll"
      @wheel="onGraphWheel"
    >
      <svg
        class="map-graph"
        :viewBox="viewBox"
        :width="svgW"
        :height="svgH"
        role="group"
        aria-label="Room graph"
        data-testid="map-graph"
        @pointerdown="onBgPointerDown"
        @pointermove="onBgPointerMove"
        @pointerup="onBgPointerUp"
        @pointercancel="onBgPointerUp"
      >
        <defs>
          <!-- Marker children do not inherit the referencing path's stroke,
               so each provenance gets its own marker. -->
          <marker
            v-for="kind in EDGE_KINDS"
            :id="`map-arrow-${kind}`"
            :key="kind"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path :class="`arrow arrow-${kind}`" d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
          <clipPath id="map-node-clip">
            <rect :width="NODE_W" :height="NODE_H" rx="7" />
          </clipPath>
        </defs>
        <g
          v-for="(geom, i) in edgeGeoms"
          :key="`e${i}`"
          :class="`edge edge-${geom.edge.provenance}`"
        >
          <title>{{ edgeTooltip(geom.edge) }}</title>
          <!-- A wide invisible stroke makes the thin line hoverable. -->
          <path class="edge-hit" :d="geom.d" />
          <path
            class="edge-line"
            :d="geom.d"
            :marker-end="`url(#map-arrow-${geom.edge.provenance})`"
          />
          <text v-if="geom.showLabel" class="edge-label" :x="geom.lx" :y="geom.ly">
            {{ geom.edge.label }}
          </text>
        </g>
        <g
          v-for="node in graph.nodes"
          :key="node.room"
          class="map-node"
          :class="{
            observed: node.observed,
            planned: node.planned,
            static: !node.observed && !node.planned,
            selected: selected === node.room,
            current: currentRoom === node.room,
          }"
          :transform="`translate(${posOf(node.room).x} ${posOf(node.room).y})`"
          tabindex="0"
          role="button"
          :aria-label="`Room ${node.room}${node.title ? `, ${node.title}` : ''}`"
          :data-testid="`map-node-${node.room}`"
          @click="selectRoom(node.room)"
          @keydown="onNodeKeydown($event, node.room)"
          @pointerdown="onNodePointerDown($event, node.room)"
          @pointermove="onNodePointerMove"
          @pointerup="onNodePointerUp($event, node.room)"
        >
          <rect class="node-box" :width="NODE_W" :height="NODE_H" rx="7" />
          <image
            v-if="nodeThumbs.get(node.room)"
            class="node-thumb"
            :href="nodeThumbs.get(node.room)"
            x="0"
            y="0"
            :width="NODE_W"
            :height="IMG_H"
            preserveAspectRatio="xMidYMid slice"
            clip-path="url(#map-node-clip)"
          />
          <text v-else class="node-empty-label" :x="NODE_W / 2" :y="IMG_H / 2">
            Room {{ node.room }}
          </text>
          <rect
            class="node-caption"
            :y="IMG_H"
            :width="NODE_W"
            :height="CAP_H"
            clip-path="url(#map-node-clip)"
          />
          <text class="node-label" x="8" :y="IMG_H + 15">{{ nodeLabel(node) }}</text>
        </g>
      </svg>
    </div>
    <p v-show="graphOpen" class="map-legend">
      <span class="edge edge-observed">—</span> walked
      <template v-if="map.experience.value === 'create'">
        · <span class="edge edge-planned">- -</span> planned ·
        <span class="edge edge-static">…</span> named in logic
      </template>
    </p>
  </section>
</template>

<style scoped>
.map-graph-pane {
  display: flex;
  flex-direction: column;
  min-height: 240px;
  /* A grid item refuses to shrink below its content size; without this the
     svg's width would stretch the pane instead of scrolling inside it. */
  min-width: 0;
  overflow: hidden;
}
.map-graph-pane.closed {
  min-height: 0;
}
.map-graph-pane.compact {
  min-height: 0;
}
.map-graph-pane.compact .map-graph-scroll {
  flex: none;
  height: 200px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-0);
}
.map-graph-bar {
  display: flex;
  align-items: center;
  padding: var(--space-1) var(--space-4);
}
.compact .map-graph-bar {
  padding: 0 0 var(--space-1);
}
.map-graph-fold {
  padding: var(--space-1) 0;
  border: none;
  color: var(--ink-3);
  background: none;
  font-size: var(--text-xs);
  cursor: pointer;
}
.map-zoom {
  display: inline-flex;
  gap: var(--space-1);
  margin-left: auto;
}
.map-zoom-btn {
  padding: 0 var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-2);
  font-size: var(--text-xs);
  line-height: 18px;
  cursor: pointer;
}
.map-zoom-btn:hover {
  background: var(--surface-3);
}
.map-zoom-level {
  min-width: 44px;
}
.map-graph-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  cursor: grab;
}
.map-graph-scroll.panning {
  cursor: grabbing;
}
.map-graph {
  display: block;
}
.map-node {
  cursor: pointer;
  outline: none;
}
.map-node:focus-visible .node-box {
  stroke: var(--focus);
  stroke-width: 2.5;
}
.node-box {
  fill: var(--surface-2);
  stroke: var(--hairline-strong);
  stroke-width: 1.5;
}
.map-node.observed .node-box {
  fill: var(--surface-3);
  stroke: var(--ink-3);
}
.map-node.static .node-box,
.map-node.planned:not(.observed) .node-box {
  stroke-dasharray: 4 3;
}
.map-node.selected .node-box {
  stroke: var(--action);
  stroke-width: 2.5;
}
.map-node.current .node-box {
  stroke: var(--ok);
  stroke-width: 2.5;
}
.node-thumb {
  pointer-events: none;
}
.node-caption {
  fill: var(--surface-overlay);
}
.node-empty-label {
  fill: var(--ink-3);
  font-size: var(--text-sm);
  text-anchor: middle;
}
.node-label {
  fill: var(--ink);
  font-size: var(--text-2xs);
  pointer-events: none;
}
.edge-line {
  fill: none;
  stroke: var(--hairline-strong);
  stroke-width: 1.5;
}
.edge-observed .edge-line {
  stroke: var(--ok);
  stroke-width: 2;
}
.edge-planned .edge-line {
  stroke: var(--warn);
  stroke-dasharray: 7 4;
}
.edge-static .edge-line {
  stroke: var(--ink-3);
  stroke-dasharray: 2 4;
}
.arrow-observed {
  fill: var(--ok);
}
.arrow-planned {
  fill: var(--warn);
}
.arrow-static {
  fill: var(--ink-3);
}
.edge-label {
  fill: var(--ink-2);
  font-size: var(--text-2xs);
  text-anchor: middle;
}
.edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 12;
}
.map-legend {
  margin: 0;
  padding: var(--space-2) var(--space-4);
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.compact .map-legend {
  padding: var(--space-1) 0 0;
}
.map-legend .edge-observed {
  color: var(--ok);
}
.map-legend .edge-planned {
  color: var(--warn);
}
.map-legend .edge-static {
  color: var(--ink-3);
}
</style>
