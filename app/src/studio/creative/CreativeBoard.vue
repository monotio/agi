<script setup lang="ts">
/**
 * The project reference board: approved entries with their roles, a note, the
 * source's name and a thumbnail. Entries the workspace just kept (kept set)
 * and pending additions render alike; removing a kept entry is a reviewed
 * removal the next Keep publishes. A kept source stays usable — each row can
 * start a new room underlay or sprite preparation from it.
 */
import { computed } from "vue";
import { versionRefKey, type CreativeBoardEntry } from "../../../../src/creative/catalog.ts";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiIconButton from "../../ui/UiIconButton.vue";

export interface BoardPreview {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  /** The source record's provenance title. */
  readonly title: string;
  /** How many kept recipes read this source. */
  readonly recipes: number;
}

const { entries, previews } = defineProps<{
  readonly entries: readonly CreativeBoardEntry[];
  /** identity key → raster, resolved by the workspace (pending or kept). */
  readonly previews: Readonly<Record<string, BoardPreview | null | undefined>>;
}>();
const emit = defineEmits<{
  remove: [entry: CreativeBoardEntry];
  /** Start an underlay or view preparation from this entry's source. */
  "prepare-room": [entry: CreativeBoardEntry];
  "prepare-view": [entry: CreativeBoardEntry];
}>();

const ROLE_LABELS: Record<string, string> = {
  style: "Style",
  composition: "Composition",
  "character-identity": "Actor",
  "exact-source": "Exact source",
};

const rows = computed(() =>
  entries.map((entry) => ({
    entry,
    key: versionRefKey(entry.identity),
    preview: previews[versionRefKey(entry.source)],
    roles: entry.roles.map((role) => ROLE_LABELS[role] ?? role),
  })),
);

/** Paint a thumbnail to its canvas once mounted. */
function thumb(canvas: HTMLCanvasElement | null, preview: BoardPreview | null | undefined): void {
  if (!canvas || !preview) return;
  const image = new ImageData(preview.width, preview.height);
  image.data.set(preview.pixels);
  canvas.width = preview.width;
  canvas.height = preview.height;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
}
</script>

<template>
  <ul v-if="rows.length > 0" class="board" role="list">
    <li v-for="row in rows" :key="row.key" class="board__row" data-testid="board-entry">
      <canvas
        v-if="row.preview"
        :ref="(el) => thumb(el as HTMLCanvasElement | null, row.preview)"
        class="board__thumb"
        aria-hidden="true"
      />
      <span v-else class="board__thumb board__thumb--empty" aria-hidden="true" />
      <span class="board__body">
        <span class="board__title">{{ row.preview?.title ?? "Source" }}</span>
        <span class="board__roles">
          <UiChip v-for="role in row.roles" :key="role">{{ role }}</UiChip>
        </span>
        <span v-if="row.entry.notes !== ''" class="board__notes">{{ row.entry.notes }}</span>
        <span
          v-if="row.preview !== null && row.preview !== undefined && row.preview.recipes > 0"
          class="board__recipes"
        >
          {{ row.preview.recipes }} preparation{{ row.preview.recipes === 1 ? "" : "s" }}
        </span>
      </span>
      <span class="board__actions">
        <UiButton
          size="sm"
          variant="ghost"
          title="Prepare this source as a room trace"
          @click="emit('prepare-room', row.entry)"
          >PICTURE</UiButton
        >
        <UiButton
          size="sm"
          variant="ghost"
          title="Prepare this source as a VIEW"
          @click="emit('prepare-view', row.entry)"
          >VIEW</UiButton
        >
        <UiIconButton
          icon="trash"
          size="sm"
          label="Remove from board"
          @click="emit('remove', row.entry)"
        />
      </span>
    </li>
  </ul>
  <p v-else class="board__empty">Add images to your reference board.</p>
</template>

<style scoped>
.board {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.board__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
}
.board__thumb {
  width: 48px;
  height: 48px;
  object-fit: contain;
  image-rendering: pixelated;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 0 0 / 12px
    12px;
}
.board__thumb--empty {
  border: 1px dashed var(--hairline-strong);
}
.board__body {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}
.board__title {
  color: var(--ink);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}
.board__roles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.board__notes,
.board__recipes {
  color: var(--ink-2);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board__actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.board__empty {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-sm);
}
</style>
