<script setup lang="ts">
import { onMounted, useTemplateRef, ref } from "vue";
import { createStarterProject } from "../../../src/authoring/starterProject.ts";
import { openContainer } from "../../../src/container/container.ts";
import { createPictureSurface, SCREEN_WIDTH, SCREEN_HEIGHT } from "../../../src/types.ts";
import { renderPicture } from "../../../src/picture/renderer.ts";
import { DEFAULT_V2_PROFILE } from "../../../src/runtime/profile.ts";
import { EGA_PALETTE } from "../render/palette.ts";

const { kind } = defineProps<{ kind: "starter" | "boilerplate" }>();
const canvas = useTemplateRef("canvas");
const rendered = ref(false);
onMounted(() => {
  const context = canvas.value?.getContext("2d");
  if (!context) return;
  const bytes = openContainer(new Map(createStarterProject(kind).files())).getResource(
    "picture",
    1,
  );
  if (!bytes) return;
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile: DEFAULT_V2_PROFILE });
  const image = context.createImageData(SCREEN_WIDTH * 2, SCREEN_HEIGHT);
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const rgb = EGA_PALETTE[surface.visual[y * SCREEN_WIDTH + x]!]!;
      for (let dx = 0; dx < 2; dx++) {
        const i = (y * SCREEN_WIDTH * 2 + x * 2 + dx) * 4;
        image.data[i] = rgb[0];
        image.data[i + 1] = rgb[1];
        image.data[i + 2] = rgb[2];
        image.data[i + 3] = 255;
      }
    }
  }
  context.putImageData(image, 0, 0);
  rendered.value = true;
});
</script>

<template>
  <canvas
    ref="canvas"
    width="320"
    height="168"
    aria-hidden="true"
    :data-testid="`template-picture-${kind}`"
    :data-rendered="rendered"
  />
</template>

<style scoped>
canvas {
  width: 100%;
  aspect-ratio: 320 / 168;
  display: block;
  image-rendering: pixelated;
}
</style>
