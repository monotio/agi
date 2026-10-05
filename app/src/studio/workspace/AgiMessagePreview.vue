<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch, ref } from "vue";
import {
  TextSurface,
  wrapLines,
  placeWindow,
  drawWindow,
} from "../../../../src/runtime/textSurface.ts";
import { compositeFrame } from "../../render/composite.ts";
import { usePresentation } from "../../play/usePresentation.ts";
import type { AgiStage } from "../../three/AgiStage.ts";
const { text } = defineProps<{ text: string }>();
const canvas = useTemplateRef("canvas");
const presentation = usePresentation();
let stage: AgiStage | null = null;
let fallback: CanvasRenderingContext2D | null = null;
let closed = false;
const ready = ref(false);
let visibility: IntersectionObserver | undefined;
let starting = false;
function render(): void {
  if (!stage && !fallback) return;
  const surface = new TextSurface();
  const lines = wrapLines(text, 30);
  drawWindow(surface, placeWindow(lines, 1), lines, 0xf0, 0xf4);
  const pixels = new Uint8ClampedArray(320 * 200 * 4);
  compositeFrame(
    {
      visual: presentation.lastFrame.value?.visual ?? new Uint8Array(160 * 168),
      text: surface.cells,
      picRow: 1,
    },
    pixels,
  );
  if (stage) {
    stage.render(pixels, true);
    stage.flush();
  } else if (fallback) {
    const frame = fallback.createImageData(320, 200);
    frame.data.set(pixels);
    fallback.putImageData(frame, 0, 0);
  }
  ready.value = true;
}
async function start(): Promise<void> {
  if (starting || stage || fallback || closed) return;
  starting = true;
  const target = canvas.value!;
  const { AgiStage } = await import("../../three/AgiStage.ts");
  // A static message must survive scrolling after WebGL presents its frame.
  const context = target.getContext("webgl2", { preserveDrawingBuffer: true });
  const created = context ? await AgiStage.create(target, context) : null;
  if (closed) {
    created?.dispose();
    return;
  }
  stage = created;
  if (stage) stage.crtAmount = 0;
  else fallback = target.getContext("2d");
  render();
}
onMounted(() => {
  visibility = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting) {
      void start();
      render();
    }
  });
  visibility.observe(canvas.value!);
});
watch(() => text, render);
onBeforeUnmount(() => {
  closed = true;
  visibility?.disconnect();
  stage?.dispose();
});
</script>
<template>
  <canvas
    ref="canvas"
    class="message-preview"
    role="img"
    aria-label="Game message preview"
    :data-ready="ready"
    width="320"
    height="200"
  />
</template>
<style scoped>
.message-preview {
  display: block;
  width: 100%;
  max-width: 480px;
  aspect-ratio: 8 / 5;
  image-rendering: pixelated;
  border-radius: var(--radius);
}
</style>
