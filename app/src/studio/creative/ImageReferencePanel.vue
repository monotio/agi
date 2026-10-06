<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import {
  imageTraceUnderlay,
  traceImageChanges,
  traceOptionsChanges,
  prepareTracePixels,
  type TraceTransform,
  readImageReferences,
  readProjectImage,
  makeCelsChanges,
  suggestImageFrames,
  prepareImageCels,
  detectImageBackground,
  type ProjectImageInput,
  type ImageFrame,
} from "../../../../src/creative/imageOperations.ts";
import type { ProjectSession } from "../../project/projectSession.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { decodeCreativeImage } from "../../references/creativeImageDecode.ts";
import type { createImageGenerationMount } from "./imageGenerationMount.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useShellBridge } from "../../shell/shellBridge.ts";
import { openSprite } from "../../../../src/view/spriteDocument.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import { buildView } from "../../../../src/view/view.ts";
import { nearestEgaIndex } from "../../../../src/view/spritesheet.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
import { presentTrace, previewTrace } from "./tracePresentation.ts";
import ImageFrameSheet from "./ImageFrameSheet.vue";
import UiButton from "../../ui/UiButton.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
const props = defineProps<{
  session: ProjectSession;
  target: string;
  profile: AgiProfile;
  generate: boolean;
  active: boolean;
  imageRevision: number;
  resourceRevision: number;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();
const CreativeGenerate = defineAsyncComponent(() => import("./CreativeGenerate.vue"));
const engine = useEngineApi();
const bridge = useShellBridge();
const image = shallowRef<ProjectImageInput>();
const frames = ref<ImageFrame[]>([]);
const opacity = ref(0.4);
const behindArt = ref(false);
const transform = ref<TraceTransform>({ x: 0, y: 0, scale: 1 });
const error = ref("");
const status = ref("");
const previewing = ref(false);
const busy = ref(false);
const generateOpen = ref(props.generate);
const file = useTemplateRef("file");
let traceWrites = Promise.resolve();
let pendingTraceWrites = 0;
const isPicture = computed(() => props.target.startsWith("picture:"));
const mirrors = shallowRef<readonly (number | null)[]>([]);
const loopHeights = shallowRef<readonly number[]>([]);
const background = shallowRef<readonly [number, number, number] | null>(null);
const replaceOpen = ref(false);
const colourOpen = ref(false);
const backgroundTransparent = ref(true);
const colourNames = [
  "Black",
  "Blue",
  "Green",
  "Cyan",
  "Red",
  "Magenta",
  "Brown",
  "Light grey",
  "Dark grey",
  "Light blue",
  "Light green",
  "Light cyan",
  "Light red",
  "Light magenta",
  "Yellow",
  "White",
];
const name = computed(() => {
  const bindings = props.session.workingSnapshot().read("bindings")?.content;
  if (typeof bindings === "string") {
    const entry = Object.entries(readBindingsDocument(bindings)).find(
      ([, binding]) => `${binding.kind}:${binding.num}` === props.target,
    );
    if (entry) return entry[0] === "ego_view" ? "Hero" : entry[0].replaceAll("_", " ");
  }
  return "Character";
});
const backgroundName = computed(() =>
  background.value === null
    ? "Background is see-through"
    : `${colourNames[nearestEgaIndex(...background.value)]} is see-through`,
);
const sourceUrl = computed(() => {
  if (!image.value) return "";
  const canvas = document.createElement("canvas");
  canvas.width = image.value.width;
  canvas.height = image.value.height;
  const pixels = new ImageData(canvas.width, canvas.height);
  pixels.data.set(image.value.rgba);
  canvas.getContext("2d")!.putImageData(pixels, 0, 0);
  return canvas.toDataURL();
});
watch(
  () => props.resourceRevision,
  () => {
    const content = props.session.workingSnapshot().read(props.target)?.content;
    if (!isPicture.value && content !== undefined) {
      const sprite = openSprite(
        typeof content === "string" ? buildView(JSON.parse(content), props.profile) : content,
        props.profile,
      );
      mirrors.value = sprite.loops.map((loop) => loop.alias);
      loopHeights.value = sprite.loops.map((loop) => loop.cels[0]?.height ?? 24);
    }
  },
  { immediate: true },
);
watch(
  () => props.imageRevision,
  () => {
    if (!props.target.startsWith("picture:") || pendingTraceWrites > 0) return;
    const documents = props.session.workingSnapshot().documents();
    const trace = readImageReferences(documents).traces[props.target];
    image.value = trace ? readProjectImage(documents, trace.image) : undefined;
    opacity.value = trace?.opacity ?? 0.4;
    behindArt.value = trace?.behindArt ?? false;
    transform.value = imageTraceUnderlay(documents, props.target)?.transform ?? {
      x: 0,
      y: 0,
      scale: 1,
    };
    previewPlacement();
  },
  { immediate: true },
);
let closed = false;
let intakeEpoch = 0;
function current() {
  return !closed && currentProject();
}
function currentProject() {
  return props.active && engine.getProjectSession() === props.session;
}
const generation = shallowRef<ReturnType<typeof createImageGenerationMount>>();
watch(
  generateOpen,
  async (open) => {
    if (!open || generation.value) return;
    const { createImageGenerationMount } = await import("./imageGenerationMount.ts");
    if (!current()) return;
    generation.value = createImageGenerationMount({
      session: props.session,
      current,
      async use(value) {
        await useImage(value);
      },
      openSettings() {
        if (file.value) bridge.openSettings(file.value);
      },
    });
  },
  { immediate: true },
);
watch(
  () => props.generate,
  (value) => {
    generateOpen.value = value;
  },
);
async function commit(changes: Parameters<typeof props.session.model.propose>[2], _label: string) {
  if (!currentProject()) throw new Error("Open this project again to use the image.");
  const result = await props.session.stage(changes);
  if (!["draft", "committed", "restartRequired"].includes(result.status))
    throw new Error("The image could not be added. Check the frames and try again.");
  emit("changed");
}
async function useImage(value: ProjectImageInput) {
  image.value = value;
  transform.value = { x: 0, y: 0, scale: 1 };
  previewPlacement();
  status.value = "";
  if (isPicture.value) {
    const target = props.target;
    const nextOpacity = opacity.value;
    const nextBehind = behindArt.value;
    await queueTraceWrite(async () => {
      await commit(
        traceImageChanges(
          props.session.workingSnapshot().documents(),
          target,
          value,
          nextOpacity,
          nextBehind,
        ),
        "Trace an image",
      );
    });
  } else {
    background.value = detectImageBackground(value);
    backgroundTransparent.value = true;
    frames.value = [...suggestImageFrames(value)];
  }
  generateOpen.value = false;
}
async function intake(blob: Blob, title: string) {
  const epoch = ++intakeEpoch;
  error.value = "";
  busy.value = true;
  try {
    const decoded = await decodeCreativeImage(blob);
    if (!current() || epoch !== intakeEpoch) return;
    await useImage({
      title,
      mime: decoded.encoded.mime,
      encoded: decoded.encodedBytes,
      width: decoded.normalized.width,
      height: decoded.normalized.height,
      rgba: decoded.pixels,
    });
  } catch (cause) {
    if (current()) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (epoch === intakeEpoch) busy.value = false;
  }
}
function choose(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  if (selected) void intake(selected, selected.name);
}
function drop(event: DragEvent) {
  event.preventDefault();
  const selected = event.dataTransfer?.files[0];
  if (selected) void intake(selected, selected.name);
}
function paste(event: ClipboardEvent) {
  if (!current()) return;
  const item = Array.from(event.clipboardData?.items ?? []).find((item) =>
    item.type.startsWith("image/"),
  );
  const selected = item?.getAsFile();
  if (selected) {
    event.preventDefault();
    void intake(selected, "Pasted image");
  }
}
function queueTraceWrite(write: () => Promise<void>) {
  pendingTraceWrites++;
  const queued = traceWrites.then(write).finally(async () => {
    // The revision watcher runs while these writes still own the live preview.
    await nextTick();
    pendingTraceWrites--;
  });
  traceWrites = queued.catch(() => {});
  return queued;
}
function adjustTrace(next: TraceTransform, release: boolean) {
  if (!current()) return;
  transform.value = next;
  previewPlacement();
  if (release) changeTrace("Trace position");
}
function previewPlacement() {
  if (!image.value || !isPicture.value) return;
  presentTrace(props.session, props.target, {
    pixels: prepareTracePixels(image.value, transform.value),
    opacity: opacity.value,
    behindArt: behindArt.value,
    transform: transform.value,
    adjust: adjustTrace,
  });
}
function resetTrace() {
  adjustTrace({ x: 0, y: 0, scale: 1 }, true);
}
function previewOpacity() {
  previewTrace(props.session, props.target, opacity.value, behindArt.value);
}
function changeTrace(label: string) {
  if (!current() || !image.value) return;
  const target = props.target;
  const nextOpacity = opacity.value;
  const nextBehind = behindArt.value;
  const nextTransform = { ...transform.value };
  previewOpacity();
  void queueTraceWrite(async () => {
    if (!currentProject()) return;
    error.value = "";
    while (currentProject()) {
      const capture = props.session.workingSnapshot();
      try {
        await commit(
          traceOptionsChanges(capture.documents(), target, nextOpacity, nextBehind, nextTransform),
          label,
        );
        break;
      } catch (cause) {
        if (capture.documentId === props.session.workingSnapshot().documentId) throw cause;
      }
    }
    if (current()) previewOpacity();
  }).catch(() => {
    if (current())
      error.value = "The trace settings could not be saved. Move the slider again to retry.";
  });
}
const prepared = computed(() => {
  if (!image.value || isPicture.value) return null;
  try {
    return prepareImageCels(
      image.value,
      frames.value,
      props.profile,
      background.value,
      backgroundTransparent.value,
    );
  } catch {
    return null;
  }
});
async function addCels() {
  if (!image.value) return;
  busy.value = true;
  error.value = "";
  try {
    stopPreview();
    await commit(
      makeCelsChanges(
        props.session.workingSnapshot().documents(),
        props.target,
        image.value,
        frames.value,
        props.profile,
        background.value,
        backgroundTransparent.value,
      ),
      "Make cels from an image",
    );
    status.value = `Added ${frames.value.length} cels`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
function stopPreview() {
  if (previewing.value) engine.previewImageCels(null);
  previewing.value = false;
}
function preview() {
  if (previewing.value) stopPreview();
  else if (prepared.value) {
    engine.previewImageCels(
      prepared.value.payload,
      [...new Set(frames.value.map((frame) => frame.loop))].sort((a, b) => a - b),
    );
    previewing.value = true;
  }
}
watch(prepared, () => {
  if (previewing.value) {
    if (prepared.value)
      engine.previewImageCels(
        prepared.value.payload,
        [...new Set(frames.value.map((frame) => frame.loop))].sort((a, b) => a - b),
      );
    else stopPreview();
  }
});
watch(
  () => props.active,
  (active) => {
    if (!active) stopPreview();
  },
);
window.addEventListener("paste", paste);
onBeforeUnmount(() => {
  window.removeEventListener("paste", paste);
  previewTrace(props.session, props.target, opacity.value, behindArt.value, { adjust: undefined });
  closed = true;
  intakeEpoch++;
  generation.value?.dispose();
  stopPreview();
});
</script>
<template>
  <section
    class="image-reference"
    :class="{
      'image-reference--cels': !isPicture,
      'image-reference--picture': isPicture,
      'image-reference--active': active,
    }"
    data-testid="image-reference"
    @dragover.prevent
    @drop="drop"
    tabindex="0"
  >
    <header>
      <strong>{{
        isPicture ? "Trace an image" : `${name} VIEW ${target.slice(5)} · Cels from an image`
      }}</strong>
      <UiButton size="sm" variant="ghost" @click="emit('close')">Done</UiButton>
    </header>
    <div v-if="isPicture || !image" class="image-reference__actions">
      <UiButton size="sm" :disabled="busy" @click="file?.click()">Bring in an image</UiButton>
      <span>Drop, paste or choose an image.</span>
    </div>
    <div v-if="image && !isPicture" class="image-source">
      <span class="image-source__chip"><img :src="sourceUrl" alt="" />{{ image.title }}</span>
      <div class="image-source__menu">
        <UiButton
          size="sm"
          variant="ghost"
          :aria-expanded="replaceOpen"
          @click="replaceOpen = !replaceOpen"
          >Replace <UiIcon name="chevron-down" :size="16"
        /></UiButton>
        <div v-if="replaceOpen" class="image-source__popover">
          <UiButton
            size="sm"
            :disabled="busy"
            title="Choose an image file"
            @click="
              file?.click();
              replaceOpen = false;
            "
            >Bring in an image</UiButton
          >
        </div>
      </div>
      <div class="image-source__colour">
        <UiSwitch v-model="backgroundTransparent" size="sm">Background is see-through</UiSwitch>
        <UiButton
          size="sm"
          variant="ghost"
          :aria-expanded="colourOpen"
          :disabled="!backgroundTransparent"
          aria-label="See-through colour"
          :title="backgroundName"
          @click="colourOpen = !colourOpen"
          >Colour<i
            class="image-source__swatch"
            :style="{ background: background ? `rgb(${background.join(' ')})` : 'transparent' }"
          ></i
        ></UiButton>
        <div
          v-if="colourOpen"
          class="image-source__popover"
          role="group"
          aria-label="See-through colour"
        >
          <button
            v-for="(colour, index) in EGA_PALETTE"
            :key="index"
            type="button"
            :aria-label="colourNames[index]"
            :style="{ background: `rgb(${colour.join(' ')})` }"
            @click="
              background = colour;
              colourOpen = false;
            "
          ></button>
          <UiButton
            size="sm"
            @click="
              background = null;
              colourOpen = false;
            "
            >Use transparency</UiButton
          >
        </div>
      </div>
    </div>
    <input
      ref="file"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      data-testid="image-file"
      @change="choose"
      hidden
    />
    <p v-if="error" role="alert">{{ error }}</p>
    <CreativeGenerate
      v-if="generateOpen && generation"
      :controller="generation"
      :role="isPicture ? 'room' : 'character'"
      :class="{ 'image-reference__generation': isPicture }"
    />
    <label v-if="image && isPicture"
      >Opacity
      <input
        v-model.number="opacity"
        type="range"
        min="0"
        max="1"
        step="0.05"
        data-testid="trace-opacity"
        @input="previewOpacity"
        @change="changeTrace('Trace opacity')"
    /></label>
    <label v-if="image && isPicture">
      <input v-model="behindArt" type="checkbox" @change="changeTrace('Trace placement')" />
      Behind art
    </label>
    <template v-if="image && isPicture">
      <UiButton size="sm" aria-label="Reset trace" @click="resetTrace">Reset</UiButton>
      <span>Drag the centre to move. Drag the corner to scale.</span>
    </template>
    <template v-if="image && !isPicture">
      <ImageFrameSheet
        v-show="!generateOpen"
        v-model="frames"
        :image="image"
        :profile="profile"
        :mirrors="mirrors"
        :loop-heights="loopHeights"
        :name="name"
        :background="background"
        :background-transparent="backgroundTransparent"
      >
        <template #preview>
          <UiButton
            size="sm"
            :disabled="!prepared || !frames.length"
            :title="prepared ? '' : 'Adjust the frames first'"
            data-testid="image-preview-hero"
            @click="preview"
            >{{ previewing ? "Stop preview" : "Try on Hero in the game" }}</UiButton
          >
        </template>
        <template #commit>
          <UiButton
            size="sm"
            variant="primary"
            :disabled="!prepared || !frames.length || busy"
            :title="prepared ? '' : 'Adjust the frames first'"
            data-testid="image-add-cels"
            @click="addCels"
            >Add {{ frames.length }} cels</UiButton
          >
        </template>
      </ImageFrameSheet>
      <p v-if="!prepared" role="alert">Adjust the frames to fit the image and cel size.</p>
    </template>
    <p v-if="status" role="status" data-testid="image-status">{{ status }}</p>
  </section>
</template>
<style scoped>
.image-reference {
  padding: var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-1);
  max-height: 45%;
  overflow: auto;
  flex-shrink: 0;
}
.image-reference header,
.image-reference__actions {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}
.image-reference header {
  justify-content: space-between;
  margin-bottom: var(--space-2);
}
.image-reference--picture {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  max-height: none;
  overflow: visible;
  flex: 1 0 100%;
  box-sizing: border-box;
}
.image-reference--picture header {
  margin: 0;
  gap: var(--space-3);
}
.image-reference--picture :deep(.image-reference__generation) {
  position: absolute;
  top: 100%;
  right: 0;
  width: min(440px, 100%);
  max-height: 60vh;
  overflow: auto;
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow-pop);
  background: var(--surface-1);
}
.image-reference p,
.image-reference span,
.image-reference label {
  font-size: var(--text-xs);
}
.image-reference--cels {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}
.image-reference--cels :deep(.frame-editor) {
  flex: 1;
  padding: var(--space-1);
}
.image-reference--cels > header,
.image-reference--cels > .image-reference__actions,
.image-reference--cels > p {
  flex-shrink: 0;
}
.image-reference--cels .image-reference__actions {
  margin-top: var(--space-2);
}
.image-source {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  font-size: var(--text-xs);
}
.image-source__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-2);
  max-width: 100%;
  overflow-wrap: anywhere;
}
.image-source__chip img {
  width: 24px;
  height: 24px;
  object-fit: contain;
  image-rendering: pixelated;
}
.image-source__menu,
.image-source__colour {
  position: relative;
}
.image-source__colour {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
/* A round colour dot: a square one reads as an empty checkbox when the colour is white. */
.image-source__swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid var(--hairline-strong);
  border-radius: 50%;
  margin-left: var(--space-2);
}
.image-source__popover {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 5;
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  padding: var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 150px;
  box-shadow: var(--shadow-pop);
}
.image-source__colour .image-source__popover button {
  min-width: 24px;
  min-height: 24px;
  border: 1px solid var(--hairline);
  cursor: pointer;
}
.image-reference--cels > .generate {
  flex: 1;
  overflow: auto;
}
</style>
