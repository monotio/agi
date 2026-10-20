<script setup lang="ts">
import { sha256Hex } from "../../../../src/crypto.ts";
import { frameTask } from "../../ui/frameTask.ts";
import UiIcon from "../../ui/UiIcon.vue";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import {
  suggestImageCels,
  prepareImageCels,
  scaleImageCel,
  type ProjectImageInput,
  type ImageCel,
} from "../../../../src/creative/imageOperations.ts";
import {
  assignCelLoop,
  drawCelRegion,
  linkFoundCels,
  resizeLinkedCelBoxes,
  toggleCelLink,
  mergeCelSuggestions,
  moveCelRegion,
  orderCelBoxes,
  reorderCelBoxes,
  type CelBox,
  type CelHandle,
} from "../../../../src/creative/imageCelGeometry.ts";
import type { Rect } from "../../../../src/creative/catalog.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { paletteCss, useGamePalette, useGamePaletteLook } from "../../render/useGamePalette.ts";
import UiButton from "../../ui/UiButton.vue";

const props = defineProps<{
  image: ProjectImageInput;
  profile: AgiProfile;
  mirrors: readonly (number | null)[];
  loopHeights: readonly number[];
  name: string;
  background: readonly [number, number, number] | null;
  backgroundTransparent: boolean;
}>();
const emit = defineEmits<{ prepared: [value: ReturnType<typeof prepareImageCels> | null] }>();
const cels = defineModel<ImageCel[]>({ required: true });
const sourceId = computed(() => sha256Hex(props.image.rgba));
const boxes = ref<CelBox[]>([]);
const dragFrame = frameTask();
let gesture: Gesture | undefined;
const gesturing = ref(false);
const outline = shallowRef<{ id: string; region: Rect }>();
const settledBoxes = shallowRef<CelBox[]>([]);
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
const animationPanel = useTemplateRef("animationPanel");
const animationWidth = ref(0);
const animated = ref(true);
const tick = ref(0);
let serial = 0;
let observer: ResizeObserver | undefined;
let fitRaf: number | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const handles: readonly { value: CelHandle; label: string; x: number; y: number }[] = [
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
const palette = useGamePalette();
const gameLook = useGamePaletteLook();
const colours = computed(() =>
  [11, 13, 10, 14, 9, 12, 3, 6].map((index) => paletteCss(palette.value, index)),
);
const active = computed(() => boxes.value.find((f) => f.id === selected.value.at(-1)));
const scale = computed(() => zoom.value ?? fitScale.value);
const summary = computed(() => {
  const cel = active.value;
  if (!cel) return `${boxes.value.length} cels. Drag on the sheet to mark a cel.`;
  return `Cel ${boxes.value.indexOf(cel) + 1} · ${cel.region.width} × ${cel.region.height} at ${cel.region.x}, ${cel.region.y}`;
});
const linkLabel = computed(() =>
  active.value?.linked
    ? `⛓ ${boxes.value.filter((f) => f.linked).length} cels · same size`
    : `Cel ${active.value ? boxes.value.indexOf(active.value) + 1 : 1} unlinked`,
);
const preview = computed(() => {
  try {
    return settledBoxes.value.length
      ? prepareImageCels(
          props.image,
          settledBoxes.value.map((f) => ({ ...f, ...scaleImageCel(f.region, celHeight.value) })),
          props.profile,
          props.background,
          props.backgroundTransparent,
          { sourceId: sourceId.value, look: gameLook.value },
        )
      : null;
  } catch {
    return null;
  }
});
watch(preview, (value) => emit("prepared", value), { immediate: true, flush: "post" });
const previewCel = computed(() => {
  if (!preview.value) return undefined;
  const loops = [...new Set(settledBoxes.value.map((f) => f.loop))].sort((a, b) => a - b);
  const cels = preview.value.input.loops[loops.indexOf(chosenLoop.value)]?.cels;
  return cels?.[tick.value % cels.length];
});
const animationScale = computed(() => {
  const cels = preview.value?.input.loops.flatMap((loop) => loop.cels ?? []) ?? [];
  const width = Math.max(1, ...cels.map((cel) => cel.width * 2));
  return Math.max(1, Math.floor(animationWidth.value / width));
});
function suggestions() {
  const found = suggestImageCels(
    props.image,
    suggestion.value === "grid" ? count.value : undefined,
  ).map((cel) => ({
    ...cel,
    ...scaleImageCel(cel.region, celHeight.value),
    id: `cel-${serial++}`,
    edited: false,
    loop: chosenLoop.value,
  }));
  return linkFoundCels(found, props.image);
}
watch(
  () => props.image,
  () => {
    dragFrame.cancel();
    gesture = undefined;
    outline.value = undefined;
    gesturing.value = false;
    boxes.value = suggestions();
    selected.value = boxes.value[0] ? [boxes.value[0].id] : [];
    manualOrder.value = false;
    zoom.value = undefined;
    void nextTick(fit);
  },
  { immediate: true },
);
watch(
  [boxes, celHeight, gesturing],
  () => {
    if (gesturing.value) return;
    settledBoxes.value = boxes.value;
    celHeight.value = Math.max(1, Math.min(maximumHeight.value, celHeight.value || 1));
    cels.value = boxes.value.map(({ region, loop }) => ({
      region,
      loop,
      ...scaleImageCel(region, celHeight.value),
    }));
  },
  { deep: true, immediate: true },
);
watch(active, (cel) => {
  if (cel) chosenLoop.value = cel.loop;
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
  [animation, previewCel, palette],
  () => {
    const target = animation.value,
      cel = previewCel.value;
    if (!target || !cel) return;
    target.width = cel.width;
    target.height = cel.height;
    const pixels = new ImageData(cel.width, cel.height);
    for (let i = 0; i < cel.pixels.length; i++) {
      const colour = cel.pixels[i]!;
      pixels.data.set(
        [...palette.value[colour]!, colour === cel.transparentColor ? 0 : 255],
        i * 4,
      );
    }
    target.getContext("2d")!.putImageData(pixels, 0, 0);
  },
  { flush: "post", immediate: true },
);
function fit() {
  animationWidth.value = animationPanel.value?.clientWidth ?? 0;
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
  observer = new ResizeObserver(() => {
    // Measure on the next frame: fitting changes the preview's height and
    // must finish outside the current resize notification cycle.
    if (fitRaf !== undefined) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = undefined;
      fit();
    });
  });
  if (viewport.value) observer.observe(viewport.value);
  if (animationPanel.value) observer.observe(animationPanel.value);
  fit();
  timer = setInterval(() => {
    if (animated.value && !gesturing.value) tick.value++;
  }, 180);
});
onBeforeUnmount(() => {
  dragFrame.cancel();
  observer?.disconnect();
  if (fitRaf !== undefined) cancelAnimationFrame(fitRaf);
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
      ?.querySelector<HTMLElement>(`[data-cel-id="${id}"]`)
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
          ...scaleImageCel(region, celHeight.value),
        }
      : f,
  );
}
function sort() {
  if (!manualOrder.value) boxes.value = orderCelBoxes(boxes.value);
}
function paint(loop: number) {
  chosenLoop.value = loop;
  boxes.value = assignCelLoop(boxes.value, selected.value, loop);
  notice.value = selected.value.length
    ? `Assigned ${selected.value.length} cels to loop ${loop}.`
    : `New cels use loop ${loop}.`;
}
function remove() {
  cancel();
  const index = active.value ? boxes.value.indexOf(active.value) : 0;
  boxes.value = boxes.value.filter((f) => !selected.value.includes(f.id));
  const next = boxes.value[Math.min(index, boxes.value.length - 1)];
  selected.value = next ? [next.id] : [];
  if (next) focusBox(next.id);
  else surface.value?.focus();
}
function find() {
  if (boxes.value.some((f) => f.edited) && !window.confirm("Replace the edited cel boxes?")) return;
  try {
    boxes.value = mergeCelSuggestions(boxes.value, suggestions(), true);
    manualOrder.value = false;
    selected.value = boxes.value[0] ? [boxes.value[0].id] : [];
    notice.value = `${boxes.value.length} cels found.`;
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}
function link() {
  if (!active.value) return;
  try {
    boxes.value = toggleCelLink(boxes.value, active.value.id, props.image);
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
  boxes.value = assignCelLoop(
    boxes.value,
    boxes.value.map((f) => f.id),
    loop,
  );
  celHeight.value = props.loopHeights[loop] ?? 24;
}
function reorder(source: string, destination: string) {
  boxes.value = reorderCelBoxes(boxes.value, source, destination);
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
  pointer: number;
  mode: "draw" | "move" | CelHandle;
  start: { x: number; y: number };
  clientStart: { x: number; y: number };
  scale: number;
  region: Rect;
  original: CelBox[];
}
function point(event: PointerEvent) {
  const rect = surface.value!.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / scale.value,
    y: (event.clientY - rect.top) / scale.value,
  };
}
function begin(event: PointerEvent, cel?: CelBox, handle?: CelHandle) {
  if (event.button !== 0 || gesture) return;
  event.preventDefault();
  const start = point(event),
    original = [...boxes.value];
  if (cel) {
    if (event.shiftKey && !handle) {
      select(cel.id, true);
      return;
    }
    if (!selected.value.includes(cel.id)) select(cel.id);
  } else {
    const region = drawCelRegion(start, start, props.image, []);
    cel = {
      id: `cel-${serial++}`,
      edited: true,
      linked: false,
      region,
      width: 1,
      height: 1,
      loop: chosenLoop.value,
    };
    boxes.value = [...boxes.value, cel];
    select(cel.id);
  }
  gesturing.value = true;
  gesture = {
    id: cel.id,
    pointer: event.pointerId,
    mode: handle ?? (original.includes(cel) ? "move" : "draw"),
    start,
    clientStart: { x: event.clientX, y: event.clientY },
    scale: scale.value,
    region: cel.region,
    original,
  };
  surface.value?.setPointerCapture(event.pointerId);
  focusBox(cel.id);
}
function move(event: PointerEvent) {
  if (gesture?.pointer === event.pointerId) dragFrame.schedule(() => applyMove(event));
}
function applyMove(event: PointerEvent, commit = false) {
  if (!gesture) return;
  const { start, region, mode, id, original, clientStart, scale: gestureScale } = gesture;
  const dx = (event.clientX - clientStart.x) / gestureScale;
  const dy = (event.clientY - clientStart.y) / gestureScale;
  const end = { x: start.x + dx, y: start.y + dy };
  const peers = original.filter((f) => f.id !== id);
  let next: Rect;
  if (mode === "move") next = moveCelRegion(region, dx, dy, props.image);
  else if (mode === "draw") next = drawCelRegion(start, end, props.image, peers);
  else {
    const resized = resizeLinkedCelBoxes(original, id, mode, dx, dy, props.image);
    next = resized.find((f) => f.id === id)!.region;
    if (commit) boxes.value = resized;
  }
  if (commit) {
    if (mode === "move" || mode === "draw") updateRegion(id, next);
  } else outline.value = { id, region: next };
}
function end(event: PointerEvent) {
  if (!gesture || gesture.pointer !== event.pointerId) return;
  dragFrame.cancel();
  applyMove(event, true);
  outline.value = undefined;
  const id = gesture.id;
  gesture = undefined;
  if (surface.value?.hasPointerCapture(event.pointerId))
    surface.value.releasePointerCapture(event.pointerId);
  sort();
  gesturing.value = false;
  focusBox(id);
}
function cancel(event?: PointerEvent) {
  if (!gesture || (event && gesture.pointer !== event.pointerId)) return;
  const pointer = gesture.pointer;
  dragFrame.cancel();
  outline.value = undefined;
  boxes.value = gesture.original;
  gesturing.value = false;
  gesture = undefined;
  selected.value = selected.value.filter((id) => boxes.value.some((f) => f.id === id));
  if (surface.value?.hasPointerCapture(pointer)) surface.value.releasePointerCapture(pointer);
}
function key(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (target.matches("input, select, summary") || event.metaKey || event.ctrlKey) return;
  if (/^(Arrow|Delete|Backspace|[0-3]$)/.test(event.key)) cancel();
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
  const cel = active.value;
  if (!cel || !event.key.startsWith("Arrow")) return;
  if (
    event.altKey &&
    target.closest(".cel-strip") &&
    (event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    orderStep(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  event.preventDefault();
  const amount = event.shiftKey ? cel.region.width : 1;
  const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
  const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
  if (event.altKey)
    boxes.value = resizeLinkedCelBoxes(boxes.value, cel.id, dx ? "e" : "s", dx, dy, props.image);
  else updateRegion(cel.id, moveCelRegion(cel.region, dx, dy, props.image));
  sort();
  focusBox(cel.id);
}
function detail(event: Event, field: keyof Rect) {
  const cel = active.value;
  if (!cel) return;
  const value = Math.round(Number((event.target as HTMLInputElement).value));
  if (!Number.isFinite(value)) return;
  if (field === "width" || field === "height") {
    boxes.value = resizeLinkedCelBoxes(
      boxes.value,
      cel.id,
      field === "width" ? "e" : "s",
      field === "width" ? value - cel.region.width : 0,
      field === "height" ? value - cel.region.height : 0,
      props.image,
    );
  } else
    updateRegion(
      cel.id,
      moveCelRegion(
        cel.region,
        field === "x" ? value - cel.region.x : 0,
        field === "y" ? value - cel.region.y : 0,
        props.image,
      ),
    );
}
function regionStyle(cel: CelBox) {
  const region = outline.value?.id === cel.id ? outline.value.region : cel.region;
  return {
    left: `${region.x * scale.value}px`,
    top: `${region.y * scale.value}px`,
    width: `${region.width * scale.value}px`,
    height: `${region.height * scale.value}px`,
    "--loop-colour": colours.value[cel.loop],
  };
}
let thumbnailCache: Record<string, { key: string; url: string }> = {};
const thumbnails = computed(() => {
  const prepared = preview.value;
  if (!prepared) return [];
  const loops = [...new Set(settledBoxes.value.map((f) => f.loop))].sort((a, b) => a - b);
  const counts: Record<string, number> = {};
  const previous = thumbnailCache;
  thumbnailCache = {};
  return settledBoxes.value.map((region) => {
    const index = counts[region.loop] ?? 0;
    counts[region.loop] = index + 1;
    const cel = prepared.input.loops[loops.indexOf(region.loop)]!.cels![index]!;
    const key = `${cel.width}:${cel.height}:${cel.transparentColor}:${palette.value.map((c) => c.join(",")).join(";")}:${[...cel.pixels].join(",")}`;
    const cached = previous[region.id];
    if (cached?.key === key) {
      thumbnailCache[region.id] = cached;
      return cached.url;
    }
    const target = document.createElement("canvas");
    target.width = cel.width;
    target.height = cel.height;
    const pixels = new ImageData(cel.width, cel.height);
    for (let i = 0; i < cel.pixels.length; i++) {
      const colour = cel.pixels[i]!;
      pixels.data.set(
        [...palette.value[colour]!, colour === cel.transparentColor ? 0 : 255],
        i * 4,
      );
    }
    target.getContext("2d")!.putImageData(pixels, 0, 0);
    const url = target.toDataURL();
    thumbnailCache[region.id] = { key, url };
    return url;
  });
});
</script>

<template>
  <div ref="editor" class="cel-editor" @keydown.stop="key" @keyup.stop @keypress.stop>
    <div class="cel-main">
      <div class="cel-sheet-area">
        <UiButton
          class="cel-link"
          size="sm"
          :aria-pressed="active?.linked ?? false"
          :disabled="!active"
          :title="active ? 'Click to unlink or relink this cel' : 'Select a cel to link'"
          aria-label="Link selected cel"
          @click="link"
          >{{ linkLabel }}</UiButton
        >
        <div class="cel-find">
          <UiButton size="sm" @click="find">Find cels again</UiButton>
          <details class="cel-find-menu">
            <summary aria-label="Cel finding options">
              <UiIcon name="chevron-down" :size="16" />
            </summary>
            <div>
              <label><input v-model="suggestion" type="radio" value="gaps" />By gaps</label>
              <label><input v-model="suggestion" type="radio" value="grid" />Grid</label>
              <label v-if="suggestion === 'grid'"
                >Count<input
                  v-model.number="count"
                  type="number"
                  aria-label="Grid cel count"
                  min="1"
                  :max="image.width"
              /></label>
            </div>
          </details>
        </div>
        <div class="cel-zoom">
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
            ><UiIcon name="minus" :size="16"
          /></UiButton>
          <UiButton size="sm" aria-label="Zoom in" @click="zoom = Math.min(64, scale * 1.5)"
            ><UiIcon name="plus" :size="16"
          /></UiButton>
        </div>
        <div ref="viewport" class="cel-viewport">
          <div
            ref="surface"
            class="cel-surface"
            data-testid="cel-sheet"
            role="group"
            aria-label="Image cels: drag to draw, arrows to move, Alt and arrows to resize"
            tabindex="0"
            :style="{ width: `${image.width * scale}px`, height: `${image.height * scale}px` }"
            @pointerdown.self="begin($event)"
            @pointermove="move"
            @pointerup="end"
            @pointercancel="cancel"
            @lostpointercapture="cancel"
          >
            <canvas ref="canvas" aria-hidden="true" />
            <div
              v-for="(cel, index) in boxes"
              :key="cel.id"
              class="cel-box"
              :class="{ 'is-selected': selected.includes(cel.id) }"
              :style="regionStyle(cel)"
              data-testid="image-cel"
            >
              <div
                class="cel-box__body"
                role="button"
                tabindex="0"
                :data-cel-id="cel.id"
                :aria-label="`Cel ${index + 1}`"
                :aria-pressed="selected.includes(cel.id)"
                @focus="selected.includes(cel.id) || select(cel.id)"
                @pointerdown.stop="begin($event, cel)"
                @keydown.enter.prevent="select(cel.id, $event.shiftKey)"
                @keydown.space.prevent="select(cel.id, $event.shiftKey)"
              >
                <span>{{ index + 1 }}</span>
              </div>
              <button
                v-for="handle in selected.includes(cel.id) ? handles : []"
                :key="handle.value"
                class="cel-handle"
                type="button"
                tabindex="-1"
                :aria-label="`Resize cel ${index + 1} ${handle.label}`"
                :style="{
                  left: `${handle.x}%`,
                  top: `${handle.y}%`,
                  cursor: `${handle.value}-resize`,
                }"
                @pointerdown.stop="begin($event, cel, handle.value)"
              ></button>
            </div>
          </div>
        </div>
      </div>
      <aside class="cel-preview">
        <div class="cel-preview__header">
          <strong>Animation</strong>
          <UiButton
            size="sm"
            :icon="animated ? 'pause' : 'play'"
            :aria-label="animated ? 'Pause animation' : 'Play animation'"
            :aria-pressed="animated"
            @click="animated = !animated"
            >{{ animated ? "Pause" : "Play" }}</UiButton
          >
        </div>
        <div ref="animationPanel" class="cel-animation" role="group" aria-label="Animation preview">
          <canvas
            v-show="previewCel"
            ref="animation"
            role="img"
            :aria-label="`Loop ${chosenLoop} animation`"
            :style="
              previewCel
                ? {
                    width: `${previewCel.width * 2 * animationScale}px`,
                    height: `${previewCel.height * animationScale}px`,
                  }
                : {}
            "
          />
        </div>
        <label class="cel-size"
          >Size
          <span class="cel-stepper">
            <button
              type="button"
              aria-label="Smaller cels"
              @click="celHeight = Math.max(1, celHeight - 1)"
            >
              <UiIcon name="minus" :size="16" />
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
              <UiIcon name="plus" :size="16" />
            </button>
          </span>
          px tall · like {{ name }}</label
        >
        <slot name="preview" />
        <p class="cel-hint">Drag on empty space to add a cel.</p>
        <details v-if="active" class="cel-details">
          <summary>
            <span data-testid="cel-summary" role="status" aria-live="polite">{{ summary }}</span>
          </summary>
          <div class="cel-detail-fields">
            <label v-for="field in ['x', 'y', 'width', 'height'] as const" :key="field"
              >{{ field
              }}<input
                type="number"
                :aria-label="`Selected cel ${field}`"
                :value="active.region[field]"
                :min="field === 'width' || field === 'height' ? 1 : 0"
                :max="field === 'x' || field === 'width' ? image.width : image.height"
                @change="detail($event, field)"
            /></label>
          </div>
        </details>
      </aside>
    </div>
    <div class="cel-strip" role="group" aria-label="Cel order: drag thumbnails to reorder">
      <div v-for="(cel, index) in boxes" :key="cel.id" class="cel-strip-item">
        <button
          class="cel-thumbnail"
          type="button"
          draggable="true"
          :data-order-id="cel.id"
          :aria-label="`Select cel ${index + 1} in order strip`"
          :aria-pressed="selected.includes(cel.id)"
          :style="{ '--loop-colour': colours[cel.loop] }"
          @click="select(cel.id, $event.shiftKey)"
          @dragstart.stop="startOrder($event, cel.id)"
          @dragend="dragged = undefined"
          @dragover.prevent.stop
          @drop.prevent.stop="dropOrder(cel.id)"
        >
          <span class="cel-thumbnail__image"
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
          class="cel-thumbnail__remove"
          type="button"
          :aria-label="`Remove cel ${index + 1}`"
          @focus="select(cel.id)"
          @click.stop="
            select(cel.id);
            remove();
          "
        >
          <UiIcon name="x" :size="16" />
        </button>
      </div>
    </div>
    <div class="cel-add">
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
    <p v-if="notice" class="cel-hint" role="status">{{ notice }}</p>
  </div>
</template>

<style scoped>
.cel-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}
.cel-toolbar,
.cel-loops,
.cel-bottom,
.cel-animation {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.cel-toolbar label {
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
.cel-viewport {
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
.cel-surface {
  position: relative;
  flex-shrink: 0;
  touch-action: none;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-sunken) 0% 50%) 0 0 /
    16px 16px;
}
.cel-surface > canvas {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  pointer-events: none;
  display: block;
}
.cel-box {
  position: absolute;
  border: 1px solid var(--loop-colour);
  box-sizing: border-box;
  background: color-mix(in srgb, var(--loop-colour) 10%, transparent);
}
.cel-box.is-selected {
  border-width: 2px;
  background: color-mix(in srgb, var(--loop-colour) 18%, transparent);
}
.cel-box__body {
  position: absolute;
  inset: 0;
  cursor: move;
}
.cel-box__body span {
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
.cel-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--surface-sunken);
  background: var(--loop-colour);
  border-radius: var(--radius-sm);
  padding: 0;
}
.cel-hint,
.cel-summary {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.cel-strip {
  display: flex;
  gap: var(--space-2);
  overflow-x: auto;
  flex-shrink: 0;
  padding: var(--space-1);
}
.cel-thumbnail {
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
.cel-thumbnail[aria-pressed="true"] {
  outline: 1px solid var(--loop-colour);
  color: var(--ink);
}
.cel-thumbnail__image {
  width: 40px;
  height: 48px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--surface-sunken);
}
.cel-thumbnail img {
  display: block;
  max-width: 100%;
  max-height: 48px;
  image-rendering: pixelated;
  pointer-events: none;
}
.cel-bottom {
  justify-content: space-between;
  align-items: start;
}
.cel-details {
  flex: 1;
}
.cel-details summary {
  cursor: pointer;
  font-size: var(--text-xs);
  padding: var(--space-2) 0;
}
.cel-detail-fields {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.cel-detail-fields label {
  display: grid;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.cel-animation {
  min-height: 120px;
  width: 100%;
  justify-content: flex-start;
  background: var(--surface-sunken);
}
.cel-animation canvas {
  flex: none;
  margin: auto;
  image-rendering: pixelated;
  background: var(--surface-sunken);
}
.cel-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  flex: 1;
  min-height: 0;
  gap: var(--space-3);
}
.cel-sheet-area {
  position: relative;
  min-height: 240px;
}
.cel-link,
.cel-find,
.cel-zoom {
  position: absolute;
  z-index: 2;
  background: var(--surface-1);
  border-radius: var(--radius);
}
.cel-link {
  left: 10px;
  top: 10px;
}
.cel-find {
  left: 10px;
  bottom: 10px;
  display: flex;
}
.cel-zoom {
  right: 10px;
  bottom: 10px;
  display: flex;
}
.cel-find-menu summary {
  padding: var(--space-2);
  cursor: pointer;
  list-style: none;
}
.cel-find-menu > div {
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
.cel-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  overflow: auto;
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
}
.cel-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  width: 100%;
  font-size: var(--text-sm);
}
.cel-size {
  font-size: var(--text-xs);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.cel-stepper {
  display: flex;
  align-items: center;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.cel-stepper input {
  width: 30px;
  border: 0;
  padding: 0;
  text-align: center;
  appearance: textfield;
}
.cel-stepper input::-webkit-inner-spin-button {
  appearance: none;
}
.cel-stepper button {
  background: none;
  border: 0;
  color: var(--ink-2);
  cursor: pointer;
  padding: var(--space-1);
}
.cel-strip-item {
  position: relative;
  flex-shrink: 0;
}
.cel-thumbnail__remove {
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
.cel-strip-item:hover .cel-thumbnail__remove,
.cel-strip-item:focus-within .cel-thumbnail__remove {
  opacity: 1;
}
.cel-add {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-wrap: wrap;
  border-top: 1px solid var(--hairline);
  padding-top: var(--space-2);
}
.cel-add label {
  font-size: var(--text-xs);
}
@media (max-width: 900px) {
  .cel-main {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }
  .cel-sheet-area {
    min-height: 300px;
  }
}
button:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
</style>
