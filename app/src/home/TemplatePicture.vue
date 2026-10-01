<script setup lang="ts">
import { onMounted, useTemplateRef, ref } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import starterThumbnail from "./starter-thumbnail.png";
import boilerplateThumbnail from "./boilerplate-thumbnail.png";

const { kind } = defineProps<{ kind: "starter" | "boilerplate" | "blank" }>();
const canvas = useTemplateRef("canvas");
const rendered = ref(false);
const height = kind === "boilerplate" ? 200 : 168;

// Cached template pixels keep the interpreter and compiler off the Home path.
// app/test/home-thumbnail-fixture.ts renders the cache from real project resources.
onMounted(async () => {
  const element = canvas.value;
  const context = element?.getContext("2d");
  if (!element || !context) return;
  if (kind === "blank") {
    const style = getComputedStyle(element);
    context.fillStyle = style.getPropertyValue("--surface-0");
    context.fillRect(0, 0, 320, 168);
    context.strokeStyle = style.getPropertyValue("--hairline");
    context.beginPath();
    for (let x = 32; x < 320; x += 32) {
      context.moveTo(x + 0.5, 1);
      context.lineTo(x + 0.5, 167);
    }
    for (let y = 16; y < 168; y += 16) {
      context.moveTo(1, y + 0.5);
      context.lineTo(319, y + 0.5);
    }
    context.stroke();
    context.strokeStyle = style.getPropertyValue("--hairline-strong");
    context.strokeRect(0.5, 0.5, 319, 167);
    context.strokeStyle = style.getPropertyValue("--ink-3");
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(154, 84);
    context.lineTo(166, 84);
    context.moveTo(160, 78);
    context.lineTo(160, 90);
    context.stroke();
  } else {
    const image = new Image();
    image.src = kind === "starter" ? starterThumbnail : boilerplateThumbnail;
    await image.decode();
    context.drawImage(image, 0, 0);
  }
  rendered.value = true;
});
</script>

<template>
  <span class="template-art" :class="{ 'template-art-game': kind !== 'blank' }" aria-hidden="true">
    <canvas
      ref="canvas"
      width="320"
      :height
      :data-testid="`template-picture-${kind}`"
      :data-rendered="rendered"
    />
    <span v-if="kind !== 'blank'" class="game-mark"><UiIcon name="gamepad" :size="16" /></span>
  </span>
</template>

<style scoped>
.template-art {
  aspect-ratio: 320 / 168;
  display: block;
  position: relative;
  background: var(--surface-0);
}
.template-art-game {
  background: var(--agi-0);
}
canvas {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  image-rendering: pixelated;
}
.game-mark {
  position: absolute;
  left: var(--space-3);
  bottom: var(--space-3);
  padding: var(--space-1);
  color: var(--ink-2);
  background: var(--surface-overlay);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
</style>
