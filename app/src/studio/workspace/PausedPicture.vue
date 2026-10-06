<script setup lang="ts">
import { useTemplateRef, watchEffect } from "vue";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { createPictureSurface } from "../../../../src/types.ts";
import { renderPicture } from "../../../../src/picture/renderer.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
const { bytes, profile } = defineProps<{ bytes: Uint8Array; profile: AgiProfile }>();
const canvas = useTemplateRef("canvas");
watchEffect(() => {
  const context = canvas.value?.getContext("2d");
  if (!context) return;
  const picture = createPictureSurface();
  renderPicture(bytes, picture, { profile });
  const image = context.createImageData(320, 200);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const colour = y >= 8 && y < 176 ? picture.visual[(y - 8) * 160 + (x >> 1)]! : 0;
      image.data.set([...EGA_PALETTE[colour]!, 255], (y * 320 + x) * 4);
    }
  }
  context.putImageData(image, 0, 0);
});
</script>
<template>
  <div class="workspace-paused-stage" data-testid="workspace-paused-picture">
    <canvas ref="canvas" width="320" height="200" aria-label="Paused room picture"></canvas>
  </div>
</template>
<style scoped>
.workspace-paused-stage {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  min-height: 0;
  display: grid;
  place-items: center;
  background: var(--agi-0);
  container-type: size;
}
canvas {
  width: min(100cqw, 160cqh);
  aspect-ratio: 8 / 5;
  image-rendering: pixelated;
}
@media (max-width: 600px) {
  .workspace-paused-stage {
    grid-column: 1;
  }
}
</style>
