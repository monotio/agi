<script setup lang="ts">
import { computed, onMounted, useTemplateRef, watch } from "vue";
import { wordmarkRaster } from "./wordmark.ts";

/**
 * The boot card: the wordmark as the interpreter would print it, in the
 * engine's own 8×8 font on a black screen, the full stop in the brand's
 * cyan. The canvas holds one pixel per font pixel and CSS scales it by a
 * whole number (--boot-px), so every font pixel stays a crisp square at any
 * device ratio. Colours come from the tokens. It is decoration: the text is
 * the caller's (a heading, a status), so the canvas is hidden from assistive
 * tech. `bare` drops the card's own screen for hosts that already are one.
 */
const { text = "AGI IS HERE.", bare = false } = defineProps<{
  text?: string;
  bare?: boolean;
}>();

/** A one-glyph margin of screen around the line, as a text row has. */
const PAD = 8;
const canvas = useTemplateRef("canvas");
const raster = computed(() => wordmarkRaster(text));
const size = computed(() =>
  bare
    ? { w: raster.value.width, h: raster.value.height }
    : { w: raster.value.width + PAD * 2, h: raster.value.height + PAD * 2 },
);

function paint(): void {
  const el = canvas.value;
  const ctx = el?.getContext("2d");
  if (!el || !ctx) return;
  const style = getComputedStyle(el);
  const ink = style.getPropertyValue("--ink").trim();
  const accent = style.getPropertyValue("--action").trim();
  const { width, height, pixels } = raster.value;
  const offset = bare ? 0 : PAD;
  ctx.clearRect(0, 0, el.width, el.height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixels[y * width + x];
      if (!value) continue;
      ctx.fillStyle = value === 2 ? accent : ink;
      ctx.fillRect(offset + x, offset + y, 1, 1);
    }
  }
}

onMounted(paint);
watch(raster, () => requestAnimationFrame(paint));
</script>

<template>
  <span class="boot-card" :class="{ 'boot-card--bare': bare }">
    <canvas
      ref="canvas"
      class="boot-card__canvas"
      :width="size.w"
      :height="size.h"
      :style="{ '--boot-w': size.w, '--boot-h': size.h }"
      aria-hidden="true"
    ></canvas>
  </span>
</template>

<style scoped>
.boot-card {
  --boot-px: 5;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--agi-0);
  box-shadow: inset 0 0 0 1px var(--surface-sunken);
  line-height: 0;
}
.boot-card--bare {
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
}
.boot-card__canvas {
  display: block;
  width: calc(var(--boot-w) * var(--boot-px) * 1px);
  height: calc(var(--boot-h) * var(--boot-px) * 1px);
  image-rendering: pixelated;
}
@media (max-width: 1100px) {
  .boot-card {
    --boot-px: 4;
  }
}
@media (max-width: 520px) {
  .boot-card {
    --boot-px: 3;
  }
}
</style>
