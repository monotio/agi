<script setup lang="ts">
/**
 * The world map overlay: every known room — observed (journal fact), planned
 * (authoring intent) and static (a literal new.room in the logic) — as a list
 * beside a graph. Read-only with respect to the world: node positions and
 * notes are project UI data; plan editing is RC.11.
 *
 * A native modal dialog: Escape closes only this shell overlay and returns
 * focus to its invoker, the game's own dialog and prompt state untouched.
 * The graph is plain SVG — no graph library: the model is independent, the
 * markup is keyboard- and pointer-reachable, and there is no bundle cost.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useEngineApi } from "./engineContext.ts";
import { EGA_RGB } from "../../src/picture/png.ts";
import { mapArchiveData } from "./roomMapStore.ts";
import { getOrExtractCheckpoints, loadWalkthrough, resolveWalkthrough } from "./walkthrough.ts";
import type { RoomGraphEdge, RoomGraphNode } from "../../src/agent/roomMap.ts";

const engine = useEngineApi();
const { state } = engine;
const map = engine.roomMap;
// Top-level refs unwrap in the template; .value stays in the script.
const { selected, unsaved, storageError } = map;

const dialog = useTemplateRef("dialog");
const thumbCanvas = useTemplateRef("thumbCanvas");
const listEl = useTemplateRef("listEl");
const graphFold = useTemplateRef("graphFold");

onMounted(() => {
  dialog.value?.showModal();
  // Phones read the list first; the graph stays one tap away.
  if (graphFold.value && matchMedia("(max-width: 700px)").matches) graphFold.value.open = false;
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

const viewBox = computed(() => {
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
  if (!Number.isFinite(minX)) return "0 0 640 400";
  return `${minX - 40} ${minY - 40} ${maxX - minX + 80} ${maxY - minY + 80}`;
});

const NODE_W = 120;
const NODE_H = 44;

/** Position lookup for the template — every edge endpoint is a graph node. */
function posOf(room: number): { x: number; y: number } {
  return positioned.value.get(room) ?? { x: 0, y: 0 };
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

function selectRoom(room: number): void {
  map.select(room);
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
  selectRoom(nodes[next]!.room);
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

let dragging: { room: number; dx: number; dy: number } | null = null;

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
  dragging = { room, dx: p.x - pos.x, dy: p.y - pos.y };
  (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
}

function onNodePointerMove(ev: PointerEvent): void {
  if (!dragging) return;
  const p = svgPoint(ev);
  map.previewNode(dragging.room, p.x - dragging.dx, p.y - dragging.dy);
}

function onNodePointerUp(ev: PointerEvent, room: number): void {
  if (!dragging || dragging.room !== room) return;
  const p = svgPoint(ev);
  map.moveNode(room, p.x - dragging.dx, p.y - dragging.dy);
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
  const via = edge.label ? ` via ${edge.label}` : "";
  const count = edge.count && edge.count > 1 ? ` ×${edge.count}` : "";
  return `${PROVENANCE_WORD[edge.provenance]}${via}${count}`;
}

const nodeBadges = computed(() => {
  const map_ = new Map<number, string[]>();
  for (const n of graph.value.nodes) {
    const badges: string[] = [];
    if (n.observed) badges.push("visited");
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
            <button type="button" class="map-list-button" @click="selectRoom(node.room)">
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

      <details ref="graphFold" class="map-graph-pane" open data-testid="map-graph-pane">
        <summary>Graph</summary>
        <svg
          class="map-graph"
          :viewBox="viewBox"
          role="group"
          aria-label="Room graph"
          data-testid="map-graph"
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
          </defs>
          <g
            v-for="(edge, i) in graph.edges"
            :key="`e${i}`"
            :class="`edge edge-${edge.provenance}`"
          >
            <path
              v-if="edge.from === edge.to"
              class="edge-line"
              :d="`M ${posOf(edge.from).x + NODE_W / 2} ${posOf(edge.from).y}
                   a 26 18 0 1 1 0.1 0`"
              marker-end="url(#map-arrow)"
            />
            <line
              v-else
              class="edge-line"
              :x1="posOf(edge.from).x + NODE_W / 2"
              :y1="posOf(edge.from).y + NODE_H / 2"
              :x2="posOf(edge.to).x + NODE_W / 2"
              :y2="posOf(edge.to).y + NODE_H / 2"
              marker-end="url(#map-arrow)"
            />
            <text
              v-if="edge.label"
              class="edge-label"
              :x="(posOf(edge.from).x + posOf(edge.to).x) / 2 + NODE_W / 2"
              :y="(posOf(edge.from).y + posOf(edge.to).y) / 2 + NODE_H / 2 - 6"
            >
              {{ edge.label }}
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
            <text class="node-label" x="10" y="18">Room {{ node.room }}</text>
            <text v-if="node.title" class="node-title" x="10" y="34">{{ node.title }}</text>
          </g>
        </svg>
        <p class="map-legend">
          <span class="edge edge-observed">—</span> walked ·
          <span class="edge edge-planned">- -</span> planned ·
          <span class="edge edge-static">…</span> named in logic
        </p>
      </details>

      <section v-if="selectedNode" class="map-detail" data-testid="map-detail">
        <h3>
          Room {{ selectedNode.room
          }}<template v-if="selectedNode.title"> — {{ selectedNode.title }}</template>
          <span v-if="currentRoom === selectedNode.room" class="map-current-tag">you are here</span>
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
          <template v-if="selectedNode.authored"> · logic exists</template>
          <template v-if="selectedNode.picture"> · picture exists</template>
          <template v-if="selectedNode.variableExit"> · has a computed exit</template>
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
  overflow: auto;
  min-height: 240px;
}
.map-graph-pane summary {
  padding: 8px 12px;
  cursor: pointer;
  color: #8aa4ac;
  font-size: 12px;
}
.map-graph {
  display: block;
  width: 100%;
  min-height: 320px;
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
.node-label {
  fill: #e3ecee;
  font-size: 12px;
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
  overflow-y: auto;
}
.map-detail h3 {
  margin: 0;
  font-size: 15px;
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
  .map-graph-pane:not([open]) {
    min-height: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .world-map * {
    animation: none;
    transition: none;
  }
}
</style>
