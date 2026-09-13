<script setup lang="ts">
/**
 * The world map overlay: every known room — observed (journal fact), planned
 * (authoring intent) and static (a literal new.room in the logic) — as a list
 * beside a graph. Read-only with respect to the world: node positions and
 * notes are project UI data; plan editing is RC.11.
 *
 * A native modal dialog: Escape closes only this shell overlay and returns
 * focus to its invoker, the game's own dialog and prompt state untouched.
 * The graph is plain SVG — no graph library. The comparison on record
 * (RC.10, 3.3): against the maintained candidates (d3-force, Cytoscape.js,
 * vis-network, sigma.js), a library buys force layout and viewport culling
 * but costs 60–200 kB gzipped, carries its own input model (pan/zoom/keys
 * we'd have to cage so Space still types into the parser), and its editing
 * APIs assume node/edge ownership — while RC.11 needs drag, add-node,
 * add-edge and inline rename on OUR merge of three provenances. Hand-rolled
 * SVG keeps every node a real focusable element, pinch/drag free, the model
 * renderer-independent, and zero dependency surface. The room list does not
 * depend on the graph at all.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { EGA_RGB } from "../../src/picture/png.ts";
import { mapArchiveData } from "./roomMapStore.ts";
import { getOrExtractCheckpoints, loadWalkthrough, resolveWalkthrough } from "./walkthrough.ts";
import type { RoomGraphEdge, RoomGraphNode } from "../../src/agent/roomMap.ts";
import type { MapThumbnail } from "./useRoomMap.ts";

const engine = useEngineApi();
const { state } = engine;
const map = engine.roomMap;
// Top-level refs unwrap in the template; .value stays in the script.
const { selected, unsaved, storageError } = map;

const dialog = useTemplateRef("dialog");
const thumbCanvas = useTemplateRef("thumbCanvas");
const listEl = useTemplateRef("listEl");
const graphOpen = ref(true);

onMounted(() => {
  dialog.value?.showModal();
  // Phones read the list first; the graph stays one tap away.
  if (matchMedia("(max-width: 700px)").matches) graphOpen.value = false;
});
onUnmounted(() => {
  if (dialog.value?.open) dialog.value.close();
});

function onDialogClose(): void {
  map.closeMap();
}

const graph = computed(() => map.graph.value);
const currentRoom = computed(() => map.currentRoom.value);

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

const NODE_W = 128;
/** Picture area height; the caption strip sits below it inside the node. */
const IMG_H = 96;
const CAP_H = 22;
const NODE_H = IMG_H + CAP_H;

// ---- pan and zoom -------------------------------------------------------------
// The svg is sized to the world times the zoom factor, so the pane scrolls
// in both axes at any zoom; a background drag pans and ctrl/cmd+wheel zooms.

const graphScroll = useTemplateRef("graphScroll");
const zoom = ref(1);
const svgW = computed(() => Math.max(1, Math.round(bounds.value.w * zoom.value)));
const svgH = computed(() => Math.max(1, Math.round(bounds.value.h * zoom.value)));

function setZoom(next: number, clientX?: number, clientY?: number): void {
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

function fitGraph(): void {
  const el = graphScroll.value;
  if (!el) return;
  setZoom(Math.min(el.clientWidth / bounds.value.w, el.clientHeight / bounds.value.h, 1.5));
}

function onGraphWheel(ev: WheelEvent): void {
  if (!ev.ctrlKey && !ev.metaKey) return;
  ev.preventDefault();
  setZoom(zoom.value * (ev.deltaY < 0 ? 1.2 : 1 / 1.2), ev.clientX, ev.clientY);
}

let panning: { x: number; y: number; left: number; top: number; moved: number } | null = null;
const panningActive = ref(false);

function onBgPointerDown(ev: PointerEvent): void {
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

/** Position lookup for the template — every edge endpoint is a graph node. */
function posOf(room: number): { x: number; y: number } {
  return positioned.value.get(room) ?? { x: 0, y: 0 };
}

// ---- edges --------------------------------------------------------------------
// Two edges on one node pair (walked both ways, or a walked side plus a
// planned exit name) would draw as identical overlapping lines. Siblings fan
// out into parallel quadratic curves so each keeps its own line, arrow and
// label position.

interface EdgeGeom {
  readonly edge: RoomGraphEdge;
  /** Path data for the line/curve; self-loops carry their own arc. */
  readonly d: string;
  readonly lx: number;
  readonly ly: number;
}

const edgeGeoms = computed<EdgeGeom[]>(() => {
  void positioned.value;
  const totals = new Map<string, number>();
  for (const e of graph.value.edges) {
    const k = `${Math.min(e.from, e.to)}|${Math.max(e.from, e.to)}`;
    totals.set(k, (totals.get(k) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return graph.value.edges.map((edge) => {
    const a = posOf(edge.from);
    const b = posOf(edge.to);
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y + NODE_H / 2;
    if (edge.from === edge.to) {
      return {
        edge,
        d: `M ${x1} ${a.y} a 26 18 0 1 1 0.1 0`,
        lx: x1,
        ly: a.y - 22,
      };
    }
    const k = `${Math.min(edge.from, edge.to)}|${Math.max(edge.from, edge.to)}`;
    const n = totals.get(k)!;
    const i = seen.get(k) ?? 0;
    seen.set(k, i + 1);
    if (n === 1) {
      return { edge, d: `M ${x1} ${y1} L ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 - 6 };
    }
    const offset = (i - (n - 1) / 2) * 34;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const px = (-(y2 - y1) / len) * offset;
    const py = ((x2 - x1) / len) * offset;
    const cx = mx + px * 2;
    const cy = my + py * 2;
    return {
      edge,
      d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`,
      lx: mx + px,
      ly: my + py - 6,
    };
  });
});

/** What an edge label means, spelled out — the graph shows only the word. */
function edgeTooltip(edge: RoomGraphEdge): string {
  if (edge.provenance === "observed")
    return edge.label ? `walked off the ${edge.label} edge` : "walked";
  if (edge.provenance === "planned") return edge.label ? `planned exit “${edge.label}”` : "planned";
  return "named in logic";
}

/** Visits to the selected room, newest first. */
const selectedVisits = computed(() => {
  const room = selected.value;
  if (room === undefined) return [];
  return map.journal
    .filter((e) => e.to === room)
    .slice(-8)
    .reverse();
});

const selectedNode = computed<RoomGraphNode | null>(
  () => graph.value.nodes.find((n) => n.room === selected.value) ?? null,
);

const selectedEdges = computed(() => {
  const room = selected.value;
  if (room === undefined) return { out: [], in: [] };
  return {
    out: graph.value.edges.filter((e) => e.from === room),
    in: graph.value.edges.filter((e) => e.from !== room && e.to === room),
  };
});

// ---- thumbnails ------------------------------------------------------------

function paintThumb(): void {
  const canvas = thumbCanvas.value;
  if (!canvas || selected.value === undefined) return;
  const thumb = map.thumbnailFor(selected.value);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!thumb) return;
  const img = ctx.createImageData(160, 168);
  for (let i = 0; i < thumb.pixels.length; i++) {
    const rgb = EGA_RGB[thumb.pixels[i]! & 0x0f]!;
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  const off = document.createElement("canvas");
  off.width = 160;
  off.height = 168;
  off.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, 320, 168);
}

const thumbKind = ref<string>("");
watch(
  [selected, () => map.thumbVersion.value],
  async () => {
    thumbKind.value =
      selected.value === undefined ? "" : (map.thumbnailFor(selected.value)?.kind ?? "");
    // The canvas mounts under v-if="thumbKind" — paint after it exists.
    await nextTick();
    paintThumb();
  },
  { immediate: true },
);

// ---- node thumbnails ----------------------------------------------------------
// Each graph node draws its picture. The composable caches the pixel surfaces;
// here we cache the encoded image per room, keyed on the surface's identity so
// a re-rendered or newly-observed frame re-encodes while an evicted-then-restored
// entry still hits.

const thumbUrlCache = new Map<number, { thumb: MapThumbnail; url: string }>();
let encodeCanvas: HTMLCanvasElement | null = null;

/** Half-scale PNG of the picture surface — enough for a node face. */
function thumbDataUrl(thumb: MapThumbnail): string {
  const c = (encodeCanvas ??= document.createElement("canvas"));
  c.width = 80;
  c.height = 84;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(80, 84);
  for (let y = 0; y < 84; y++) {
    for (let x = 0; x < 80; x++) {
      const rgb = EGA_RGB[thumb.pixels[y * 320 + x * 2]! & 0x0f]!;
      const i = (y * 80 + x) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

const nodeThumbs = computed(() => {
  void map.thumbVersion.value;
  const out = new Map<number, string>();
  for (const node of graph.value.nodes) {
    const thumb = map.thumbnailFor(node.room);
    if (!thumb) continue;
    const hit = thumbUrlCache.get(node.room);
    if (hit && hit.thumb === thumb) {
      out.set(node.room, hit.url);
      continue;
    }
    const url = thumbDataUrl(thumb);
    if (thumbUrlCache.size > 300) thumbUrlCache.clear();
    thumbUrlCache.set(node.room, { thumb, url });
    out.set(node.room, url);
  }
  return out;
});

/** One-line caption: the room number, plus a truncated title when it has one. */
function nodeLabel(node: RoomGraphNode): string {
  const name = `Room ${node.room}`;
  if (!node.title) return name;
  const budget = 19 - name.length;
  if (budget < 3) return name;
  const title = node.title.length > budget ? `${node.title.slice(0, budget)}…` : node.title;
  return `${name} — ${title}`;
}

// ---- Watch from here ---------------------------------------------------------

const watchTarget = ref<{ tick: number; label: string }>();
const watchError = ref("");
watch(selected, async (room) => {
  watchTarget.value = undefined;
  watchError.value = "";
  if (room === undefined) return;
  const game = engine.currentGame();
  const alias = game?.alias ? resolveWalkthrough(game.alias) : null;
  if (!alias || !game?.installed) return;
  try {
    const artifact = await loadWalkthrough(alias);
    const cp = getOrExtractCheckpoints(artifact).find((c) => c.room === room);
    if (cp) watchTarget.value = { tick: cp.tick, label: cp.label };
  } catch {
    /* no walkthrough for this edition — the action stays hidden */
  }
});

async function watchFromHere(): Promise<void> {
  const game = engine.currentGame();
  const target = watchTarget.value;
  if (!game?.alias || !target) return;
  map.closeMap();
  // The walkthrough's own revision check (WORDS.TOK hash against the
  // artifact's recorded edition) runs inside startWalkthrough.
  await engine.startWalkthrough(game.alias, { initialTick: target.tick });
}

// ---- selection, notes, layout -------------------------------------------------

function selectRoom(room: number, center = false): void {
  map.select(room);
  if (center) void nextTick(() => centerNode(room));
}

/** Scroll the graph so the selected node sits at the pane's centre. List
 * selection is a lookup gesture — the graph should answer it visually. */
function centerNode(room: number): void {
  const el = graphScroll.value;
  if (!el || !graphOpen.value) return;
  const pos = posOf(room);
  const z = zoom.value;
  el.scrollTo({
    left: (pos.x - bounds.value.x + NODE_W / 2) * z - el.clientWidth / 2,
    top: (pos.y - bounds.value.y + NODE_H / 2) * z - el.clientHeight / 2,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

function onListKeydown(ev: KeyboardEvent): void {
  const nodes = graph.value.nodes;
  if (!nodes.length) return;
  const at = nodes.findIndex((n) => n.room === selected.value);
  let next: number;
  if (ev.key === "ArrowDown") next = at < 0 ? 0 : Math.min(nodes.length - 1, at + 1);
  else if (ev.key === "ArrowUp") next = at < 0 ? 0 : Math.max(0, at - 1);
  else return;
  ev.preventDefault();
  selectRoom(nodes[next]!.room, true);
  listEl.value
    ?.querySelector(`[data-room="${nodes[next]!.room}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

const noteDraft = ref("");
watch(selected, (room) => {
  noteDraft.value = room === undefined ? "" : map.noteFor(room);
});

function commitNote(): void {
  if (selected.value === undefined) return;
  map.setNote(selected.value, noteDraft.value.trim());
}

// ---- graph pointer drag --------------------------------------------------------

let dragging: {
  room: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  moved: boolean;
} | null = null;

function svgPoint(ev: PointerEvent): { x: number; y: number } {
  const svg = (ev.currentTarget as SVGGraphicsElement).ownerSVGElement!;
  const pt = svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const ctm = svg.getScreenCTM();
  const p = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
  return { x: p.x, y: p.y };
}

function onNodePointerDown(ev: PointerEvent, room: number): void {
  const pos = positioned.value.get(room);
  if (!pos) return;
  const p = svgPoint(ev);
  dragging = {
    room,
    dx: p.x - pos.x,
    dy: p.y - pos.y,
    sx: ev.clientX,
    sy: ev.clientY,
    moved: false,
  };
  (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
}

function onNodePointerMove(ev: PointerEvent): void {
  if (!dragging) return;
  // A click is not a move: only once the pointer travels a few px does the
  // press become a drag, so plain selection never dirties the layout.
  if (
    !dragging.moved &&
    Math.abs(ev.clientX - dragging.sx) + Math.abs(ev.clientY - dragging.sy) < 4
  )
    return;
  dragging.moved = true;
  const p = svgPoint(ev);
  map.previewNode(dragging.room, p.x - dragging.dx, p.y - dragging.dy);
}

function onNodePointerUp(ev: PointerEvent, room: number): void {
  if (!dragging || dragging.room !== room) return;
  if (dragging.moved) {
    const p = svgPoint(ev);
    map.moveNode(room, p.x - dragging.dx, p.y - dragging.dy);
  }
  dragging = null;
}

/** Keyboard move: arrows nudge a focused node; Enter/Space select it. */
function onNodeKeydown(ev: KeyboardEvent, room: number): void {
  const pos = positioned.value.get(room);
  if (!pos) return;
  const step = ev.shiftKey ? 40 : 10;
  const delta =
    ev.key === "ArrowLeft"
      ? [-step, 0]
      : ev.key === "ArrowRight"
        ? [step, 0]
        : ev.key === "ArrowUp"
          ? [0, -step]
          : ev.key === "ArrowDown"
            ? [0, step]
            : null;
  if (delta) {
    ev.preventDefault();
    map.moveNode(room, pos.x + delta[0]!, pos.y + delta[1]!);
    return;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    selectRoom(room);
  }
}

// ---- provenance words ------------------------------------------------------------

const PROVENANCE_WORD: Record<string, string> = {
  observed: "Walked",
  planned: "Planned",
  static: "In logic",
};

function edgeWord(edge: RoomGraphEdge): string {
  // An observed label is the screen edge the player crossed out through —
  // "right" means "walked off the right edge of the from-room", which the
  // bare word alone doesn't say.
  const via =
    edge.label === undefined
      ? ""
      : edge.provenance === "observed"
        ? ` off the ${edge.label} edge`
        : ` via ${edge.label}`;
  const count = edge.count && edge.count > 1 ? ` ×${edge.count}` : "";
  const covered = edge.tested ? " · covered by a stored test" : "";
  return `${PROVENANCE_WORD[edge.provenance]}${via}${count}${covered}`;
}

const nodeBadges = computed(() => {
  const map_ = new Map<number, string[]>();
  for (const n of graph.value.nodes) {
    const badges: string[] = [];
    if (n.observed) badges.push("visited");
    if (n.validated) badges.push("validated by tests");
    if (n.playtested) badges.push("playtested");
    if (n.planned) badges.push("planned");
    if (n.authored) badges.push("logic");
    if (n.picture) badges.push("picture");
    if (n.staticTarget) badges.push("named in logic");
    if (n.variableExit) badges.push("computed exit");
    map_.set(n.room, badges);
  }
  return map_;
});

// ---- sidecar export (unsaved-data escape hatch) ------------------------------------

function downloadSidecar(): void {
  const blob = new Blob([mapArchiveData(map.exportSidecar())], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "MAP.JSON";
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <dialog
    ref="dialog"
    class="world-map"
    aria-labelledby="world-map-title"
    data-testid="world-map"
    @close="onDialogClose"
  >
    <header class="map-header">
      <h2 id="world-map-title">World map</h2>
      <span v-if="state.paused" class="map-paused" data-testid="map-paused">Game paused</span>
      <span v-if="storageError" class="map-error" role="alert" data-testid="map-error">
        {{ storageError }}
      </span>
      <span v-if="unsaved" class="map-unsaved" data-testid="map-unsaved">
        Map data is not saved.
        <button type="button" class="ui-button ui-button--secondary" @click="map.retrySave()">
          Retry
        </button>
        <button type="button" class="ui-button ui-button--secondary" @click="downloadSidecar">
          Download MAP.JSON
        </button>
      </span>
      <span class="map-header-actions">
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="map-reset-layout"
          @click="map.resetLayout()"
        >
          Reset layout
        </button>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="map-close"
          @click="map.closeMap()"
        >
          Close
        </button>
      </span>
    </header>
    <div class="map-body">
      <section class="map-list-pane" aria-label="Rooms">
        <ul
          ref="listEl"
          class="map-list"
          role="listbox"
          aria-label="Rooms"
          data-testid="map-room-list"
          tabindex="0"
          @keydown="onListKeydown"
        >
          <li
            v-for="node in graph.nodes"
            :key="node.room"
            role="option"
            :aria-selected="selected === node.room"
            :data-room="node.room"
            class="map-list-item"
            :class="{ selected: selected === node.room, current: currentRoom === node.room }"
            :data-testid="`map-room-${node.room}`"
          >
            <button type="button" class="map-list-button" @click="selectRoom(node.room, true)">
              <span class="map-room-name">
                <template v-if="currentRoom === node.room">▶ </template>
                Room {{ node.room }}<template v-if="node.title"> — {{ node.title }}</template>
              </span>
              <span class="map-room-badges">{{
                (nodeBadges.get(node.room) ?? []).join(" · ")
              }}</span>
            </button>
          </li>
        </ul>
      </section>

      <section
        class="map-graph-pane"
        :class="{ closed: !graphOpen }"
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
            <button type="button" class="map-zoom-btn" data-testid="map-zoom-fit" @click="fitGraph">
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
              <marker
                id="map-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
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
              <path class="edge-line" :d="geom.d" marker-end="url(#map-arrow)" />
              <text v-if="geom.edge.label" class="edge-label" :x="geom.lx" :y="geom.ly">
                {{ geom.edge.label }}
                <title>{{ edgeTooltip(geom.edge) }}</title>
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
          <span class="edge edge-observed">—</span> walked ·
          <span class="edge edge-planned">- -</span> planned ·
          <span class="edge edge-static">…</span> named in logic
        </p>
      </section>

      <section v-if="selectedNode" class="map-detail" data-testid="map-detail">
        <h3>
          Room {{ selectedNode.room
          }}<template v-if="selectedNode.title"> — {{ selectedNode.title }}</template>
          <span v-if="currentRoom === selectedNode.room" class="map-current-tag">you are here</span>
          <button
            type="button"
            class="map-detail-close"
            aria-label="Dismiss room details"
            data-testid="map-detail-close"
            @click="map.select(undefined)"
          >
            ×
          </button>
        </h3>
        <template v-if="thumbKind">
          <canvas
            ref="thumbCanvas"
            class="map-thumb"
            width="320"
            height="168"
            data-testid="map-thumb"
          ></canvas>
          <p v-if="thumbKind === 'static'" class="map-thumb-tag">static picture render</p>
          <p v-else class="map-thumb-tag">observed frame</p>
        </template>
        <p v-else class="map-thumb-tag" data-testid="map-no-thumb">
          No image yet — visit the room to capture one.
        </p>
        <p class="map-facts">
          <span v-if="selectedNode.observed">Visited {{ selectedNode.visits }}×</span>
          <span v-else>Not visited</span>
          <template v-if="selectedNode.planned"> · planned</template>
          <template v-if="selectedNode.validated"> · validated by a stored test</template>
          <template v-if="selectedNode.playtested"> · reached in a recorded run</template>
          <template v-if="selectedNode.authored"> · logic exists</template>
          <template v-if="selectedNode.picture"> · picture exists</template>
          <template v-if="selectedNode.variableExit"> · has a computed exit</template>
          <template v-if="selectedNode.unknownCalls">
            · calls an unresolved logic — exits may be incomplete</template
          >
          <template v-if="selectedNode.unknownSource">
            · entered from a shared logic — source unknown</template
          >
        </p>
        <div class="map-connections">
          <div>
            <h4>Exits</h4>
            <p v-if="!selectedEdges.out.length" class="map-none">No observed exit yet.</p>
            <ul v-else>
              <li v-for="(e, i) in selectedEdges.out" :key="i">
                → Room {{ e.to }} — {{ edgeWord(e) }}
              </li>
            </ul>
          </div>
          <div>
            <h4>Entrances</h4>
            <p v-if="!selectedEdges.in.length" class="map-none">Connection unknown.</p>
            <ul v-else>
              <li v-for="(e, i) in selectedEdges.in" :key="i">
                ← Room {{ e.from }} — {{ edgeWord(e) }}
              </li>
            </ul>
          </div>
        </div>
        <div v-if="selectedVisits.length" class="map-visits">
          <h4>Visits</h4>
          <ul>
            <li v-for="v in selectedVisits" :key="`${v.session}:${v.seq}`">
              {{ v.cause }}<template v-if="v.edge"> ({{ v.edge }})</template>
              <template v-if="v.scoreDelta">
                · score {{ v.scoreDelta > 0 ? "+" : "" }}{{ v.scoreDelta }}</template
              >
              <template v-if="v.gained.length"> · got {{ v.gained.join(", ") }}</template>
              <template v-if="v.lost.length"> · lost {{ v.lost.join(", ") }}</template>
            </li>
          </ul>
        </div>
        <label class="map-note">
          Note
          <textarea
            v-model="noteDraft"
            rows="2"
            maxlength="4000"
            placeholder="A note about this room…"
            data-testid="map-note"
            @change="commitNote"
          ></textarea>
        </label>
        <button
          v-if="watchTarget"
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="map-watch"
          @click="watchFromHere"
        >
          Watch from here<small>{{ watchTarget.label }}</small>
        </button>
      </section>
    </div>
  </dialog>
</template>

<style scoped>
.world-map {
  width: min(980px, 96vw);
  max-height: 88dvh;
  background: #101d22;
  color: #e3ecee;
  border: 1px solid #2a4048;
  border-radius: 10px;
  padding: 0;
}
.world-map::backdrop {
  background: rgba(0, 0, 0, 0.55);
}
.map-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #2a4048;
  flex-wrap: wrap;
}
.map-header h2 {
  margin: 0;
  font-size: 17px;
}
.map-header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.map-paused {
  color: #9fe6a0;
  font-size: 12px;
}
.map-error,
.map-unsaved {
  color: #ff9b9b;
  font-size: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.map-body {
  display: grid;
  grid-template-columns: minmax(200px, 260px) 1fr;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 0;
  max-height: calc(88dvh - 60px);
}
.map-list-pane {
  border-right: 1px solid #2a4048;
  overflow-y: auto;
  min-height: 160px;
}
.map-list {
  list-style: none;
  margin: 0;
  padding: 6px;
}
.map-list-item {
  margin: 0;
}
.map-list-button {
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.map-list-item.selected .map-list-button {
  background: #1d3a44;
}
.map-list-item.current .map-room-name {
  color: #9fe6a0;
}
.map-room-badges {
  font-size: 11px;
  color: #8aa4ac;
}
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
.map-graph-bar {
  display: flex;
  align-items: center;
  padding: 4px 12px;
}
.map-graph-fold {
  background: none;
  border: none;
  color: #8aa4ac;
  font-size: 12px;
  padding: 4px 0;
  cursor: pointer;
}
.map-zoom {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
}
.map-zoom-btn {
  background: #16262c;
  color: #c9dade;
  border: 1px solid #3a5661;
  border-radius: 4px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.map-zoom-btn:hover {
  background: #1d3a44;
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
.node-box {
  fill: #16262c;
  stroke: #3a5661;
  stroke-width: 1.5;
}
.map-node.observed .node-box {
  fill: #1d3a44;
  stroke: #5f8b98;
}
.map-node.static .node-box {
  stroke-dasharray: 4 3;
}
.map-node.selected .node-box {
  stroke: #ffd977;
}
.map-node.current .node-box {
  stroke: #9fe6a0;
  stroke-width: 2.5;
}
.node-thumb {
  pointer-events: none;
}
.node-caption {
  fill: rgba(10, 20, 24, 0.82);
}
.node-empty-label {
  fill: #5f7b85;
  font-size: 13px;
  text-anchor: middle;
}
.node-label {
  fill: #e3ecee;
  font-size: 11px;
  pointer-events: none;
}
.node-title {
  fill: #8aa4ac;
  font-size: 10px;
}
.edge-line {
  stroke: #4a6a76;
  stroke-width: 1.5;
  fill: none;
}
.edge-observed .edge-line {
  stroke: #9fe6a0;
  stroke-width: 2;
}
.edge-planned .edge-line {
  stroke-dasharray: 7 4;
  stroke: #ffd977;
}
.edge-static .edge-line {
  stroke-dasharray: 2 4;
  stroke: #8aa4ac;
}
.edge-label {
  fill: #c9dade;
  font-size: 10px;
  text-anchor: middle;
}
.map-legend {
  padding: 6px 12px;
  font-size: 11px;
  color: #8aa4ac;
  margin: 0;
}
.map-detail {
  grid-column: 1 / -1;
  border-top: 1px solid #2a4048;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* The auto row takes the detail's content height; without a cap a tall
     detail starves the list row and its scrollport hides list items under
     this pane. */
  max-height: 38dvh;
  overflow-y: auto;
}
.map-detail h3 {
  margin: 0;
  font-size: 15px;
  display: flex;
  align-items: center;
}
.map-detail-close {
  margin-left: auto;
  background: none;
  border: none;
  color: #8aa4ac;
  font-size: 18px;
  line-height: 1;
  padding: 2px 8px;
  cursor: pointer;
  border-radius: 4px;
}
.map-detail-close:hover {
  background: #1d3a44;
  color: #e3ecee;
}
.map-current-tag {
  color: #9fe6a0;
  font-size: 12px;
  margin-left: 8px;
}
.map-thumb {
  width: 320px;
  max-width: 100%;
  border: 1px solid #2a4048;
  border-radius: 4px;
  background: #000;
}
.map-thumb-tag {
  font-size: 11px;
  color: #8aa4ac;
  margin: -4px 0 0;
}
.map-facts,
.map-none {
  font-size: 12px;
  color: #8aa4ac;
  margin: 0;
}
.map-connections {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}
.map-connections h4,
.map-visits h4 {
  margin: 0 0 4px;
  font-size: 12px;
  color: #c9dade;
}
.map-connections ul,
.map-visits ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
}
.map-note textarea {
  width: 100%;
  box-sizing: border-box;
  margin-top: 4px;
  background: #0a1418;
  color: inherit;
  border: 1px solid #2a4048;
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
}
@media (max-width: 700px) {
  .map-body {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto auto;
  }
  .map-list-pane {
    border-right: none;
    border-bottom: 1px solid #2a4048;
    max-height: 34dvh;
  }
}
@media (prefers-reduced-motion: reduce) {
  .world-map * {
    animation: none;
    transition: none;
  }
}
</style>
