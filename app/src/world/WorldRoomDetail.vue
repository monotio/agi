<script setup lang="ts">
/**
 * One room's details: what the evidence says about it, its exits and
 * entrances with their notes, recorded visits, the room note, and — on a
 * creator surface with a plan — the plan editor and reference art. The
 * window adds the room's picture; the World panel's compact card puts its
 * Studio actions in the `lead` slot. `viewOnly` (a phone's Create) keeps
 * the facts and drops every edit.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import MapPlanEditor from "../MapPlanEditor.vue";
import { useEngineApi } from "../engineContext.ts";
import { EGA_RGB } from "../../../src/picture/png.ts";
import { getOrExtractCheckpoints, loadWalkthrough, resolveWalkthrough } from "../walkthrough.ts";
import { openReferenceUpload } from "../referenceUploadState.ts";
import type { RoomGraphEdge, RoomGraphNode } from "../../../src/agent/roomMap.ts";

const {
  node,
  compact = false,
  viewOnly = false,
} = defineProps<{
  node: RoomGraphNode;
  compact?: boolean;
  viewOnly?: boolean;
}>();

const engine = useEngineApi();
const map = engine.roomMap;
const graph = computed(() => map.graph.value);
const currentRoom = computed(() => map.currentRoom.value);
const canPlan = computed(() => map.canPlan.value && !viewOnly);

/** Visits to the room, newest first. */
const visits = computed(() =>
  map.journal
    .filter((e) => e.to === node.room)
    .slice(-8)
    .reverse(),
);

const edges = computed(() => ({
  out: graph.value.edges.filter((e) => e.from === node.room),
  in: graph.value.edges.filter((e) => e.from !== node.room && e.to === node.room),
}));

/** A visit's tape position: open the transport (paused) at that moment. */
function jumpToVisit(hist: { segment: string; seq: number; tick: number }): void {
  map.closeMap();
  void engine.historyView.jumpToVisit({ segment: hist.segment, tick: hist.tick });
}

// ---- the picture -------------------------------------------------------------

const thumbCanvas = useTemplateRef("thumbCanvas");
const thumbKind = ref<string>("");

function paintThumb(): void {
  const canvas = thumbCanvas.value;
  if (!canvas) return;
  const thumb = map.thumbnailFor(node.room);
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

watch(
  [() => node.room, () => map.thumbVersion.value],
  async () => {
    if (compact) return;
    thumbKind.value = map.thumbnailFor(node.room)?.kind ?? "";
    // The canvas mounts under v-if="thumbKind" — paint after it exists.
    await nextTick();
    paintThumb();
  },
  { immediate: true },
);

// ---- Watch from here ---------------------------------------------------------

const watchTarget = ref<{ tick: number; label: string }>();
watch(
  () => node.room,
  async (room) => {
    watchTarget.value = undefined;
    const game = engine.currentGame();
    const alias = game?.alias ? resolveWalkthrough(game.alias) : null;
    if (!alias || !game?.installed || viewOnly) return;
    try {
      const artifact = await loadWalkthrough(alias);
      const cp = getOrExtractCheckpoints(artifact).find((c) => c.room === room);
      if (cp && node.room === room) watchTarget.value = { tick: cp.tick, label: cp.label };
    } catch {
      /* no walkthrough for this edition — the action stays hidden */
    }
  },
  { immediate: true },
);

async function watchFromHere(): Promise<void> {
  const game = engine.currentGame();
  const target = watchTarget.value;
  if (!game?.alias || !target) return;
  map.closeMap();
  // The walkthrough's own revision check (WORDS.TOK hash against the
  // artifact's recorded edition) runs inside startWalkthrough.
  await engine.startWalkthrough(game.alias, { initialTick: target.tick });
}

// ---- notes -------------------------------------------------------------------

const noteDraft = ref("");
watch(
  () => node.room,
  (room) => {
    noteDraft.value = map.noteFor(room);
  },
  { immediate: true },
);

function commitNote(): void {
  map.setNote(node.room, noteDraft.value.trim());
}

function edgeKey(e: RoomGraphEdge): string {
  return `${e.from}->${e.to}:${e.label ?? ""}`;
}

const edgeNoteDrafts = ref<Record<string, string>>({});
watch(
  [() => node.room, () => map.layoutVersion.value, () => graph.value.edges],
  () => {
    const drafts: Record<string, string> = {};
    for (const e of [...edges.value.out, ...edges.value.in])
      drafts[edgeKey(e)] = map.edgeNoteFor(e.from, e.to, e.label);
    edgeNoteDrafts.value = drafts;
  },
  { immediate: true },
);

function commitEdgeNote(e: RoomGraphEdge, value: string): void {
  edgeNoteDrafts.value[edgeKey(e)] = value;
  map.setEdgeNote(e.from, e.to, e.label, value.trim());
}

// ---- words -------------------------------------------------------------------

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
  return `${PROVENANCE_WORD[edge.provenance]}${via}${count}`;
}
</script>

<template>
  <section class="map-detail" :class="{ compact }" data-testid="map-detail">
    <h3>
      <span class="map-detail-title"
        >Room {{ node.room }}<template v-if="node.title"> — {{ node.title }}</template></span
      >
      <span v-if="currentRoom === node.room" class="map-current-tag">you are here</span>
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
    <slot name="lead" />
    <template v-if="!compact">
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
    </template>
    <p class="map-facts">
      <span v-if="node.observed">Visited {{ node.visits }}×</span>
      <span v-else>Not visited</span>
      <template v-if="node.planned"> · planned</template>
      <template v-if="node.referenced"> · named by a stored test</template>
      <template v-if="node.playtested"> · reached in a recorded run</template>
      <template v-if="node.authored"> · logic exists</template>
      <template v-if="node.picture"> · picture exists</template>
      <template v-if="node.variableExit"> · has a computed exit</template>
      <template v-if="node.unknownCalls">
        · calls an unresolved logic — exits may be incomplete</template
      >
      <template v-if="node.unknownSource"> · entered from a shared logic — source unknown</template>
    </p>
    <button
      v-if="canPlan"
      type="button"
      class="ui-button ui-button--secondary map-attach-reference"
      data-testid="map-attach-reference"
      @click="openReferenceUpload(node.room)"
    >
      Attach reference art
    </button>
    <div class="map-connections">
      <div v-for="side in ['out', 'in'] as const" :key="side">
        <h4>{{ side === "out" ? "Exits" : "Entrances" }}</h4>
        <p v-if="!edges[side].length" class="map-none">
          {{ side === "out" ? "No observed exit yet." : "Connection unknown." }}
        </p>
        <ul v-else>
          <li v-for="(e, i) in edges[side]" :key="i">
            <template v-if="side === 'out'">→ Room {{ e.to }}</template
            ><template v-else>← Room {{ e.from }}</template> — {{ edgeWord(e) }}
            <button
              v-if="canPlan && e.provenance === 'planned'"
              type="button"
              class="map-edge-remove"
              aria-label="Remove planned exit"
              :data-testid="`edge-remove-${e.from}-${e.to}-${e.label ?? ''}`"
              @click="map.removePlannedExit(e.from, e.label!)"
            >
              ×
            </button>
            <input
              v-if="!viewOnly"
              class="map-edge-note"
              :value="edgeNoteDrafts[edgeKey(e)]"
              maxlength="500"
              placeholder="note…"
              :data-testid="`edge-note-${e.from}-${e.to}-${e.label ?? ''}`"
              @change="commitEdgeNote(e, ($event.target as HTMLInputElement).value)"
            />
          </li>
        </ul>
      </div>
    </div>
    <div v-if="visits.length" class="map-visits">
      <h4>Visits</h4>
      <ul>
        <li v-for="v in visits" :key="`${v.session}:${v.seq}`">
          {{ v.cause }}<template v-if="v.edge"> ({{ v.edge }})</template>
          <template v-if="v.scoreDelta">
            · score {{ v.scoreDelta > 0 ? "+" : "" }}{{ v.scoreDelta }}</template
          >
          <template v-if="v.gained.length"> · got {{ v.gained.join(", ") }}</template>
          <template v-if="v.lost.length"> · lost {{ v.lost.join(", ") }}</template>
          <button
            v-if="v.history"
            type="button"
            class="map-visit-jump"
            :data-testid="`map-visit-jump-${v.session}-${v.seq}`"
            title="Travel to this visit on the recorded tape"
            aria-label="Travel to this visit"
            @click="jumpToVisit(v.history!)"
          >
            ⏮
          </button>
        </li>
      </ul>
    </div>
    <label v-if="!viewOnly" class="map-note">
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
    <p v-else-if="noteDraft" class="map-facts">Note: {{ noteDraft }}</p>
    <button
      v-if="watchTarget"
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="map-watch"
      @click="watchFromHere"
    >
      Watch from here<small>{{ watchTarget.label }}</small>
    </button>
    <MapPlanEditor v-if="canPlan" :node="node" />
  </section>
</template>

<style scoped>
.map-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
}
.map-detail.compact {
  padding: var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-2);
}
.map-detail h3 {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0;
  font-size: var(--text-md);
}
.map-detail-title {
  min-width: 0;
  overflow-wrap: anywhere;
}
.map-detail-close {
  margin-left: auto;
  padding: var(--space-0) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--ink-3);
  background: none;
  font-size: var(--text-lg);
  line-height: 1;
  cursor: pointer;
}
.map-detail-close:hover {
  color: var(--ink);
  background: var(--surface-3);
}
.map-current-tag {
  color: var(--ok);
  font-size: var(--text-xs);
  font-weight: normal;
  white-space: nowrap;
}
.map-thumb {
  width: 320px;
  max-width: 100%;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--agi-0);
  image-rendering: pixelated;
}
.map-thumb-tag {
  margin: calc(var(--space-1) * -1) 0 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.map-facts,
.map-none {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.map-connections {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-7);
}
.map-connections h4,
.map-visits h4 {
  margin: 0 0 var(--space-1);
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.map-connections ul,
.map-visits ul {
  margin: 0;
  padding-left: var(--space-5);
  font-size: var(--text-xs);
}
.map-visit-jump {
  margin-left: var(--space-2);
  padding: 0 var(--space-1);
  border: 1px solid var(--action-line);
  border-radius: var(--radius-sm);
  color: var(--action);
  background: var(--action-soft);
  font-size: var(--text-2xs);
  line-height: 1.4;
  cursor: pointer;
}
.map-visit-jump:hover {
  border-color: var(--action);
  color: var(--ink);
}
.map-note {
  font-size: var(--text-xs);
}
.map-note textarea {
  box-sizing: border-box;
  width: 100%;
  margin-top: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: inherit;
  background: var(--surface-0);
  font: inherit;
  font-size: var(--text-sm);
}
.map-edge-remove {
  padding: 0 var(--space-1);
  border: none;
  color: var(--danger);
  background: none;
  font-size: var(--text-sm);
  cursor: pointer;
}
.map-edge-note {
  width: 110px;
  margin-left: var(--space-2);
  padding: var(--space-0) var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-0);
  font-family: inherit;
  font-size: var(--text-2xs);
}
</style>
