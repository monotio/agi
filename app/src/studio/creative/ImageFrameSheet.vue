<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import {
  suggestImageFrames,
  prepareImageCels,
  type ProjectImageInput,
  type ImageFrame,
} from "../../../../src/creative/imageOperations.ts";
import {
  assignFrameLoop,
  drawFrameRegion,
  lockFrameSizes,
  mergeFrameSuggestions,
  moveFrameRegion,
  orderFrameBoxes,
  reorderFrameBoxes,
  resizeFrameRegion,
  type FrameBox,
  type FrameHandle,
} from "../../../../src/creative/imageFrameGeometry.ts";
import type { Rect } from "../../../../src/creative/catalog.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
import UiButton from "../../ui/UiButton.vue";

const props = defineProps<{
  image: ProjectImageInput;
  profile: AgiProfile;
  mirrors: readonly (number | null)[];
}>();
const frames = defineModel<ImageFrame[]>({ required: true });
const boxes = ref<FrameBox[]>([]);
const selected = ref<string[]>([]);
const chosenLoop = ref(0);
const locked = ref(false);
const manualOrder = ref(false);
const suggestion = ref("alpha");
const count = ref(4);
const replace = ref(false);
const zoom = ref<number>();
const fitScale = ref(1);
const notice = ref("");
const viewport = useTemplateRef("viewport");
const surface = useTemplateRef("surface");
const canvas = useTemplateRef("canvas");
const animation = useTemplateRef("animation");
const animated = ref(true);
const tick = ref(0);
let serial = 0;
let observer: ResizeObserver | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const handles: readonly { value: FrameHandle; label: string; x: number; y: number }[] = [
  { value: "nw", label: "northwest", x: 0, y: 0 },
  { value: "n", label: "north", x: 50, y: 0 },
  { value: "ne", label: "northeast", x: 100, y: 0 },
  { value: "e", label: "east", x: 100, y: 50 },
  { value: "se", label: "southeast", x: 100, y: 100 },
  { value: "s", label: "south", x: 50, y: 100 },
  { value: "sw", label: "southwest", x: 0, y: 100 },
  { value: "w", label: "west", x: 0, y: 50 },
];
const directions = ["Right", "Left", "Toward you", "Away", "", "", "", ""];
const colours = [11, 13, 10, 14, 9, 12, 3, 6].map(
  (index) => `rgb(${EGA_PALETTE[index]!.join(" ")})`,
);
const active = computed(() => boxes.value.find((f) => f.id === selected.value.at(-1)));
const scale = computed(() => zoom.value ?? fitScale.value);
const summary = computed(() => {
  const frame = active.value;
  if (!frame) return `${boxes.value.length} frames. Drag on the sheet to mark a frame.`;
  return `Frame ${boxes.value.indexOf(frame) + 1}, loop ${frame.loop}, ${frame.region.width} by ${frame.region.height} at ${frame.region.x}, ${frame.region.y}`;
});
const mirror = computed(() => props.mirrors[chosenLoop.value]);
const preview = computed(() => {
  try {
    return boxes.value.length ? prepareImageCels(props.image, boxes.value, props.profile) : null;
  } catch {
    return null;
  }
});
const previewCel = computed(() => {
  if (!preview.value) return undefined;
  const loops = [...new Set(boxes.value.map((f) => f.loop))].sort((a, b) => a - b);
  const cels = preview.value.input.loops[loops.indexOf(chosenLoop.value)]?.cels;
  return cels?.[tick.value % cels.length];
});
function suggestions() {
  return suggestImageFrames(props.image, suggestion.value === "grid" ? count.value : undefined).map(
    (frame) => ({ ...frame, id: `frame-${serial++}`, edited: false, loop: chosenLoop.value }),
  );
}
watch(
  () => props.image,
  () => {
    boxes.value = suggestions();
    selected.value = boxes.value[0] ? [boxes.value[0].id] : [];
    locked.value = false;
    manualOrder.value = false;
    zoom.value = undefined;
    void nextTick(fit);
  },
  { immediate: true },
);
watch(
  boxes,
  () => {
    frames.value = boxes.value.map(({ region, width, height, loop }) => ({
      region,
      width,
      height,
      loop,
    }));
  },
  { deep: true, immediate: true },
);
watch(active, (frame) => {
  if (frame) chosenLoop.value = frame.loop;
});
watch(
  [canvas, () => props.image],
  () => {
    const target = canvas.value;
    if (!target) return;
    target.width = props.image.width;
    target.height = props.image.height;
    const pixels = new ImageData(target.width, target.height);
    pixels.data.set(props.image.rgba);
    target.getContext("2d")!.putImageData(pixels, 0, 0);
  },
  { flush: "post", immediate: true },
);
watch(
  [animation, previewCel],
  () => {
    const target = animation.value,
      cel = previewCel.value;
    if (!target || !cel) return;
    target.width = cel.width;
    target.height = cel.height;
    const pixels = new ImageData(cel.width, cel.height);
    for (let i = 0; i < cel.pixels.length; i++) {
      const colour = cel.pixels[i]!;
      pixels.data.set([...EGA_PALETTE[colour]!, colour === cel.transparentColor ? 0 : 255], i * 4);
    }
    target.getContext("2d")!.putImageData(pixels, 0, 0);
  },
  { flush: "post", immediate: true },
);
function fit() {
  const target = viewport.value;
  if (target)
    fitScale.value = Math.max(
      0.05,
      Math.min(
        (target.clientWidth - 24) / props.image.width,
        (target.clientHeight - 24) / props.image.height,
      ),
    );
}
onMounted(() => {
  observer = new ResizeObserver(fit);
  if (viewport.value) observer.observe(viewport.value);
  fit();
  timer = setInterval(() => {
    if (animated.value) tick.value++;
  }, 180);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  if (timer) clearInterval(timer);
});
function select(id: string, multiple = false) {
  selected.value = multiple
    ? selected.value.includes(id)
      ? selected.value.filter((value) => value !== id)
      : [...selected.value, id]
    : [id];
}
function focusBox(id: string) {
  void nextTick(() =>
    surface.value
      ?.querySelector<HTMLElement>(`[data-frame-id="${id}"]`)
      ?.focus({ preventScroll: true }),
  );
}
function updateRegion(id: string, region: Rect, resize = false) {
  const previous = boxes.value.find((f) => f.id === id)?.region;
  if (
    previous &&
    previous.x === region.x &&
    previous.y === region.y &&
    previous.width === region.width &&
    previous.height === region.height
  )
    return;
  boxes.value = boxes.value.map((f) =>
    f.id === id
      ? {
          ...f,
          edited: true,
          region,
          width: resize ? Math.min(160, region.width) : f.width,
          height: resize ? Math.min(168, region.height) : f.height,
        }
      : f,
  );
  if (locked.value && resize) boxes.value = lockFrameSizes(boxes.value, region, props.image);
}
function sort() {
  if (!manualOrder.value) boxes.value = orderFrameBoxes(boxes.value);
}
function paint(loop: number) {
  chosenLoop.value = loop;
  boxes.value = assignFrameLoop(boxes.value, selected.value, loop);
  notice.value = selected.value.length
    ? `Assigned ${selected.value.length} frames to loop ${loop}.`
    : `New frames use loop ${loop}.`;
}
function remove() {
  const index = active.value ? boxes.value.indexOf(active.value) : 0;
  boxes.value = boxes.value.filter((f) => !selected.value.includes(f.id));
  const next = boxes.value[Math.min(index, boxes.value.length - 1)];
  selected.value = next ? [next.id] : [];
  if (next) focusBox(next.id);
  else surface.value?.focus();
}
function find() {
  try {
    const size = active.value?.region;
    const next = mergeFrameSuggestions(boxes.value, suggestions(), replace.value);
    boxes.value =
      manualOrder.value && !replace.value
        ? [
            ...boxes.value.filter((f) => next.includes(f)),
            ...next.filter((f) => !boxes.value.includes(f)),
          ]
        : next;
    if (replace.value) manualOrder.value = false;
    if (locked.value && size) boxes.value = lockFrameSizes(boxes.value, size, props.image);
    selected.value = selected.value.filter((id) => boxes.value.some((f) => f.id === id));
    if (!selected.value.length && boxes.value[0]) selected.value = [boxes.value[0].id];
    notice.value = `${boxes.value.length} frames found. ${replace.value ? "Frames replaced." : "Edited frames kept."}`;
    replace.value = false;
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}
function lock() {
  locked.value = !locked.value;
  if (locked.value && active.value)
    boxes.value = lockFrameSizes(boxes.value, active.value.region, props.image);
}
function reorder(source: string, destination: string) {
  boxes.value = reorderFrameBoxes(boxes.value, source, destination);
  manualOrder.value = true;
  select(source);
  focusBox(source);
}
let dragged: string | undefined;
function startOrder(event: DragEvent, id: string) {
  dragged = id;
  event.dataTransfer?.setData("text/plain", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function dropOrder(id: string) {
  if (dragged) reorder(dragged, id);
  dragged = undefined;
}
function orderStep(direction: number) {
  if (!active.value) return;
  const destination = boxes.value[boxes.value.indexOf(active.value) + direction];
  if (destination) reorder(active.value.id, destination.id);
}
interface Gesture {
  id: string;
  mode: "draw" | "move" | FrameHandle;
  start: { x: number; y: number };
  clientStart: { x: number; y: number };
  scale: number;
  region: Rect;
  original: FrameBox[];
}
let gesture: Gesture | undefined;
function point(event: PointerEvent) {
  const rect = surface.value!.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / scale.value,
    y: (event.clientY - rect.top) / scale.value,
  };
}
function begin(event: PointerEvent, frame?: FrameBox, handle?: FrameHandle) {
  if (event.button !== 0) return;
  event.preventDefault();
  const start = point(event),
    original = [...boxes.value];
  if (frame) {
    if (event.shiftKey && !handle) {
      select(frame.id, true);
      return;
    }
    if (!selected.value.includes(frame.id)) select(frame.id);
  } else {
    const region = drawFrameRegion(start, start, props.image, []);
    frame = {
      id: `frame-${serial++}`,
      edited: true,
      region,
      width: 1,
      height: 1,
      loop: chosenLoop.value,
    };
    boxes.value = [...boxes.value, frame];
    select(frame.id);
  }
  gesture = {
    id: frame.id,
    mode: handle ?? (original.includes(frame) ? "move" : "draw"),
    start,
    clientStart: { x: event.clientX, y: event.clientY },
    scale: scale.value,
    region: frame.region,
    original,
  };
  surface.value?.setPointerCapture(event.pointerId);
  focusBox(frame.id);
}
function move(event: PointerEvent) {
  if (!gesture) return;
  const { start, region, mode, id, original, clientStart, scale: gestureScale } = gesture;
  const dx = (event.clientX - clientStart.x) / gestureScale;
  const dy = (event.clientY - clientStart.y) / gestureScale;
  const end = { x: start.x + dx, y: start.y + dy };
  const peers = original.filter((f) => f.id !== id);
  if (mode === "move") updateRegion(id, moveFrameRegion(region, dx, dy, props.image));
  else {
    let next =
      mode === "draw"
        ? drawFrameRegion(start, end, props.image, peers)
        : resizeFrameRegion(region, mode, dx, dy, props.image, peers);
    if (mode === "draw" && locked.value && peers[0]) {
      const { width, height } = peers[0].region;
      next = {
        width,
        height,
        x: Math.min(next.x, props.image.width - width),
        y: Math.min(next.y, props.image.height - height),
      };
    }
    updateRegion(id, next, true);
  }
}
function end(event: PointerEvent) {
  if (!gesture) return;
  move(event);
  const id = gesture.id;
  gesture = undefined;
  if (surface.value?.hasPointerCapture(event.pointerId))
    surface.value.releasePointerCapture(event.pointerId);
  sort();
  focusBox(id);
}
function cancel(event: PointerEvent) {
  if (!gesture) return;
  boxes.value = gesture.original;
  gesture = undefined;
  selected.value = selected.value.filter((id) => boxes.value.some((f) => f.id === id));
  if (surface.value?.hasPointerCapture(event.pointerId))
    surface.value.releasePointerCapture(event.pointerId);
}
function key(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (target.matches("input, select, summary") || event.metaKey || event.ctrlKey) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    remove();
    return;
  }
  if (/^[0-7]$/.test(event.key)) {
    event.preventDefault();
    paint(Number(event.key));
    return;
  }
  const frame = active.value;
  if (!frame || !event.key.startsWith("Arrow")) return;
  event.preventDefault();
  const amount = event.shiftKey ? frame.region.width : 1;
  const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
  const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
  updateRegion(
    frame.id,
    event.altKey
      ? resizeFrameRegion(frame.region, dx ? "e" : "s", dx, dy, props.image, [])
      : moveFrameRegion(frame.region, dx, dy, props.image),
    event.altKey,
  );
  sort();
  focusBox(frame.id);
}
function detail(event: Event, field: keyof Rect | "celWidth" | "celHeight") {
  const frame = active.value;
  if (!frame) return;
  const value = Math.round(Number((event.target as HTMLInputElement).value));
  if (!Number.isFinite(value)) return;
  if (field === "celWidth" || field === "celHeight") {
    const dimension = field === "celWidth" ? "width" : "height";
    boxes.value = boxes.value.map((f) =>
      f.id === frame.id || locked.value
        ? {
            ...f,
            edited: true,
            [dimension]: Math.max(1, Math.min(dimension === "width" ? 160 : 168, value)),
          }
        : f,
    );
  } else {
    const region = { ...frame.region, [field]: value };
    region.width = Math.max(1, Math.min(region.width, props.image.width));
    region.height = Math.max(1, Math.min(region.height, props.image.height));
    region.x = Math.max(0, Math.min(region.x, props.image.width - region.width));
    region.y = Math.max(0, Math.min(region.y, props.image.height - region.height));
    updateRegion(frame.id, region, field === "width" || field === "height");
    sort();
  }
}
function regionStyle(frame: FrameBox) {
  return {
    left: `${frame.region.x * scale.value}px`,
    top: `${frame.region.y * scale.value}px`,
    width: `${frame.region.width * scale.value}px`,
    height: `${frame.region.height * scale.value}px`,
    "--loop-colour": colours[frame.loop],
  };
}
function thumbnailStyle(frame: FrameBox) {
  const thumbScale = Math.min(54 / frame.region.width, 40 / frame.region.height);
  return {
    width: `${props.image.width * thumbScale}px`,
    height: `${props.image.height * thumbScale}px`,
    transform: `translate(${-frame.region.x * thumbScale}px, ${-frame.region.y * thumbScale}px)`,
  };
}
const imageUrl = computed(() => {
  const target = document.createElement("canvas");
  target.width = props.image.width;
  target.height = props.image.height;
  const pixels = new ImageData(target.width, target.height);
  pixels.data.set(props.image.rgba);
  target.getContext("2d")!.putImageData(pixels, 0, 0);
  return target.toDataURL();
});
</script>

<template>
  <div class="frame-editor" @keydown.stop="key" @keyup.stop @keypress.stop>
    <div class="frame-toolbar">
      <label
        >Find
        <select v-model="suggestion" aria-label="Frame detection">
          <option value="alpha">Alpha strips</option>
          <option value="grid">Grid</option>
        </select></label
      >
      <label v-if="suggestion === 'grid'"
        >Count
        <input
          v-model.number="count"
          aria-label="Grid frame count"
          type="number"
          min="1"
          :max="image.width"
      /></label>
      <UiButton size="sm" @click="find">Find frames</UiButton>
      <label><input v-model="replace" type="checkbox" /> Replace edited frames</label>
    </div>
    <div class="frame-toolbar">
      <UiButton
        size="sm"
        :aria-pressed="zoom === undefined"
        @click="
          zoom = undefined;
          fit();
        "
        >Fit</UiButton
      >
      <UiButton size="sm" aria-label="Zoom out" @click="zoom = Math.max(0.05, scale / 1.5)"
        >−</UiButton
      >
      <span>{{ Math.round(scale * 100) }}%</span>
      <UiButton size="sm" aria-label="Zoom in" @click="zoom = Math.min(64, scale * 1.5)"
        >+</UiButton
      >
      <UiButton
        size="sm"
        :aria-pressed="locked"
        :disabled="!active"
        :title="active ? 'Applies the frame size to every box' : 'Select a frame to lock its size'"
        aria-label="Lock frame size"
        @click="lock"
        >{{ active ? `${active.region.width} × ${active.region.height}` : "Frame size" }} ·
        {{ locked ? "Locked" : "Free" }}</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        :disabled="!selected.length"
        :title="selected.length ? 'Delete selected frames' : 'Select a frame to delete'"
        @click="remove"
        >Delete frame</UiButton
      >
    </div>
    <div class="frame-loops" role="group" aria-label="Assign loop">
      <button
        v-for="(direction, loop) in directions"
        :key="loop"
        type="button"
        :aria-label="`Loop ${loop}${direction ? ` ${direction}` : ''}`"
        :aria-pressed="chosenLoop === loop"
        :style="{ '--loop-colour': colours[loop] }"
        :title="
          mirrors[loop] != null
            ? `${VOCABULARY.mirrorLoop.label} of loop ${mirrors[loop]}. ${VOCABULARY.mirrorLoop.help}`
            : VOCABULARY.loop.help
        "
        @click="paint(loop)"
      >
        <i aria-hidden="true"></i><span>{{ loop }} {{ direction }}</span
        ><span v-if="mirrors[loop] != null" aria-hidden="true">⇋ {{ mirrors[loop] }}</span>
      </button>
    </div>
    <p v-if="mirror != null" class="frame-hint">
      Loop {{ chosenLoop }} is a {{ VOCABULARY.mirrorLoop.label }} of loop {{ mirror }}. Adding cels
      gives it its own cels.
    </p>
    <div ref="viewport" class="frame-viewport">
      <div
        ref="surface"
        class="frame-surface"
        data-testid="frame-sheet"
        role="group"
        aria-label="Image frames: drag to draw, arrows to move, Alt and arrows to resize"
        tabindex="0"
        :style="{ width: `${image.width * scale}px`, height: `${image.height * scale}px` }"
        @pointerdown.self="begin($event)"
        @pointermove="move"
        @pointerup="end"
        @pointercancel="cancel"
      >
        <canvas ref="canvas" aria-hidden="true" />
        <div
          v-for="(frame, index) in boxes"
          :key="frame.id"
          class="frame-box"
          :class="{ 'is-selected': selected.includes(frame.id) }"
          :style="regionStyle(frame)"
          data-testid="image-frame"
        >
          <div
            class="frame-box__body"
            role="button"
            tabindex="0"
            :data-frame-id="frame.id"
            :aria-label="`Frame ${index + 1}`"
            :aria-pressed="selected.includes(frame.id)"
            @focus="selected.includes(frame.id) || select(frame.id)"
            @pointerdown.stop="begin($event, frame)"
            @keydown.enter.prevent="select(frame.id, $event.shiftKey)"
            @keydown.space.prevent="select(frame.id, $event.shiftKey)"
          >
            <span>{{ index + 1 }}</span>
          </div>
          <button
            v-for="handle in selected.includes(frame.id) ? handles : []"
            :key="handle.value"
            class="frame-handle"
            type="button"
            tabindex="-1"
            :aria-label="`Resize frame ${index + 1} ${handle.label}`"
            :style="{ left: `${handle.x}%`, top: `${handle.y}%`, cursor: `${handle.value}-resize` }"
            @pointerdown.stop="begin($event, frame, handle.value)"
          ></button>
        </div>
      </div>
    </div>
    <p class="frame-hint">
      Drag to mark · Shift-click to select · Arrows to move · Alt + arrows to resize · 0–7 for loops
    </p>
    <div class="frame-strip" role="group" aria-label="Frame order: drag thumbnails to reorder">
      <button
        v-for="(frame, index) in boxes"
        :key="frame.id"
        class="frame-thumbnail"
        type="button"
        draggable="true"
        :aria-label="`Select frame ${index + 1} in order strip`"
        :aria-pressed="selected.includes(frame.id)"
        :style="{ '--loop-colour': colours[frame.loop] }"
        @click="select(frame.id, $event.shiftKey)"
        @dragstart.stop="startOrder($event, frame.id)"
        @dragend="dragged = undefined"
        @dragover.prevent.stop
        @drop.prevent.stop="dropOrder(frame.id)"
      >
        <span class="frame-thumbnail__image"
          ><img :src="imageUrl" alt="" draggable="false" :style="thumbnailStyle(frame)" /></span
        ><span>{{ index + 1 }} · Loop {{ frame.loop }}</span>
      </button>
    </div>
    <div class="frame-toolbar">
      <UiButton
        size="sm"
        variant="ghost"
        :disabled="!active || boxes[0]?.id === active.id"
        :title="
          !active
            ? 'Select a frame to reorder'
            : boxes[0]?.id === active.id
              ? 'This frame is first'
              : 'Move this frame earlier'
        "
        @click="orderStep(-1)"
        >Move earlier</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        :disabled="!active || boxes.at(-1)?.id === active.id"
        :title="
          !active
            ? 'Select a frame to reorder'
            : boxes.at(-1)?.id === active.id
              ? 'This frame is last'
              : 'Move this frame later'
        "
        @click="orderStep(1)"
        >Move later</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        @click="
          manualOrder = false;
          boxes = orderFrameBoxes(boxes);
        "
        >Reading order</UiButton
      >
    </div>
    <div class="frame-bottom">
      <details v-if="active" class="frame-details">
        <summary>Details</summary>
        <div class="frame-detail-fields">
          <label v-for="field in ['x', 'y', 'width', 'height'] as const" :key="field"
            >{{ field
            }}<input
              type="number"
              :aria-label="`Selected frame ${field}`"
              :value="active.region[field]"
              :min="field === 'width' || field === 'height' ? 1 : 0"
              :max="field === 'x' || field === 'width' ? image.width : image.height"
              @change="detail($event, field)"
          /></label>
          <label
            >Cel width<input
              type="number"
              min="1"
              max="160"
              :value="active.width"
              @change="detail($event, 'celWidth')"
          /></label>
          <label
            >Cel height<input
              type="number"
              min="1"
              max="168"
              :value="active.height"
              @change="detail($event, 'celHeight')"
          /></label>
        </div>
      </details>
      <div class="frame-animation" role="group" aria-label="Animation preview">
        <canvas
          v-show="previewCel"
          ref="animation"
          role="img"
          :aria-label="`Loop ${chosenLoop} animation`"
          :style="
            previewCel
              ? {
                  width: `${previewCel.width * 2 * Math.min(3, 56 / previewCel.height)}px`,
                  height: `${previewCel.height * Math.min(3, 56 / previewCel.height)}px`,
                }
              : {}
          "
        />
        <UiButton
          size="sm"
          variant="ghost"
          :aria-pressed="animated"
          @click="animated = !animated"
          >{{ animated ? "Pause animation" : "Play animation" }}</UiButton
        >
      </div>
    </div>
    <p
      class="frame-summary"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="frame-summary"
    >
      {{ summary }}
    </p>
    <p v-if="notice" class="frame-hint" role="status">{{ notice }}</p>
  </div>
</template>

<style scoped>
.frame-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}
.frame-toolbar,
.frame-loops,
.frame-bottom,
.frame-animation {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.frame-toolbar label {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
input[type="number"] {
  width: 56px;
}
input,
select {
  background: var(--surface-sunken);
  color: var(--ink);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1);
}
.frame-loops {
  gap: var(--space-1);
}
.frame-loops button {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink-2);
  font-size: var(--text-xs);
  cursor: pointer;
}
.frame-loops button[aria-pressed="true"] {
  color: var(--ink);
  border-color: var(--loop-colour);
}
.frame-loops i {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-sm);
  background: var(--loop-colour);
}
.frame-viewport {
  height: clamp(180px, 30vh, 340px);
  flex-shrink: 0;
  overflow: auto;
  display: grid;
  place-items: safe center;
  background: var(--surface-sunken);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  padding: 12px;
}
.frame-surface {
  position: relative;
  flex-shrink: 0;
  touch-action: none;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-sunken) 0% 50%) 0 0 /
    16px 16px;
}
.frame-surface > canvas {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  pointer-events: none;
  display: block;
}
.frame-box {
  position: absolute;
  border: 1px solid var(--loop-colour);
  box-sizing: border-box;
  background: color-mix(in srgb, var(--loop-colour) 10%, transparent);
}
.frame-box.is-selected {
  border-width: 2px;
  background: color-mix(in srgb, var(--loop-colour) 18%, transparent);
}
.frame-box__body {
  position: absolute;
  inset: 0;
  cursor: move;
}
.frame-box__body span {
  position: absolute;
  top: 2px;
  left: 2px;
  background: var(--loop-colour);
  color: var(--surface-sunken);
  font-size: var(--text-xs);
  font-weight: var(--weight-bold);
  line-height: 1;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
  pointer-events: none;
}
.frame-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--surface-sunken);
  background: var(--loop-colour);
  border-radius: var(--radius-sm);
  padding: 0;
}
.frame-hint,
.frame-summary {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.frame-strip {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  flex-shrink: 0;
  padding: var(--space-1);
}
.frame-thumbnail {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  gap: var(--space-1);
  border: 1px solid var(--hairline);
  border-bottom: 3px solid var(--loop-colour);
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  padding: var(--space-1);
  font-size: var(--text-xs);
  cursor: grab;
}
.frame-thumbnail[aria-pressed="true"] {
  outline: 1px solid var(--loop-colour);
  color: var(--ink);
}
.frame-thumbnail__image {
  width: 54px;
  height: 40px;
  display: block;
  overflow: hidden;
  background: var(--surface-sunken);
}
.frame-thumbnail img {
  display: block;
  max-width: none;
  image-rendering: pixelated;
  pointer-events: none;
}
.frame-bottom {
  justify-content: space-between;
  align-items: start;
}
.frame-details {
  flex: 1;
}
.frame-details summary {
  cursor: pointer;
  font-size: var(--text-xs);
  padding: var(--space-2) 0;
}
.frame-detail-fields {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.frame-detail-fields label {
  display: grid;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.frame-animation {
  min-height: 56px;
}
.frame-animation canvas {
  image-rendering: pixelated;
  background: var(--surface-sunken);
}
button:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
</style>
