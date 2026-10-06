<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import UiPanel from "../ui/UiPanel.vue";
import UiSelect from "../ui/UiSelect.vue";
import type { PlacementSpot, RoomPlacement } from "../../../src/authoring/roomPlacements.ts";

/**
 * The Views list: every figure the room's entry draws, as a legend for the
 * canvas overlay. A figure set with fixed numbers drags on the canvas and
 * edits that line as a draft; one computed at run time drags a preview
 * instead, with Reset and Copy position; a conditional one picks its preview
 * spot from the places the room may use. Every row's Set in opens the line
 * that places it.
 */
const {
  figures,
  previews = {},
  readOnly,
} = defineProps<{
  figures: readonly RoomPlacement[];
  /** Previewed spots for computed or conditional placements, by object. */
  previews?: Readonly<Record<number, { x: number; y: number }>>;
  readOnly: boolean;
}>();
const emit = defineEmits<{
  preview: [figure: RoomPlacement, x: number, y: number];
  reset: [figure: RoomPlacement];
  copy: [figure: RoomPlacement, x: number, y: number];
  reveal: [figure: RoomPlacement];
}>();

/** The spot a figure stands at now: the preview first, then its line. */
function spotOf(figure: RoomPlacement): { x: number | null; y: number | null } {
  return previews[figure.object] ?? figure;
}
function spotText(figure: RoomPlacement): string {
  const spot = spotOf(figure);
  return spot.x === null || spot.y === null
    ? (figure.reason ?? "Position is chosen at run time")
    : `${spot.x}, ${spot.y}`;
}
function spotKey(spot: PlacementSpot): string {
  return `${spot.x},${spot.y},${spot.offset}`;
}
/** The dropdown's current value: the spot the figure stands at, or "" for none. */
function spotValue(figure: RoomPlacement): string {
  const at = spotOf(figure);
  const match = figure.spots.find((spot) => spot.x === at.x && spot.y === at.y);
  return match ? spotKey(match) : "";
}
function pick(figure: RoomPlacement, key: string): void {
  const spot = figure.spots.find((spot) => spotKey(spot) === key);
  if (spot) emit("preview", figure, spot.x, spot.y);
}
</script>

<template>
  <UiPanel title="Views" flush class="views-panel" data-testid="views-panel">
    <ul class="views-panel__list">
      <li v-for="figure in figures" :key="figure.object" class="views-panel__row">
        <header class="views-panel__head">
          <b class="views-panel__name">o{{ figure.object }} · VIEW {{ figure.view ?? "?" }}</b>
          <span
            class="views-panel__spot"
            :data-previewed="previews[figure.object] ? '' : undefined"
          >
            {{ spotText(figure) }}
          </span>
        </header>
        <p v-if="figure.reason" class="views-panel__why">{{ figure.reason }}</p>
        <div class="views-panel__actions">
          <UiSelect
            v-if="figure.reason !== null && figure.spots.length > 1"
            :model-value="spotValue(figure)"
            size="sm"
            :disabled="readOnly"
            :aria-label="`Spot for o${figure.object}`"
            data-testid="view-spot"
            @update:model-value="pick(figure, String($event))"
          >
            <option value="" disabled>Choose a spot</option>
            <option v-for="spot in figure.spots" :key="spotKey(spot)" :value="spotKey(spot)">
              {{ spot.x }}, {{ spot.y }} · {{ spot.command }}
            </option>
          </UiSelect>
          <template v-if="figure.reason !== null">
            <UiButton
              v-if="previews[figure.object]"
              size="sm"
              variant="ghost"
              :disabled="readOnly"
              :title="readOnly ? 'The room is read-only right now.' : undefined"
              data-testid="view-reset"
              @click="emit('reset', figure)"
              >Reset</UiButton
            >
            <UiButton
              v-if="spotOf(figure).x !== null && spotOf(figure).y !== null"
              size="sm"
              variant="ghost"
              :disabled="readOnly"
              :title="readOnly ? 'The room is read-only right now.' : undefined"
              data-testid="view-copy"
              @click="emit('copy', figure, spotOf(figure).x!, spotOf(figure).y!)"
              >Copy position</UiButton
            >
          </template>
          <UiButton
            v-if="figure.offset >= 0"
            size="sm"
            variant="ghost"
            data-testid="view-set-in"
            @click="emit('reveal', figure)"
            >Set in LOGIC {{ figure.logic }}</UiButton
          >
        </div>
      </li>
      <li v-if="figures.length === 0" class="views-panel__empty">
        The room's entry draws no figures.
      </li>
    </ul>
  </UiPanel>
</template>

<style scoped>
.views-panel__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.views-panel__row {
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.views-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.views-panel__name {
  font-weight: var(--weight-medium);
}
.views-panel__spot {
  color: var(--ink-3);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.views-panel__spot[data-previewed] {
  color: var(--action);
}
.views-panel__why {
  margin: var(--space-1) 0 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.views-panel__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.views-panel__empty {
  padding: var(--space-4) var(--space-5);
  color: var(--ink-3);
}
</style>
