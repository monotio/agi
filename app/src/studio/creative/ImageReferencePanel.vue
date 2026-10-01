<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import {
  traceImageChanges,
  readImageReferences,
  readProjectImage,
  makeCelsChanges,
  suggestImageFrames,
  prepareImageCels,
  type ProjectImageInput,
  type ImageFrame,
} from "../../../../src/creative/imageOperations.ts";
import type { ProjectSession } from "../../project/projectSession.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import { decodeCreativeImage } from "../../references/creativeImageDecode.ts";
import type { createImageGenerationMount } from "./imageGenerationMount.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useShellBridge } from "../../shell/shellBridge.ts";
import { EGA_PALETTE } from "../../render/palette.ts";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{
  session: ProjectSession;
  target: string;
  profile: AgiProfile;
  generate: boolean;
  active: boolean;
  imageRevision: number;
}>();
const emit = defineEmits<{ close: []; changed: [] }>();
const CreativeGenerate = defineAsyncComponent(() => import("./CreativeGenerate.vue"));
const engine = useEngineApi();
const bridge = useShellBridge();
const image = shallowRef<ProjectImageInput>();
const frames = ref<ImageFrame[]>([]);
const opacity = ref(0.4);
const error = ref("");
const status = ref("");
const previewing = ref(false);
const busy = ref(false);
const generateOpen = ref(props.generate);
const file = useTemplateRef("file");
const canvas = useTemplateRef("sheet");
const isPicture = computed(() => props.target.startsWith("picture:"));
watch(
  () => props.imageRevision,
  () => {
    if (!props.target.startsWith("picture:")) return;
    const documents = props.session.model.capture().documents();
    const trace = readImageReferences(documents).traces[props.target];
    image.value = trace ? readProjectImage(documents, trace.image) : undefined;
    opacity.value = trace?.opacity ?? 0.4;
  },
  { immediate: true },
);
let closed = false;
let intakeEpoch = 0;
function current() {
  return !closed && props.active && engine.getProjectSession() === props.session;
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
async function commit(changes: Parameters<typeof props.session.model.propose>[2], label: string) {
  if (!current()) throw new Error("Open this project again to use the image.");
  const result = await props.session.submit({
    proposal: props.session.model.propose(props.session.model.capture(), label, changes),
    label,
    origin: isPicture.value ? "picture" : "view",
    author: "creator",
  });
  if (!["committed", "restartRequired"].includes(result.status))
    throw new Error("The image could not be added. Check the frames and try again.");
  emit("changed");
}
async function useImage(value: ProjectImageInput) {
  image.value = value;
  status.value = "";
  if (isPicture.value)
    await commit(
      traceImageChanges(
        props.session.model.capture().documents(),
        props.target,
        value,
        opacity.value,
      ),
      "Trace an image",
    );
  else frames.value = [...suggestImageFrames(value)];
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
async function changeOpacity() {
  if (!image.value) return;
  try {
    await commit(
      traceImageChanges(
        props.session.model.capture().documents(),
        props.target,
        image.value,
        opacity.value,
      ),
      "Trace opacity",
    );
  } catch (cause) {
    error.value = String(cause);
  }
}
const prepared = computed(() => {
  if (!image.value || isPicture.value) return null;
  try {
    return prepareImageCels(image.value, frames.value, props.profile);
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
        props.session.model.capture().documents(),
        props.target,
        image.value,
        frames.value,
        props.profile,
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
watch(
  [image, frames, canvas],
  () => {
    const target = canvas.value,
      source = image.value;
    if (!target || !source) return;
    target.width = source.width;
    target.height = source.height;
    const context = target.getContext("2d")!;
    const pixels = new ImageData(source.width, source.height);
    pixels.data.set(source.rgba);
    context.putImageData(pixels, 0, 0);
    context.strokeStyle = `rgb(${EGA_PALETTE[11]!.join(" ")})`;
    context.lineWidth = Math.max(1, source.width / 320);
    for (const frame of frames.value)
      context.strokeRect(frame.region.x, frame.region.y, frame.region.width, frame.region.height);
  },
  { deep: true, flush: "post" },
);
let start: { x: number; y: number } | undefined;
function point(event: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        image.value!.width - 1,
        Math.floor(((event.clientX - rect.left) * image.value!.width) / rect.width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        image.value!.height - 1,
        Math.floor(((event.clientY - rect.top) * image.value!.height) / rect.height),
      ),
    ),
  };
}
function markStart(event: PointerEvent) {
  start = point(event);
  canvas.value?.setPointerCapture(event.pointerId);
}
function markEnd(event: PointerEvent) {
  if (!start || !image.value) return;
  const end = point(event),
    region = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(start.x - end.x) + 1,
      height: Math.abs(start.y - end.y) + 1,
    };
  frames.value.push({
    region,
    width: Math.min(32, region.width),
    height: Math.min(48, region.height),
    loop: 0,
  });
  start = undefined;
}
window.addEventListener("paste", paste);
onBeforeUnmount(() => {
  window.removeEventListener("paste", paste);
  closed = true;
  intakeEpoch++;
  generation.value?.dispose();
  stopPreview();
});
</script>
<template>
  <section
    class="image-reference"
    data-testid="image-reference"
    @dragover.prevent
    @drop="drop"
    tabindex="0"
  >
    <header>
      <strong>{{ isPicture ? "Trace an image" : "Make cels from an image" }}</strong>
      <UiButton size="sm" variant="ghost" @click="emit('close')">Close</UiButton>
    </header>
    <div class="image-reference__actions">
      <UiButton size="sm" :disabled="busy" @click="file?.click()">Bring in an image</UiButton>
      <UiButton size="sm" @click="generateOpen = !generateOpen">Generate</UiButton>
      <span>Drop, paste or choose an image.</span>
      <input
        ref="file"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        data-testid="image-file"
        @change="choose"
        hidden
      />
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <CreativeGenerate
      v-if="generateOpen && generation"
      :controller="generation"
      :role="isPicture ? 'room' : 'character'"
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
        @change="changeOpacity"
    /></label>
    <template v-if="image && !isPicture">
      <p>Drag on the sheet to mark a frame. Adjust frames and choose their loops.</p>
      <canvas
        ref="sheet"
        class="image-reference__sheet"
        :style="{ width: `min(100%, ${(160 * image.width) / image.height}px)` }"
        aria-label="Image frames"
        @pointerdown="markStart"
        @pointerup="markEnd"
      />
      <div class="image-reference__frames">
        <div
          v-for="(frame, index) in frames"
          :key="index"
          data-testid="image-frame"
          class="image-reference__frame"
        >
          <span>{{ index + 1 }}</span>
          <label v-for="field in ['x', 'y', 'width', 'height'] as const" :key="field"
            >{{ field
            }}<input
              v-model.number="frame.region[field]"
              type="number"
              :min="field === 'width' || field === 'height' ? 1 : 0"
              :aria-label="`Frame ${index + 1} ${field}`"
          /></label>
          <label
            >Cel width<input v-model.number="frame.width" type="number" min="1" max="160"
          /></label>
          <label
            >Cel height<input v-model.number="frame.height" type="number" min="1" max="168"
          /></label>
          <label
            >Loop<input
              v-model.number="frame.loop"
              type="number"
              min="0"
              max="254"
              :aria-label="`Frame ${index + 1} loop`"
          /></label>
          <UiButton size="sm" variant="ghost" @click="frames.splice(index, 1)">Remove</UiButton>
        </div>
      </div>
      <div class="image-reference__actions">
        <UiButton
          size="sm"
          :disabled="!prepared"
          :title="prepared ? '' : 'Adjust the frames first'"
          data-testid="image-preview-hero"
          @click="preview"
          >{{ previewing ? "Stop preview" : "Preview on hero" }}</UiButton
        >
        <UiButton
          size="sm"
          :disabled="!prepared || busy"
          :title="prepared ? '' : 'Adjust the frames first'"
          data-testid="image-add-cels"
          @click="addCels"
          >Add as cels</UiButton
        >
      </div>
      <p v-if="!prepared" role="alert">Adjust the frames to fit the image and cel size.</p>
    </template>
    <p v-if="status" role="status" data-testid="image-status">{{ status }}</p>
  </section>
</template>
<style scoped>
.image-reference {
  padding: var(--space-3);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface);
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
.image-reference p,
.image-reference span,
.image-reference label {
  font-size: var(--text-xs);
}
.image-reference__sheet {
  height: auto;
  max-width: 100%;
  image-rendering: pixelated;
  touch-action: none;
}
.image-reference__frame {
  display: flex;
  align-items: end;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: var(--space-2) 0;
}
.image-reference__frame label {
  display: grid;
  gap: var(--space-1);
}
.image-reference__frame input {
  width: 48px;
  background: var(--surface-sunken);
  border: 1px solid var(--hairline);
  color: var(--ink);
}
</style>
