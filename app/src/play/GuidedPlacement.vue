<script setup lang="ts">
import { computed, ref, useTemplateRef, onMounted } from "vue";
import { guidedPlacement, dockPicturePoint } from "./guidedPlacement.ts";
import { celRgba } from "../render/palette.ts";
import { watchEffect } from "vue";
import UiButton from "../ui/UiButton.vue";
const { picRow } = defineProps<{ picRow: number }>();
const root = useTemplateRef("root");
const ghost = useTemplateRef("ghost");
onMounted(() => root.value?.focus({ preventScroll: true }));
const dragging = ref(false);
let anchor: { x: number; y: number } | undefined;
let pointer: number | undefined;
const pointStyle = computed(() => {
  const value = guidedPlacement.value;
  const cel = value?.cel;
  return value
    ? {
        left: `${(value.x / 160) * 100}%`,
        top: `${((picRow * 8 + value.y + 1) / 200) * 100}%`,
        width: `${((cel?.width ?? 6) / 160) * 100}%`,
        height: `${((cel?.height ?? 12) / 200) * 100}%`,
      }
    : {};
});
const boxStyle = computed(() => {
  const box = guidedPlacement.value?.box;
  return box
    ? {
        left: `${(box.x1 / 160) * 100}%`,
        top: `${((picRow * 8 + box.y1) / 200) * 100}%`,
        width: `${((box.x2 - box.x1 + 1) / 160) * 100}%`,
        height: `${((box.y2 - box.y1 + 1) / 200) * 100}%`,
      }
    : {};
});
watchEffect(
  () => {
    const canvas = ghost.value;
    const cel = guidedPlacement.value?.cel;
    if (!canvas || !cel) return;
    canvas.width = cel.width;
    canvas.height = cel.height;
    const image = new ImageData(cel.width, cel.height);
    celRgba(cel, image.data);
    canvas.getContext("2d")?.putImageData(image, 0, 0);
  },
  { flush: "post" },
);
function move(event: PointerEvent): void {
  const value = guidedPlacement.value;
  const rect = root.value?.getBoundingClientRect();
  if (!value || !dragging.value || !rect || event.pointerId !== pointer) return;
  const point = dockPicturePoint(event.clientX, event.clientY, rect, picRow);
  guidedPlacement.value =
    value.kind === "hero"
      ? { ...value, ...point }
      : {
          ...value,
          box: {
            x1: Math.min(anchor!.x, point.x),
            y1: Math.min(anchor!.y, point.y),
            x2: Math.max(anchor!.x, point.x),
            y2: Math.max(anchor!.y, point.y),
          },
        };
}
function down(event: PointerEvent): void {
  if (event.button !== 0 || dragging.value) return;
  const rect = root.value!.getBoundingClientRect();
  anchor = dockPicturePoint(event.clientX, event.clientY, rect, picRow);
  pointer = event.pointerId;
  root.value!.setPointerCapture(pointer);
  dragging.value = true;
  move(event);
  event.preventDefault();
}
function up(event: PointerEvent): void {
  if (event.pointerId !== pointer) return;
  move(event);
  dragging.value = false;
  pointer = undefined;
}
function finish(): void {
  const value = guidedPlacement.value;
  guidedPlacement.value = undefined;
  value?.done(value);
}
function cancel(): void {
  const value = guidedPlacement.value;
  guidedPlacement.value = undefined;
  value?.cancel();
}
function keys(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  } else if (event.key === "Enter") {
    event.preventDefault();
    finish();
  } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    const value = guidedPlacement.value!;
    const dx = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
    const dy = Number(event.key === "ArrowDown") - Number(event.key === "ArrowUp");
    if (value.kind === "hero")
      guidedPlacement.value = {
        ...value,
        x: Math.max(0, Math.min(159, value.x + dx)),
        y: Math.max(0, Math.min(167, value.y + dy)),
      };
    else if (
      value.box.x1 + dx >= 0 &&
      value.box.x2 + dx <= 159 &&
      value.box.y1 + dy >= 0 &&
      value.box.y2 + dy <= 167
    )
      guidedPlacement.value = {
        ...value,
        box: {
          x1: value.box.x1 + dx,
          x2: value.box.x2 + dx,
          y1: value.box.y1 + dy,
          y2: value.box.y2 + dy,
        },
      };
  }
}
</script>
<template>
  <div
    ref="root"
    class="guided-placement"
    tabindex="0"
    role="group"
    :aria-label="guidedPlacement?.label"
    data-testid="guided-placement"
    @pointerdown.stop="down"
    @pointermove.stop="move"
    @pointerup.stop="up"
    @pointercancel.stop="up"
    @lostpointercapture="dragging = false"
    @click.stop
    @keydown.stop="keys"
  >
    <img
      v-if="guidedPlacement?.background"
      :src="guidedPlacement.background"
      alt="Destination room"
      class="placement-room"
      :style="{ top: `${picRow * 4}%` }"
    />
    <canvas
      v-if="guidedPlacement?.kind === 'hero' && guidedPlacement.cel"
      ref="ghost"
      class="placement-ghost"
      :style="pointStyle"
    />
    <span
      v-else-if="guidedPlacement?.kind === 'hero'"
      class="placement-ghost placement-mark"
      :style="pointStyle"
      >✚</span
    >
    <span v-else class="placement-box" :style="boxStyle" />
    <div class="placement-controls" @pointerdown.stop @click.stop>
      <span>{{ guidedPlacement?.label }}</span>
      <UiButton size="sm" @click="finish">Done</UiButton>
      <UiButton size="sm" variant="ghost" @click="cancel">Cancel</UiButton>
    </div>
  </div>
</template>
<style scoped>
.guided-placement {
  position: absolute;
  inset: 0;
  z-index: 4;
  touch-action: none;
  cursor: crosshair;
  outline: 2px solid var(--action);
}
.placement-room {
  position: absolute;
  left: 0;
  width: 100%;
  height: 84%;
  image-rendering: pixelated;
}
.placement-ghost {
  position: absolute;
  transform: translateY(-100%);
  opacity: 0.7;
  image-rendering: pixelated;
  pointer-events: none;
}
.placement-mark {
  color: var(--action);
}
.placement-box {
  position: absolute;
  border: 2px solid var(--action);
  background: var(--action-soft);
  box-sizing: border-box;
  pointer-events: none;
}
.placement-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-2);
  color: var(--ink);
  font-size: var(--text-sm);
  cursor: default;
}
</style>
