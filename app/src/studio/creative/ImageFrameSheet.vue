<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import {
  suggestImageFrames,
  prepareImageCels,
  scaleImageFrame,
  type ProjectImageInput,
  type ImageFrame,
} from "../../../../src/creative/imageOperations.ts";
import {
  assignFrameLoop,
  drawFrameRegion,
  linkFoundFrames,
  resizeLinkedFrameBoxes,
  toggleFrameLink,
  mergeFrameSuggestions,
  moveFrameRegion,
  orderFrameBoxes,
  reorderFrameBoxes,
  type FrameBox,
  type FrameHandle,
} from "../../../../src/creative/imageFrameGeometry.ts";
import type { Rect } from "../../../../src/creative/catalog.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
import UiButton from "../../ui/UiButton.vue";

const props = defineProps<{
  image: ProjectImageInput;
  profile: AgiProfile;
  mirrors: readonly (number | null)[];
  loopHeights: readonly number[];
  name: string;
  background: readonly [number, number, number] | null;
}>();
const frames = defineModel<ImageFrame[]>({ required: true });
const boxes = ref<FrameBox[]>([]);
const selected = ref<string[]>([]);
const chosenLoop = ref(0);
const celHeight = ref(props.loopHeights[0] ?? 24);
const maximumHeight = computed(() =>
  Math.max(
    1,
    Math.min(168, ...boxes.value.map((f) => Math.floor((160 * f.region.height) / f.region.width))),
  ),
);
const manualOrder = ref(false);
const suggestion = ref("gaps");
const count = ref(4);

const zoom = ref<number>();
const fitScale = ref(1);
const notice = ref("");
const editor = useTemplateRef("editor");
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
const directions = ["Walk right", "Walk left", "Toward you", "Away"];
const loopChoices = computed(() =>
  Array.from({ length: Math.max(4, props.mirrors.length, chosenLoop.value + 1) }, (_, i) => i),
);
function loopName(loop: number): string {
  const name = directions[loop] ?? "Loop";
  const mirror = props.mirrors[loop];
  return `${name} · loop ${loop}${mirror != null ? ` (mirrors ${directions[mirror]?.toLowerCase() ?? `loop ${mirror}`})` : ""}`;
}
const colours = [11, 13, 10, 14, 9, 12, 3, 6].map(
  (index) => `rgb(${EGA_PALETTE[index]!.join(" ")})`,
);
const active = computed(() => boxes.value.find((f) => f.id === selected.value.at(-1)));
const scale = computed(() => zoom.value ?? fitScale.value);
const summary = computed(() => {
  const frame = active.value;
  if (!frame) return `${boxes.value.length} frames. Drag on the sheet to mark a frame.`;
  return `Frame ${boxes.value.indexOf(frame) + 1} · ${frame.region.width} × ${frame.region.height} at ${frame.region.x}, ${frame.region.y}`;
});
const linkLabel = computed(() =>
  active.value?.linked
    ? `⛓ ${boxes.value.filter((f) => f.linked).length} frames · same size`
    : `Frame ${active.value ? boxes.value.indexOf(active.value) + 1 : 1} unlinked`,
);
const preview = computed(() => {
  try {
    return boxes.value.length
      ? prepareImageCels(
          props.image,
          boxes.value.map((f) => ({ ...f, ...scaleImageFrame(f.region, celHeight.value) })),
          props.profile,
          props.background,
        )
      : null;
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
  const found = suggestImageFrames(
    props.image,
    suggestion.value === "grid" ? count.value : undefined,
  ).map((frame) => ({
    ...frame,
    ...scaleImageFrame(frame.region, celHeight.value),
    id: `frame-${serial++}`,
    edited: false,
    loop: chosenLoop.value,
  }));
  return linkFoundFrames(found, props.image);
}
watch(
  () => props.image,
  () => {
    boxes.value = suggestions();
    selected.value = boxes.value[0] ? [boxes.value[0].id] : [];
    manualOrder.value = false;
    zoom.value = undefined;
    void nextTick(fit);
  },
  { immediate: true },
);
watch(
  [boxes, celHeight],
  () => {
    celHeight.value = Math.max(1, Math.min(maximumHeight.value, celHeight.value || 1));
    frames.value = boxes.value.map(({ region, loop }) => ({
      region,
      loop,
      ...scaleImageFrame(region, celHeight.value),
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
function updateRegion(id: string, region: Rect) {
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
          ...scaleImageFrame(region, celHeight.value),
        }
      : f,
  );
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
  if (boxes.value.some((f) => f.edited) && !window.confirm("Replace the edited frame boxes?"))
    return;
  try {
    boxes.value = mergeFrameSuggestions(boxes.value, suggestions(), true);
    manualOrder.value = false;
    selected.value = boxes.value[0] ? [boxes.value[0].id] : [];
    notice.value = `${boxes.value.length} frames found.`;
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}
function link() {
  if (!active.value) return;
  try {
    boxes.value = toggleFrameLink(boxes.value, active.value.id, props.image);
  } catch (error) {
    notice.value = String(error);
  }
}
function destination(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const loop =
    value === "new"
      ? Math.min(7, Math.max(4, props.mirrors.length, chosenLoop.value + 1))
      : Number(value);
  chosenLoop.value = loop;
  boxes.value = assignFrameLoop(
    boxes.value,
    boxes.value.map((f) => f.id),
    loop,
  );
  celHeight.value = props.loopHeights[loop] ?? 24;
}
function reorder(source: string, destination: string) {
  boxes.value = reorderFrameBoxes(boxes.value, source, destination);
  manualOrder.value = true;
  select(source);
  void nextTick(() =>
    editor.value
      ?.querySelector<HTMLElement>(`[data-order-id="${source}"]`)
      ?.focus({ preventScroll: true }),
  );
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
      linked: false,
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
  else if (mode === "draw") updateRegion(id, drawFrameRegion(start, end, props.image, peers));
  else boxes.value = resizeLinkedFrameBoxes(original, id, mode, dx, dy, props.image);
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
  if (/^[0-3]$/.test(event.key)) {
    event.preventDefault();
    paint(Number(event.key));
    return;
  }
  const frame = active.value;
  if (!frame || !event.key.startsWith("Arrow")) return;
  if (
    event.altKey &&
    target.closest(".frame-strip") &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    orderStep(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  event.preventDefault();
  const amount = event.shiftKey ? frame.region.width : 1;
  const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
  const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
  if (event.altKey)
    boxes.value = resizeLinkedFrameBoxes(
      boxes.value,
      frame.id,
      dx ? "e" : "s",
      dx,
      dy,
      props.image,
    );
  else updateRegion(frame.id, moveFrameRegion(frame.region, dx, dy, props.image));
  sort();
  focusBox(frame.id);
}
function detail(event: Event, field: keyof Rect) {
  const frame = active.value;
  if (!frame) return;
  const value = Math.round(Number((event.target as HTMLInputElement).value));
  if (!Number.isFinite(value)) return;
  if (field === "width" || field === "height") {
    boxes.value = resizeLinkedFrameBoxes(
      boxes.value,
      frame.id,
      field === "width" ? "e" : "s",
      field === "width" ? value - frame.region.width : 0,
      field === "height" ? value - frame.region.height : 0,
      props.image,
    );
  } else
    updateRegion(
      frame.id,
      moveFrameRegion(
        frame.region,
        field === "x" ? value - frame.region.x : 0,
        field === "y" ? value - frame.region.y : 0,
        props.image,
      ),
    );
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
const thumbnails = computed(() => {
  const prepared = preview.value;
  if (!prepared) return [];
  const loops = [...new Set(boxes.value.map((f) => f.loop))].sort((a, b) => a - b);
  const counts: Record<string, number> = {};
  return boxes.value.map((frame) => {
    const index = counts[frame.loop] ?? 0;
    counts[frame.loop] = index + 1;
    const cel = prepared.input.loops[loops.indexOf(frame.loop)]!.cels![index]!;
    const target = document.createElement("canvas");
    target.width = cel.width;
    target.height = cel.height;
    const pixels = new ImageData(cel.width, cel.height);
    for (let i = 0; i < cel.pixels.length; i++) {
      const colour = cel.pixels[i]!;
      pixels.data.set([...EGA_PALETTE[colour]!, colour === cel.transparentColor ? 0 : 255], i * 4);
    }
    target.getContext("2d")!.putImageData(pixels, 0, 0);
    return target.toDataURL();
  });
});
</script>

<template>
  <div ref="editor" class="frame-editor" @keydown.stop="key" @keyup.stop @keypress.stop>
    <div class="frame-main">
      <div class="frame-sheet-area">
        <UiButton
          class="frame-link"
          size="sm"
          :aria-pressed="active?.linked ?? false"
          :disabled="!active"
          :title="active ? 'Click to unlink or relink this frame' : 'Select a frame to link'"
          aria-label="Link selected frame"
          @click="link"
          >{{ linkLabel }}</UiButton
        >
        <div class="frame-find">
          <UiButton size="sm" @click="find">Find frames again</UiButton>
          <details class="frame-find-menu">
            <summary aria-label="Frame finding options">▾</summary>
            <div>
              <label><input v-model="suggestion" type="radio" value="gaps" />By gaps</label>
              <label><input v-model="suggestion" type="radio" value="grid" />Grid</label>
              <label v-if="suggestion === 'grid'"
                >Count<input
                  v-model.number="count"
                  type="number"
                  aria-label="Grid frame count"
                  min="1"
                  :max="image.width"
              /></label>
            </div>
          </details>
        </div>
        <div class="frame-zoom">
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
          <UiButton size="sm" aria-label="Zoom in" @click="zoom = Math.min(64, scale * 1.5)"
            >+</UiButton
          >
        </div>
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
                :style="{
                  left: `${handle.x}%`,
                  top: `${handle.y}%`,
                  cursor: `${handle.value}-resize`,
                }"
                @pointerdown.stop="begin($event, frame, handle.value)"
              ></button>
            </div>
          </div>
        </div>
      </div>
      <aside class="frame-preview">
        <strong>Animation</strong>
        <div class="frame-animation" role="group" aria-label="Animation preview">
          <canvas
            v-show="previewCel"
            ref="animation"
            role="img"
            :aria-label="`Loop ${chosenLoop} animation`"
            :style="
              previewCel
                ? { width: `${previewCel.width * 2}px`, height: `${previewCel.height}px` }
                : {}
            "
          />
        </div>
        <label class="frame-size"
          >Size
          <span class="frame-stepper">
            <button
              type="button"
              aria-label="Smaller cels"
              @click="celHeight = Math.max(1, celHeight - 1)"
            >
              −
            </button>
            <input
              v-model.number="celHeight"
              type="number"
              aria-label="Cel height"
              min="1"
              :max="maximumHeight"
            />
            <button
              type="button"
              aria-label="Taller cels"
              @click="celHeight = Math.min(maximumHeight, celHeight + 1)"
            >
              +
            </button>
          </span>
          px tall · like {{ name }}</label
        >
        <slot name="preview" />
        <UiButton
          size="sm"
          variant="ghost"
          :aria-pressed="animated"
          @click="animated = !animated"
          >{{ animated ? "Pause animation" : "Play animation" }}</UiButton
        >
        <p class="frame-hint">Drag a box to adjust it. Drag on empty space to add one.</p>
        <details v-if="active" class="frame-details">
          <summary>
            <span data-testid="frame-summary" role="status" aria-live="polite">{{ summary }}</span>
          </summary>
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
          </div>
        </details>
      </aside>
    </div>
    <div class="frame-strip" role="group" aria-label="Frame order: drag thumbnails to reorder">
      <div v-for="(frame, index) in boxes" :key="frame.id" class="frame-strip-item">
        <button
          class="frame-thumbnail"
          type="button"
          draggable="true"
          :data-order-id="frame.id"
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
            ><img
              v-if="thumbnails[index]"
              :src="thumbnails[index]"
              alt=""
              draggable="false"
              data-testid="prepared-cel-thumbnail"
          /></span>
          <span>{{ index + 1 }}</span>
        </button>
        <button
          class="frame-thumbnail__remove"
          type="button"
          :aria-label="`Remove frame ${index + 1}`"
          @focus="select(frame.id)"
          @click.stop="
            select(frame.id);
            remove();
          "
        >
          ×
        </button>
      </div>
    </div>
    <p class="frame-hint">Drag to reorder · Delete removes</p>
    <div class="frame-add">
      <label
        >Add to
        <select aria-label="Add to loop" :value="chosenLoop" @change="destination">
          <option v-for="loop in loopChoices" :key="loop" :value="loop">
            {{ loopName(loop) }}
          </option>
          <option v-if="loopChoices.length < 8" value="new">A new loop</option>
        </select></label
      >
      <slot name="commit" />
    </div>
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
.frame-viewport {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
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
  position: relative;
}
.frame-thumbnail[aria-pressed="true"] {
  outline: 1px solid var(--loop-colour);
  color: var(--ink);
}
.frame-thumbnail__image {
  width: 40px;
  height: 48px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--surface-sunken);
}
.frame-thumbnail img {
  display: block;
  max-width: 100%;
  max-height: 48px;
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
  min-height: 120px;
  width: 100%;
  justify-content: center;
  background: var(--surface-sunken);
}
.frame-animation canvas {
  image-rendering: pixelated;
  background: var(--surface-sunken);
}
.frame-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  flex: 1;
  min-height: 0;
  gap: var(--space-3);
}
.frame-sheet-area {
  position: relative;
  min-height: 240px;
}
.frame-link,
.frame-find,
.frame-zoom {
  position: absolute;
  z-index: 2;
  background: var(--surface-1);
  border-radius: var(--radius);
}
.frame-link {
  left: 10px;
  top: 10px;
}
.frame-find {
  left: 10px;
  bottom: 10px;
  display: flex;
}
.frame-zoom {
  right: 10px;
  bottom: 10px;
  display: flex;
}
.frame-find-menu summary {
  padding: var(--space-2);
  cursor: pointer;
  list-style: none;
}
.frame-find-menu > div {
  position: absolute;
  bottom: 100%;
  left: 0;
  background: var(--surface-1);
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  display: grid;
  gap: var(--space-2);
  min-width: 100px;
}
.frame-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
}
.frame-preview > strong {
  align-self: start;
  font-size: var(--text-sm);
}
.frame-size {
  font-size: var(--text-xs);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.frame-stepper {
  display: flex;
  align-items: center;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.frame-stepper input {
  width: 30px;
  border: 0;
  padding: 0;
  text-align: center;
  appearance: textfield;
}
.frame-stepper input::-webkit-inner-spin-button {
  appearance: none;
}
.frame-stepper button {
  background: none;
  border: 0;
  color: var(--ink-2);
  cursor: pointer;
  padding: var(--space-1);
}
.frame-strip-item {
  position: relative;
  flex-shrink: 0;
}
.frame-thumbnail__remove {
  color: var(--ink-2);
  border: 1px solid var(--hairline);
  cursor: pointer;
  position: absolute;
  right: -3px;
  top: -3px;
  padding: 0 var(--space-1);
  background: var(--surface-3);
  border-radius: var(--radius);
  opacity: 0;
}
.frame-strip-item:hover .frame-thumbnail__remove,
.frame-strip-item:focus-within .frame-thumbnail__remove {
  opacity: 1;
}
.frame-add {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
  border-top: 1px solid var(--hairline);
  padding-top: var(--space-2);
}
.frame-add label {
  font-size: var(--text-xs);
}
@media (max-width: 900px) {
  .frame-main {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }
  .frame-sheet-area {
    min-height: 300px;
  }
}
button:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
</style>
