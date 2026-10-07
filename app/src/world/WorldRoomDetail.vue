<script setup lang="ts">
import { useProjectLabels } from "../shell/useProjectLabels.ts";
import { numberedLabel, numberedSlot } from "../../../src/logic/numberedLabels.ts";
/**
 * One room's inspector, shaped like Studio's: a header with the room's name
 * and its resource chips (the `chips` slot), the Studio actions (the `lead`
 * slot, one primary), then its exits and entrances, the plan editor on a
 * creator surface, the room note and recorded visits. Reference art is a
 * secondary action; the evidence behind the room (visited, planned, named by
 * a test…) folds under a plain-words Details disclosure. The window adds the
 * room's picture; "All rooms" beside the card is the way back (useRoomDrill.ts).
 * `viewOnly` (a phone's Create) keeps the facts and drops every edit.
 */
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import MapPlanEditor from "./MapPlanEditor.vue";
import UiButton from "../ui/UiButton.vue";
import UiField from "../ui/UiField.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { EGA_RGB } from "../../../src/picture/png.ts";
import {
  getOrExtractCheckpoints,
  loadWalkthrough,
  resolveWalkthrough,
} from "../walkthrough/walkthrough.ts";
import { openReferenceUpload } from "../references/referenceUploadState.ts";
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

const labels = useProjectLabels();
const roomHeading = computed(() =>
  numberedLabel("room", node.room, { ...labels.value, name: node.title ?? "" }),
);
const hasTitle = computed(() => roomHeading.value !== numberedSlot("room", node.room));
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

/** A visit's tape position: open the transport at that moment. */
function jumpToVisit(hist: { segment: string; seq: number; tick: number }): void {
  map.closeMap();
  void engine.historyView.jumpToVisit({ segment: hist.segment, tick: hist.tick });
}

// ---- the picture -------------------------------------------------------------

const heading = useTemplateRef("heading");

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

/** The exit whose note is open for editing; one at a time. */
const editingNote = ref<string>();
watch(
  () => node.room,
  () => {
    editingNote.value = undefined;
  },
);

/**
 * The evidence behind the room, in plain words, for the Details disclosure.
 * The first fact doubles as its summary.
 */
const facts = computed(() => {
  const out = [node.observed ? `Visited ${node.visits}×` : "Not visited"];
  if (node.planned) out.push("planned");
  if (node.authored) out.push("built");
  else if (node.planned) out.push("not built yet");
  if (node.referenced) out.push("a stored game test names it");
  if (node.playtested) out.push("a recorded playthrough reaches it");
  if (node.picture) out.push("its picture is in the game");
  if (node.variableExit) out.push("one exit is worked out while the game runs");
  if (node.unknownCalls)
    out.push("its logic calls an unreadable resource, so the map may be missing exits");
  if (node.unknownSource) out.push("shared logic sends players here, so where from is unknown");
  return out;
});

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

defineExpose({ focusHeading: () => heading.value?.focus() });
</script>

<template>
  <section
    class="room-inspector"
    :class="{ compact }"
    data-testid="map-detail"
    :data-room="node.room"
  >
    <header class="ri-head">
      <div class="ri-heading">
        <p v-if="hasTitle || currentRoom === node.room" class="ri-eyebrow">
          <span v-if="hasTitle">{{ numberedSlot("room", node.room) }}</span>
          <span v-if="currentRoom === node.room" class="ri-here"
            ><span class="ri-here__dot" aria-hidden="true"></span>you are here</span
          >
        </p>
        <h3 ref="heading" class="ri-title" tabindex="-1">
          {{ roomHeading }}
        </h3>
      </div>
    </header>
    <div v-if="$slots['chips']" class="ri-chips"><slot name="chips" /></div>
    <template v-if="!compact">
      <template v-if="thumbKind">
        <canvas
          ref="thumbCanvas"
          class="ri-thumb"
          width="320"
          height="168"
          data-testid="map-thumb"
        ></canvas>
        <p class="ri-note">
          {{ thumbKind === "static" ? "Static picture render" : "Frame seen in play" }}
        </p>
      </template>
      <p v-else class="ri-note" data-testid="map-no-thumb">
        No image yet. Visit the room to capture one.
      </p>
    </template>
    <div v-if="$slots['lead']" class="ri-lead"><slot name="lead" /></div>

    <section
      v-for="side in ['out', 'in'] as const"
      :key="side"
      class="ri-sec"
      :aria-label="side === 'out' ? 'Exits' : 'Entrances'"
    >
      <h4 class="ri-sec__title">{{ side === "out" ? "Exits" : "Entrances" }}</h4>
      <p
        v-if="!edges[side].length && !(side === 'out' && (node.variableExit || node.unknownCalls))"
        class="ri-note"
      >
        {{ side === "out" ? "No observed exit yet." : "Connection unknown." }}
      </p>
      <ul v-else class="ri-list">
        <li
          v-if="side === 'out' && (node.variableExit || node.unknownCalls)"
          class="ri-exit"
          data-testid="map-computed-exit"
        >
          <UiIcon class="ri-exit__icon" name="arrow-right" :size="14" />
          <span class="ri-exit__main">
            <span class="ri-exit__room">Computed at runtime</span>
            <span class="ri-exit__how">Worked out while you play</span>
          </span>
        </li>
        <li v-for="(e, i) in edges[side]" :key="i" class="ri-exit">
          <UiIcon
            class="ri-exit__icon"
            :name="side === 'out' ? 'arrow-right' : 'arrow-left'"
            :size="14"
          />
          <span class="ri-exit__main">
            <span class="ri-exit__room">{{
              numberedLabel("room", side === "out" ? e.to : e.from, labels, "row")
            }}</span>
            <span class="ri-exit__how" :class="`ri-exit__how--${e.provenance}`">{{
              edgeWord(e)
            }}</span>
            <span
              v-if="edgeNoteDrafts[edgeKey(e)] && editingNote !== edgeKey(e)"
              class="ri-exit__note"
              >{{ edgeNoteDrafts[edgeKey(e)] }}</span
            >
          </span>
          <span class="ri-exit__actions">
            <UiIconButton
              v-if="!viewOnly"
              icon="message"
              size="sm"
              :label="edgeNoteDrafts[edgeKey(e)] ? 'Edit the note on this exit' : 'Add a note'"
              :pressed="editingNote === edgeKey(e)"
              @click="editingNote = editingNote === edgeKey(e) ? undefined : edgeKey(e)"
            />
            <UiIconButton
              v-if="canPlan && e.provenance === 'planned'"
              icon="trash"
              size="sm"
              label="Remove planned exit"
              :data-testid="`edge-remove-${e.from}-${e.to}-${e.label ?? ''}`"
              @click="map.removePlannedExit(e.from, e.label!)"
            />
          </span>
          <input
            v-if="!viewOnly && editingNote === edgeKey(e)"
            class="ri-exit__input"
            :value="edgeNoteDrafts[edgeKey(e)]"
            maxlength="500"
            placeholder="A note about this exit"
            :aria-label="`Note on the exit to room ${side === 'out' ? e.to : e.from}`"
            :data-testid="`edge-note-${e.from}-${e.to}-${e.label ?? ''}`"
            @change="commitEdgeNote(e, ($event.target as HTMLInputElement).value)"
            @keydown.enter="editingNote = undefined"
          />
        </li>
      </ul>
    </section>

    <MapPlanEditor v-if="canPlan" :node="node" />

    <section class="ri-sec" aria-label="Note">
      <UiField v-if="!viewOnly" v-slot="{ id }" label="Note" dense>
        <textarea
          :id
          v-model="noteDraft"
          rows="2"
          maxlength="4000"
          placeholder="What to remember about this room"
          data-testid="map-note"
          @change="commitNote"
        ></textarea>
      </UiField>
      <p v-else-if="noteDraft" class="ri-note">Note: {{ noteDraft }}</p>
    </section>

    <section v-if="visits.length" class="ri-sec" aria-label="Visits">
      <h4 class="ri-sec__title">Visits</h4>
      <ul class="ri-list">
        <li v-for="v in visits" :key="`${v.session}:${v.seq}`" class="ri-visit">
          <span class="ri-visit__text"
            >{{ v.cause }}<template v-if="v.edge"> ({{ v.edge }})</template>
            <template v-if="v.scoreDelta">
              · score {{ v.scoreDelta > 0 ? "+" : "" }}{{ v.scoreDelta }}</template
            >
            <template v-if="v.gained.length"> · got {{ v.gained.join(", ") }}</template>
            <template v-if="v.lost.length"> · lost {{ v.lost.join(", ") }}</template></span
          >
          <UiIconButton
            v-if="v.history"
            icon="rewind"
            size="sm"
            label="Travel to this visit"
            :data-testid="`map-visit-jump-${v.session}-${v.seq}`"
            @click="jumpToVisit(v.history!)"
          />
        </li>
      </ul>
    </section>

    <div v-if="canPlan || watchTarget" class="ri-more">
      <UiButton
        v-if="watchTarget"
        size="sm"
        variant="ghost"
        icon="play"
        data-testid="map-watch"
        @click="watchFromHere"
      >
        Watch from here<small class="ri-more__detail">{{ watchTarget.label }}</small>
      </UiButton>
      <UiButton
        v-if="canPlan"
        size="sm"
        variant="ghost"
        icon="image"
        data-testid="map-attach-reference"
        @click="openReferenceUpload(node.room)"
      >
        Attach reference art
      </UiButton>
    </div>

    <details class="ri-details" data-testid="map-facts">
      <summary>
        <UiIcon class="ri-details__chevron" name="chevron-right" :size="14" />Details
        <span class="ri-details__summary">{{ facts[0] }}</span>
      </summary>
      <ul class="ri-facts">
        <li v-for="fact in facts" :key="fact">{{ fact }}</li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
/* The Studio inspector's shape: stacked sections on hairlines, small caps
   headings, 32px controls, one filled action. */
.room-inspector {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--ink);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.room-inspector.compact {
  overflow: hidden;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-1);
}
.ri-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-3) 0 var(--space-5);
}
.ri-heading {
  flex: 1;
  min-width: 0;
}
.ri-eyebrow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-mono);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.ri-here {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ok);
  font-family: var(--font-sans);
  letter-spacing: 0;
  text-transform: none;
}
.ri-here__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.ri-title {
  margin: var(--space-0) 0 0;
  overflow-wrap: anywhere;
  font: var(--weight-semibold) var(--text-lg) / var(--leading-tight) var(--font-sans);
}
.ri-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5) 0;
}
.ri-lead {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.ri-thumb {
  width: 320px;
  max-width: calc(100% - 2 * var(--space-5));
  margin: var(--space-3) var(--space-5) 0;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--agi-0);
  image-rendering: pixelated;
}
.room-inspector > .ri-note {
  padding: var(--space-1) var(--space-5) 0;
}
.ri-note {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.ri-sec {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.ri-sec__title {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.ri-list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.ri-exit {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 0 var(--space-2);
}
.ri-exit__icon {
  margin-top: 3px;
  color: var(--ink-3);
}
.ri-exit__main {
  display: grid;
  min-width: 0;
}
.ri-exit__room {
  overflow: hidden;
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ri-exit__name {
  margin-left: var(--space-2);
  color: var(--ink-2);
  font-weight: 400;
}
.ri-exit__how {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.ri-exit__how--observed {
  color: var(--ok);
}
.ri-exit__how--planned {
  color: var(--warn);
}
.ri-exit__note {
  color: var(--ink-2);
  font-size: var(--text-xs);
  font-style: italic;
}
.ri-exit__actions {
  display: flex;
  margin-top: calc(var(--space-2) * -1);
}
.ri-exit__input {
  grid-column: 2 / -1;
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h-sm);
  margin: var(--space-1) 0 var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.ri-exit__input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -1px;
}
.ri-visit {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.ri-visit__text {
  min-width: 0;
}
.ri-more {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-3) 0;
}
.ri-more__detail {
  margin-left: var(--space-2);
  color: var(--ink-3);
  font-weight: 400;
}
.ri-details {
  padding: var(--space-2) var(--space-5) var(--space-4);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.ri-details summary {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-h-sm);
  color: var(--ink-2);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  list-style: none;
}
.ri-details summary::-webkit-details-marker {
  display: none;
}
.ri-details__chevron {
  transition: transform var(--duration-fast) var(--ease-out);
}
.ri-details[open] .ri-details__chevron {
  transform: rotate(90deg);
}
.ri-details__summary {
  margin-left: auto;
  color: var(--ink-3);
  font-weight: 400;
}
.ri-facts {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  padding-left: var(--space-7);
}
.ri-facts li::first-letter {
  text-transform: uppercase;
}
</style>
