<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch, watchEffect } from "vue";
import { openContainer } from "../../../../src/container/container.ts";
import { renderPicture } from "../../../../src/picture/renderer.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { probeActor } from "../../../../src/studio/probe.ts";
import type { SpriteCel } from "../../../../src/view/spriteDocument.ts";
import { createPictureSurface, SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../../src/types.ts";
import { forEachPaintedPixel, type ViewCel } from "../../../../src/view/view.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
import type { SpriteRoom } from "../../shell/useCreateWorkspace.ts";

/**
 * The edited cel standing in one of the rooms that use the view: the room's
 * picture rendered by the engine's renderer, the cel placed by the engine's
 * own blit with its baseline band's priority (src/studio/probe.ts, the same
 * probe as Room Studio's ghost actor), so pixels the room's priority hides
 * show hidden, and the footprint's control verdict. Drag, click or the
 * arrow keys move it; the room picker lists the rooms that use the view.
 */
const {
  rooms,
  files,
  profile,
  cel,
  priorityBase = undefined,
} = defineProps<{
  rooms: readonly SpriteRoom[];
  files: ReadonlyMap<string, Uint8Array>;
  profile: AgiProfile;
  cel: SpriteCel;
  priorityBase?: number | undefined;
}>();

const room = shallowRef(rooms[0]?.room);
watch(
  () => rooms,
  (next) => {
    if (!next.some((entry) => entry.room === room.value)) room.value = next[0]?.room;
  },
);
const entry = computed(() => rooms.find((candidate) => candidate.room === room.value));
const x = shallowRef(70);
const baselineY = shallowRef(120);

/** The room's picture, rendered once per picture. */
const picture = computed(() => {
  const number = entry.value?.picture;
  if (number === undefined) return null;
  try {
    const bytes = openContainer(new Map(files)).getResource("picture", number);
    if (!bytes) return null;
    const surface = createPictureSurface();
    renderPicture(bytes, surface, { profile });
    return surface;
  } catch {
    return null;
  }
});

const viewCel = computed<ViewCel>(() => ({
  width: cel.width,
  height: cel.height,
  transparentColor: cel.transparent,
  pixels: cel.pixels,
  mirrored: false,
}));

function clamp(): void {
  x.value = Math.min(Math.max(x.value, 0), Math.max(0, SCREEN_WIDTH - cel.width));
  baselineY.value = Math.min(Math.max(baselineY.value, cel.height - 1), SCREEN_HEIGHT - 1);
}
watch(() => [cel.width, cel.height], clamp, { immediate: true });

const result = computed(() => {
  const surface = picture.value;
  if (!surface) return null;
  return probeActor({
    picture: surface,
    cel: viewCel.value,
    x: x.value,
    baselineY: baselineY.value,
    priority: "band",
    priorityBase,
    profile,
  });
});

const CONTROL_WORDS = ["a barrier", "a conditional barrier", "a signal line", "water"];
const verdict = computed(() => {
  const r = result.value;
  if (!r) return null;
  const drawn = r.drawnMask.reduce((sum, value) => sum + value, 0);
  const hidden = r.hiddenMask.reduce((sum, value) => sum + value, 0);
  const cover =
    hidden === 0
      ? "fully visible"
      : `${hidden} of ${drawn + hidden} pixels behind the room's priority`;
  const touched = r.controlHits.map((hit) => CONTROL_WORDS[hit.value]!);
  const footing =
    touched.length === 0
      ? "the feet stand on open floor"
      : `the feet touch ${touched.join(" and ")}${r.footprint.accepted ? "" : ": the game would not let it stand here"}`;
  return {
    priority: `Priority ${r.drawPriority} at y ${baselineY.value}`,
    cover,
    footing,
    hidden,
  };
});

const canvas = useTemplateRef("canvas");
watchEffect(
  () => {
    const target = canvas.value;
    const surface = picture.value;
    if (!target || !surface) return;
    target.width = SCREEN_WIDTH * 2;
    target.height = SCREEN_HEIGHT;
    const context = target.getContext("2d")!;
    const image = context.createImageData(SCREEN_WIDTH * 2, SCREEN_HEIGHT);
    const put = (cell: number, color: number, alpha: number) => {
      const [r, g, b] = EGA_PALETTE[color & 0x0f]!;
      for (const half of [0, 1]) {
        // Each picture cell is two canvas pixels wide.
        const o = (cell * 2 + half) * 4;
        image.data[o] = image.data[o]! * (1 - alpha) + r * alpha;
        image.data[o + 1] = image.data[o + 1]! * (1 - alpha) + g * alpha;
        image.data[o + 2] = image.data[o + 2]! * (1 - alpha) + b * alpha;
        image.data[o + 3] = 255;
      }
    };
    for (let cell = 0; cell < surface.visual.length; cell++) put(cell, surface.visual[cell]!, 1);
    const r = result.value;
    if (r)
      forEachPaintedPixel(surface, viewCel.value, x.value, baselineY.value, 15, (cell, color) =>
        put(cell, color, r.hiddenMask[cell] === 1 ? 0.3 : 1),
      );
    context.putImageData(image, 0, 0);
  },
  { flush: "post" },
);

/** Stand the cel with its feet at the pressed cell. */
function place(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const cx = Math.floor(((event.clientX - rect.left) / rect.width) * SCREEN_WIDTH);
  const cy = Math.floor(((event.clientY - rect.top) / rect.height) * SCREEN_HEIGHT);
  x.value = cx - Math.floor(cel.width / 2);
  baselineY.value = cy;
  clamp();
}
function onDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  place(event);
}
function onMove(event: PointerEvent): void {
  if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) place(event);
}
/** Arrows move the cel 1 px (Shift: 8): the keyboard way to place it. */
function onKey(event: KeyboardEvent): void {
  const step: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const move = step[event.key];
  if (!move) return;
  event.preventDefault();
  const far = event.shiftKey ? 8 : 1;
  x.value += move[0] * far;
  baselineY.value += move[1] * far;
  clamp();
}
</script>

<template>
  <section
    class="room-preview"
    aria-labelledby="room-preview-title"
    data-testid="sprite-room-preview"
  >
    <header class="room-preview__head">
      <h3 id="room-preview-title">In room</h3>
      <select
        v-if="rooms.length > 1"
        v-model.number="room"
        aria-label="Room"
        data-testid="sprite-room-picker"
      >
        <option v-for="option in rooms" :key="option.room" :value="option.room">
          Room {{ option.room }}{{ option.title ? ` · ${option.title}` : "" }}
        </option>
      </select>
      <span v-else-if="entry">Room {{ entry.room }}</span>
      <span class="room-preview__tag">real priority</span>
    </header>
    <template v-if="picture && verdict">
      <canvas
        ref="canvas"
        class="room-preview__canvas"
        tabindex="0"
        role="img"
        :aria-label="`The cel in room ${entry?.room} at x ${x}, y ${baselineY}. ${verdict.priority}, ${verdict.cover}; ${verdict.footing}. Arrow keys move it.`"
        :data-x="x"
        :data-y="baselineY"
        :data-hidden="verdict.hidden"
        data-testid="sprite-room-canvas"
        @pointerdown="onDown"
        @pointermove="onMove"
        @keydown="onKey"
      ></canvas>
      <p class="room-preview__verdict" data-testid="sprite-room-verdict">
        <b>{{ verdict.priority }}</b> · {{ verdict.cover }}; {{ verdict.footing }}.
      </p>
    </template>
    <p v-else class="room-preview__empty">
      No room that uses this view draws a picture to stand it in.
    </p>
  </section>
</template>

<style scoped>
.room-preview {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--hairline);
}
.room-preview__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.room-preview__head h3 {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.room-preview__head select {
  height: var(--control-h-sm);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-2);
  font: var(--text-xs) var(--font-sans);
}
.room-preview__head span {
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.room-preview__head .room-preview__tag {
  margin-left: auto;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.room-preview__canvas {
  width: 100%;
  aspect-ratio: 320 / 168;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  cursor: crosshair;
  image-rendering: pixelated;
  touch-action: none;
}
.room-preview__canvas:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.room-preview__verdict,
.room-preview__empty {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-xs);
}
</style>
