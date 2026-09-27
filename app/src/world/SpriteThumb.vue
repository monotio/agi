<script setup lang="ts">
import { computed, useTemplateRef, watchEffect } from "vue";
import type { SpriteCel } from "../../../src/view/spriteDocument.ts";
import { celRgba } from "../palette.ts";

/**
 * One cel drawn small with AGI's 2:1 pixels at the largest whole zoom that
 * fits the box (never below 1:1 rows), transparent pixels left clear.
 */
const {
  cel,
  width,
  height,
  label = undefined,
} = defineProps<{
  cel: SpriteCel;
  /** The box in CSS pixels. */
  width: number;
  height: number;
  label?: string | undefined;
}>();

const canvas = useTemplateRef("canvas");
const zoom = computed(() =>
  Math.max(1, Math.floor(Math.min(width / (cel.width * 2), height / cel.height))),
);

watchEffect(
  () => {
    const target = canvas.value;
    if (!target) return;
    target.width = cel.width;
    target.height = cel.height;
    const image = new ImageData(cel.width, cel.height);
    celRgba(cel, image.data);
    target.getContext("2d")!.putImageData(image, 0, 0);
  },
  { flush: "post" },
);
</script>

<template>
  <canvas
    ref="canvas"
    class="sprite-thumb"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    :style="{ width: `${cel.width * 2 * zoom}px`, height: `${cel.height * zoom}px` }"
  ></canvas>
</template>

<style scoped>
.sprite-thumb {
  display: block;
  image-rendering: pixelated;
}
</style>
