<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch, ref } from "vue";
import {
  TextSurface,
  attr,
  windowLines,
  placePrintWindow,
  printWindowLayout,
  stampWindow,
} from "../../../../src/runtime/textSurface.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { compositeFrame } from "../../render/composite.ts";
import { usePresentation } from "../../play/usePresentation.ts";
import type { AgiStage } from "../../three/AgiStage.ts";
const { text, profile } = defineProps<{ text: string; profile: AgiProfile }>();
const preview = useTemplateRef("preview");
const canvas = useTemplateRef("canvas");
const flatCanvas = useTemplateRef("flatCanvas");
// A canvas committed to WebGL has no 2D context, so a renderer that fails after
// WebGL started draws its fallback on a second canvas.
const flat = ref(false);
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
  const layout = printWindowLayout(profile);
  const lines = windowLines(text, 30, layout.maxLines);
  stampWindow(
    surface,
    placePrintWindow(lines, layout.displayBase, layout.geometry),
    lines,
    attr(0, 15),
  );
  const pixels = new Uint8ClampedArray(320 * 200 * 4);
  compositeFrame(
    {
      appearance: presentation.appearance,
      visual: presentation.lastFrame.value?.visual ?? new Uint8Array(160 * 168),
      text: surface.cells,
      windowOverlay: surface.overlay,
      picRow: layout.displayBase,
    },
    pixels,
  );
  if (stage) {
    try {
      stage.render(pixels, true);
      ready.value = true;
      return;
    } catch {
      useFallback();
    }
  }
  if (fallback) {
    const frame = fallback.createImageData(320, 200);
    frame.data.set(pixels);
    fallback.putImageData(frame, 0, 0);
  }
  ready.value = true;
}
function useFallback(): void {
  stage?.dispose();
  stage = null;
  flat.value = true;
  fallback = flatCanvas.value?.getContext("2d") ?? null;
}
async function start(): Promise<void> {
  if (starting || stage || fallback || closed) return;
  starting = true;
  try {
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
    if (stage) {
      stage.crtAmount = 0;
      // A lost GPU context or device leaves the preview on the flat canvas, as in Play.
      stage.onLost = () => {
        if (stage !== created) return;
        useFallback();
        render();
      };
    } else useFallback();
  } catch {
    if (closed) return;
    useFallback();
  }
  render();
}
onMounted(() => {
  visibility = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting) {
      void start();
      render();
    }
  });
  visibility.observe(preview.value!);
});
watch(() => text, render);
watch(() => presentation.look.value, render);
watch(() => [profile.windowFrameGeometry, profile.presentation], render);
onBeforeUnmount(() => {
  closed = true;
  visibility?.disconnect();
  stage?.dispose();
});
</script>
<template>
  <div
    ref="preview"
    class="message-preview"
    role="img"
    aria-label="Game message preview"
    :data-ready="ready"
  >
    <canvas
      v-show="!flat"
      ref="canvas"
      aria-label="Game message preview"
      width="320"
      height="200"
    />
    <canvas v-show="flat" ref="flatCanvas" width="320" height="200" />
  </div>
</template>
<style scoped>
.message-preview {
  display: block;
  width: 100%;
  max-width: 480px;
  aspect-ratio: var(--game-aspect, 8 / 5);
  image-rendering: pixelated;
  border-radius: var(--radius);
  overflow: hidden;
}
.message-preview canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
