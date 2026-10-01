<script setup lang="ts">
/**
 * The VIEW preparation editor: frame boxes drawn over the source in source
 * pixels — drag on empty space to create a region, drag a box to move it,
 * its corner to resize, its baseline bar to move the ground edge — with
 * numeric fields mirroring every gesture for keyboard users. Loop order,
 * frame order and mirroring are explicit. Every control edits the job on
 * the workspace controller; the prepared cels next to each frame re-render
 * from the recipe, so what you see is what the payload carries.
 */
import { computed, ref, useTemplateRef, watchEffect } from "vue";
import type { Rect } from "../../../../src/creative/catalog.ts";
import type {
  PreparedView,
  SourceIdentity,
  ViewFacing,
  ViewRecipeFrame,
} from "../../../../src/view/preparation.ts";
import UiButton from "../../ui/UiButton.vue";
import UiSelect from "../../ui/UiSelect.vue";
import { drawPreparedCel, drawRaster } from "./rasterCanvas.ts";
import { FieldDrafts, numericText } from "./creativeFieldEdits.ts";
import {
  clampRegion,
  frameFromRegion,
  gridRegions,
  nextFrameId,
  nextLoopId,
  reordered,
  splitFrameRegions,
} from "./frameTools.ts";
import type { ViewJob } from "./creativeWorkspace.ts";

const {
  job,
  prepared,
  preparedError = null,
  sourceWidth,
  sourceHeight,
  sourcePixels,
  sourceIdentity,
} = defineProps<{
  readonly job: ViewJob;
  /** The current prepareViewJob() result, or its error. */
  readonly prepared: PreparedView | null;
  readonly preparedError?: string | null;
  /** Canonical source the frames read, for the source-space overlay. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly sourcePixels: Uint8Array | null;
  /** Identity stamped on newly created frames. */
  readonly sourceIdentity: SourceIdentity | null;
}>();
const emit = defineEmits<{
  "update-frames": [frames: ViewRecipeFrame[]];
  "update-loops": [loops: ViewJob["loops"]];
  "update-mask": [mask: ViewJob["mask"]];
  "update-description": [description: string];
}>();

const FACINGS: readonly ViewFacing[] = ["right", "left", "down", "up"];

/* ---------- pending field edits ---------- */

/**
 * Uncommitted text per field, keyed to the job incarnation, the frame id
 * and the field, and stamped with the frame's content at first keystroke.
 * The controller clones the job on every read, so a `:value` binding would
 * re-assert the model on any unrelated update; the draft is what the field
 * shows until its ordinary commit.
 */
const drafts = new FieldDrafts();
function frameKey(frame: ViewRecipeFrame, field: string): string {
  return `${job.incarnation}\u0001frame\u0001${frame.id}\u0001${field}`;
}
function frameStamp(frame: ViewRecipeFrame): string {
  return JSON.stringify(frame);
}
function descriptionKey(): string {
  return `${job.incarnation}\u0001description`;
}
/** Every frames change flows through here so own commits re-stamp sibling drafts. */
function emitFrames(frames: ViewRecipeFrame[]): void {
  emit("update-frames", frames);
  drafts.rebase(`${job.incarnation}\u0001frame\u0001`, (key) => {
    const next = frames.find((entry) => entry.id === key.split("\u0001")[2]);
    return next === undefined ? null : frameStamp(next);
  });
}
function commitField(
  key: string,
  stamp: string,
  event: Event,
  apply: (text: string) => void,
): void {
  drafts.commit(key, stamp, event, numericText, apply);
}
/** Escape restores the model value; the draft leaves the field untouched. */
function revertField(key: string, model: string | number, event: Event): void {
  drafts.discard(key);
  (event.target as HTMLInputElement).value = String(model);
}

/* ---------- frame edits ---------- */

function patchFrame(id: string, patch: Partial<ViewRecipeFrame>): void {
  emitFrames(job.frames.map((frame) => (frame.id === id ? { ...frame, ...patch } : frame)));
}
function patchFrameRect(id: string, patch: Partial<Rect>): void {
  const frame = job.frames.find((entry) => entry.id === id);
  if (frame === undefined) return;
  const region = clampRegion({ ...frame.region, ...patch }, sourceWidth, sourceHeight);
  if (region === null) return;
  patchFrame(id, {
    region,
    // A numeric region edit keeps the frame coherent: the source anchor
    // recentres like a drag-move does, and the baseline edge clamps into
    // the region, so a shrunken region never strands the anchor outside
    // what it samples.
    sourceAnchor: {
      x: region.x + Math.floor(region.width / 2),
      baselineEdgeY: Math.min(frame.sourceAnchor.baselineEdgeY, region.y + region.height),
    },
    outputAnchorX: Math.min(frame.outputAnchorX, Math.max(0, frame.outputWidth - 1)),
  });
}
function patchFrameBaseline(id: string, baselineEdgeY: number): void {
  const frame = job.frames.find((entry) => entry.id === id);
  if (frame === undefined) return;
  const bottom = frame.region.y + frame.region.height;
  const edge = Math.max(0, Math.min(baselineEdgeY, sourceHeight));
  patchFrame(id, {
    sourceAnchor: { ...frame.sourceAnchor, baselineEdgeY: edge },
    // A baseline inside the region drops opaque pixels below it — the drag
    // or number edit is the explicit approval for that crop.
    allowCropBelowBaseline: edge < bottom || frame.allowCropBelowBaseline,
  });
}
function addFrame(region?: Rect): void {
  if (sourceIdentity === null) return;
  const id = nextFrameId(job.frames);
  const template = job.frames[0];
  const frame =
    region !== undefined || template === undefined
      ? frameFromRegion(
          id,
          sourceIdentity,
          region ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
        )
      : {
          ...frameFromRegion(id, sourceIdentity, template.region),
          outputWidth: template.outputWidth,
          outputHeight: template.outputHeight,
        };
  emitFrames([...job.frames, frame]);
  const loopId = firstLoopId();
  emit(
    "update-loops",
    job.loops.map((loop) =>
      loop.id === loopId && "frameIds" in loop
        ? { ...loop, frameIds: [...loop.frameIds, id] }
        : loop,
    ),
  );
}
function removeFrame(id: string): void {
  emitFrames(job.frames.filter((frame) => frame.id !== id));
  emit(
    "update-loops",
    job.loops.map((loop) =>
      "frameIds" in loop ? { ...loop, frameIds: loop.frameIds.filter((f) => f !== id) } : loop,
    ),
  );
}
function splitFrame(id: string, direction: "vertical" | "horizontal"): void {
  const frame = job.frames.find((entry) => entry.id === id);
  if (frame === undefined) return;
  const rightId = nextFrameId(job.frames);
  const pair = splitFrameRegions(frame, direction, rightId);
  if (pair === null) return;
  emitFrames(job.frames.flatMap((entry) => (entry.id === id ? [...pair] : [entry])));
  emit(
    "update-loops",
    job.loops.map((loop) =>
      "frameIds" in loop
        ? { ...loop, frameIds: loop.frameIds.flatMap((f) => (f === id ? [id, rightId] : [f])) }
        : loop,
    ),
  );
}
function moveFrameOrder(id: string, delta: number): void {
  const index = job.frames.findIndex((frame) => frame.id === id);
  if (index < 0) return;
  emitFrames(reordered(job.frames, index, index + delta));
}

/* ---------- source-space pointer editing ---------- */

const sourceWrap = useTemplateRef("sourceWrap");
interface Drag {
  readonly kind: "create" | "move" | "resize" | "baseline";
  readonly frameId?: string;
  readonly startX: number;
  readonly startY: number;
  readonly origin: Rect;
}
const drag = ref<Drag>();
const dragRect = ref<Rect>();
const dragBaseline = ref<number>();

function sourcePoint(event: PointerEvent): { x: number; y: number } {
  const el = sourceWrap.value!;
  const bounds = el.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * sourceWidth,
    y: ((event.clientY - bounds.top) / bounds.height) * sourceHeight,
  };
}
function frameRect(frame: ViewRecipeFrame): Rect {
  if (drag.value?.frameId === frame.id && dragRect.value !== undefined) return dragRect.value;
  return frame.region;
}
function baselineOf(frame: ViewRecipeFrame): number {
  if (
    drag.value?.frameId === frame.id &&
    drag.value.kind === "baseline" &&
    dragBaseline.value !== undefined
  )
    return dragBaseline.value;
  return frame.sourceAnchor.baselineEdgeY;
}
function onSourceDown(event: PointerEvent): void {
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-drag]");
  const point = sourcePoint(event);
  const kind = (handle?.dataset["drag"] ?? "create") as Drag["kind"];
  const frameId = handle?.dataset["frame"];
  const frame = job.frames.find((entry) => entry.id === frameId);
  if (kind !== "create" && frame === undefined) return;
  drag.value = {
    kind,
    ...(frame !== undefined ? { frameId: frame.id } : {}),
    startX: point.x,
    startY: point.y,
    origin: frame !== undefined ? { ...frame.region } : { x: 0, y: 0, width: 0, height: 0 },
  };
  if (kind === "create") dragRect.value = { x: point.x, y: point.y, width: 0, height: 0 };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onSourceMove(event: PointerEvent): void {
  const active = drag.value;
  if (active === undefined) return;
  const point = sourcePoint(event);
  if (active.kind === "create") {
    dragRect.value = {
      x: Math.min(active.startX, point.x),
      y: Math.min(active.startY, point.y),
      width: Math.abs(point.x - active.startX),
      height: Math.abs(point.y - active.startY),
    };
  } else if (active.kind === "move") {
    dragRect.value = {
      x: active.origin.x + Math.round(point.x - active.startX),
      y: active.origin.y + Math.round(point.y - active.startY),
      width: active.origin.width,
      height: active.origin.height,
    };
  } else if (active.kind === "resize") {
    dragRect.value = {
      x: active.origin.x,
      y: active.origin.y,
      width: Math.max(1, active.origin.width + Math.round(point.x - active.startX)),
      height: Math.max(1, active.origin.height + Math.round(point.y - active.startY)),
    };
  } else {
    dragBaseline.value = Math.round(point.y);
  }
}
function onSourceUp(): void {
  const active = drag.value;
  if (active === undefined) return;
  const rect = dragRect.value;
  if (active.kind === "create") {
    const region = rect === undefined ? null : clampRegion(rect, sourceWidth, sourceHeight);
    if (region !== null) addFrame(region);
  } else if (active.frameId !== undefined) {
    if (active.kind === "baseline" && dragBaseline.value !== undefined) {
      patchFrameBaseline(active.frameId, dragBaseline.value);
    } else if (rect !== undefined) {
      const clamped = clampRegion(rect, sourceWidth, sourceHeight);
      if (clamped !== null)
        patchFrame(active.frameId, {
          region: clamped,
          sourceAnchor: {
            ...job.frames.find((frame) => frame.id === active.frameId)!.sourceAnchor,
            x: clamped.x + Math.floor(clamped.width / 2),
          },
        });
    }
  }
  drag.value = undefined;
  dragRect.value = undefined;
  dragBaseline.value = undefined;
}

/* ---------- grid ---------- */

const gridColumns = ref(3);
const gridRows = ref(1);
function applyGrid(): void {
  const regions = gridRegions(sourceWidth, sourceHeight, gridColumns.value, gridRows.value);
  if (regions.length === 0 || sourceIdentity === null) return;
  const frames = regions.map((region, index) =>
    frameFromRegion(`f${index}`, sourceIdentity, region),
  );
  emitFrames(frames);
  // Rebuilt frames get fresh ids: the first cels loop takes them in order,
  // other cels loops empty, mirror loops still resolve by loop id.
  let first = true;
  emit(
    "update-loops",
    job.loops.map((loop) => {
      if (!("frameIds" in loop)) return loop;
      if (first) {
        first = false;
        return { ...loop, frameIds: frames.map((frame) => frame.id) };
      }
      return { ...loop, frameIds: [] };
    }),
  );
}

/* ---------- loops ---------- */

function firstLoopId(): string {
  const loop = job.loops[0];
  return loop !== undefined && "frameIds" in loop ? loop.id : (job.loops[0]?.id ?? "");
}
function loopOf(frameId: string): string {
  for (const loop of job.loops)
    if ("frameIds" in loop && loop.frameIds.includes(frameId)) return loop.id;
  return "";
}
function moveFrame(frameId: string, loopId: string): void {
  emit(
    "update-loops",
    job.loops.map((loop) => {
      if (!("frameIds" in loop)) return loop;
      const frameIds = loop.frameIds.filter((f) => f !== frameId);
      if (loop.id === loopId) frameIds.push(frameId);
      return { ...loop, frameIds };
    }),
  );
}
function addLoop(): void {
  emit("update-loops", [...job.loops, { id: nextLoopId(job.loops), frameIds: [] }]);
}
function moveLoopOrder(id: string, delta: number): void {
  const index = job.loops.findIndex((loop) => loop.id === id);
  if (index < 0) return;
  emit("update-loops", reordered(job.loops, index, index + delta));
}
function makeMirror(loopId: string, targetId: string): void {
  emit(
    "update-loops",
    job.loops.map((loop) =>
      loop.id === loopId ? { id: loopId, mirrorOf: targetId, explicitlyApproved: true } : loop,
    ),
  );
}
function makeCels(loopId: string): void {
  emit(
    "update-loops",
    job.loops.map((loop) => (loop.id === loopId ? { id: loop.id, frameIds: [] } : loop)),
  );
}
function setFacing(loopId: string, facing: ViewFacing | ""): void {
  emit(
    "update-loops",
    job.loops.map((loop) =>
      loop.id === loopId
        ? facing === ""
          ? "frameIds" in loop
            ? { id: loop.id, frameIds: loop.frameIds }
            : { id: loop.id, mirrorOf: loop.mirrorOf, explicitlyApproved: true }
          : { ...loop, facing }
        : loop,
    ),
  );
}
function removeLoop(loopId: string): void {
  emit(
    "update-loops",
    job.loops.filter((loop) => loop.id !== loopId),
  );
}
function num(event: Event): number {
  return Math.floor(Number((event.target as HTMLInputElement).value) || 0);
}

/* ---------- prepared cel thumbnails ---------- */

const celCanvases = useTemplateRef("cels");
watchEffect(
  () => {
    const canvases = celCanvases.value ?? [];
    for (const frame of prepared?.frames ?? []) {
      const index = job.frames.findIndex((entry) => entry.id === frame.id);
      const canvas = canvases[index];
      if (canvas === undefined) continue;
      canvas.width = frame.width;
      canvas.height = frame.height;
      drawPreparedCel(canvas, frame);
    }
  },
  { flush: "post" },
);
const sourceCanvas = useTemplateRef("sourceCanvas");
watchEffect(
  () => {
    const canvas = sourceCanvas.value;
    if (canvas === null || sourcePixels === null) return;
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    drawRaster(canvas, sourcePixels, sourceWidth, sourceHeight);
  },
  { flush: "post" },
);

const celsLoops = computed(() => job.loops.filter((loop) => "frameIds" in loop));
const boxStyle = (rect: Rect) => ({
  left: `${(rect.x / sourceWidth) * 100}%`,
  top: `${(rect.y / sourceHeight) * 100}%`,
  width: `${(rect.width / sourceWidth) * 100}%`,
  height: `${(rect.height / sourceHeight) * 100}%`,
});
const baselineStyle = (frame: ViewRecipeFrame) => {
  const rect = frameRect(frame);
  const edge = Math.max(rect.y, Math.min(baselineOf(frame), rect.y + rect.height));
  return { top: `${((edge - rect.y) / rect.height) * 100}%` };
};
</script>

<template>
  <div class="frames" data-testid="frame-editor">
    <div
      ref="sourceWrap"
      class="frames__source"
      :style="{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }"
      data-testid="frame-source"
      @pointerdown="onSourceDown"
      @pointermove="onSourceMove"
      @pointerup="onSourceUp"
      @pointercancel="onSourceUp"
    >
      <canvas ref="sourceCanvas" class="frames__sourcecanvas" aria-hidden="true" />
      <div
        v-for="frame in job.frames"
        :key="frame.id"
        class="frames__box"
        :class="{ 'frames__box--drag': drag?.frameId === frame.id }"
        :style="boxStyle(frameRect(frame))"
        :data-frame="frame.id"
        data-drag="move"
      >
        <span class="frames__boxid">{{ frame.id }}</span>
        <span
          class="frames__baseline"
          :style="baselineStyle(frame)"
          :data-frame="frame.id"
          data-drag="baseline"
          title="Feet row: drag vertically"
        />
        <span class="frames__handle" :data-frame="frame.id" data-drag="resize" aria-hidden="true" />
      </div>
      <div
        v-if="drag?.kind === 'create' && dragRect"
        class="frames__box frames__box--new"
        :style="boxStyle(dragRect)"
      />
    </div>
    <p class="frames__hint">Drag on the source to draw a frame box; drag a box to move it.</p>

    <div class="frames__grid">
      <label class="frames__field">
        <span>Columns</span>
        <input
          v-model.number="gridColumns"
          type="number"
          min="1"
          :max="sourceWidth"
          aria-label="Grid columns"
        />
      </label>
      <label class="frames__field">
        <span>Rows</span>
        <input
          v-model.number="gridRows"
          type="number"
          min="1"
          :max="sourceHeight"
          aria-label="Grid rows"
        />
      </label>
      <UiButton size="sm" variant="ghost" @click="applyGrid">Apply grid</UiButton>
      <UiButton size="sm" icon="plus" @click="addFrame()">Add frame</UiButton>
    </div>

    <p v-if="job.frames.length === 0" class="frames__empty" role="status">
      No frames yet. Drag on the source or add one to begin.
    </p>
    <ul v-else class="frames__list" role="list">
      <li
        v-for="(frame, index) in job.frames"
        :key="frame.id"
        class="frames__row"
        :data-frame="frame.id"
      >
        <canvas ref="cels" class="frames__cel" aria-hidden="true" />
        <div class="frames__fields">
          <span class="frames__id">{{ frame.id }}</span>
          <label class="frames__field">
            <span>Region</span>
            <span class="frames__quad">
              <input
                type="number"
                :value="drafts.show(frameKey(frame, 'region.x'), frameStamp(frame), frame.region.x)"
                min="0"
                :max="sourceWidth - 1"
                aria-label="Region x"
                @input="drafts.edit(frameKey(frame, 'region.x'), frameStamp(frame), $event)"
                @change="
                  commitField(frameKey(frame, 'region.x'), frameStamp(frame), $event, (t) =>
                    patchFrameRect(frame.id, { x: Math.floor(Number(t)) }),
                  )
                "
                @keydown.escape="revertField(frameKey(frame, 'region.x'), frame.region.x, $event)"
              />
              <input
                type="number"
                :value="drafts.show(frameKey(frame, 'region.y'), frameStamp(frame), frame.region.y)"
                min="0"
                :max="sourceHeight - 1"
                aria-label="Region y"
                @input="drafts.edit(frameKey(frame, 'region.y'), frameStamp(frame), $event)"
                @change="
                  commitField(frameKey(frame, 'region.y'), frameStamp(frame), $event, (t) =>
                    patchFrameRect(frame.id, { y: Math.floor(Number(t)) }),
                  )
                "
                @keydown.escape="revertField(frameKey(frame, 'region.y'), frame.region.y, $event)"
              />
              <input
                type="number"
                :value="
                  drafts.show(
                    frameKey(frame, 'region.width'),
                    frameStamp(frame),
                    frame.region.width,
                  )
                "
                min="1"
                :max="sourceWidth"
                aria-label="Region width"
                @input="drafts.edit(frameKey(frame, 'region.width'), frameStamp(frame), $event)"
                @change="
                  commitField(frameKey(frame, 'region.width'), frameStamp(frame), $event, (t) =>
                    patchFrameRect(frame.id, { width: Math.max(1, Math.floor(Number(t))) }),
                  )
                "
                @keydown.escape="
                  revertField(frameKey(frame, 'region.width'), frame.region.width, $event)
                "
              />
              <input
                type="number"
                :value="
                  drafts.show(
                    frameKey(frame, 'region.height'),
                    frameStamp(frame),
                    frame.region.height,
                  )
                "
                min="1"
                :max="sourceHeight"
                aria-label="Region height"
                @input="drafts.edit(frameKey(frame, 'region.height'), frameStamp(frame), $event)"
                @change="
                  commitField(frameKey(frame, 'region.height'), frameStamp(frame), $event, (t) =>
                    patchFrameRect(frame.id, { height: Math.max(1, Math.floor(Number(t))) }),
                  )
                "
                @keydown.escape="
                  revertField(frameKey(frame, 'region.height'), frame.region.height, $event)
                "
              />
            </span>
          </label>
          <label class="frames__field">
            <span>Size</span>
            <span class="frames__quad">
              <input
                type="number"
                :value="
                  drafts.show(frameKey(frame, 'outputWidth'), frameStamp(frame), frame.outputWidth)
                "
                min="1"
                max="160"
                aria-label="Output width"
                @input="drafts.edit(frameKey(frame, 'outputWidth'), frameStamp(frame), $event)"
                @change="
                  commitField(frameKey(frame, 'outputWidth'), frameStamp(frame), $event, (t) =>
                    patchFrame(frame.id, { outputWidth: Math.max(1, Math.floor(Number(t))) }),
                  )
                "
                @keydown.escape="
                  revertField(frameKey(frame, 'outputWidth'), frame.outputWidth, $event)
                "
              />
              <input
                type="number"
                :value="
                  drafts.show(
                    frameKey(frame, 'outputHeight'),
                    frameStamp(frame),
                    frame.outputHeight,
                  )
                "
                min="1"
                max="168"
                aria-label="Output height"
                @input="drafts.edit(frameKey(frame, 'outputHeight'), frameStamp(frame), $event)"
                @change="
                  commitField(frameKey(frame, 'outputHeight'), frameStamp(frame), $event, (t) =>
                    patchFrame(frame.id, { outputHeight: Math.max(1, Math.floor(Number(t))) }),
                  )
                "
                @keydown.escape="
                  revertField(frameKey(frame, 'outputHeight'), frame.outputHeight, $event)
                "
              />
            </span>
          </label>
          <label class="frames__field">
            <span>Baseline</span>
            <input
              type="number"
              :value="
                drafts.show(
                  frameKey(frame, 'baseline'),
                  frameStamp(frame),
                  frame.sourceAnchor.baselineEdgeY,
                )
              "
              min="0"
              :max="sourceHeight"
              aria-label="Feet row"
              @input="drafts.edit(frameKey(frame, 'baseline'), frameStamp(frame), $event)"
              @change="
                commitField(frameKey(frame, 'baseline'), frameStamp(frame), $event, (t) =>
                  patchFrameBaseline(frame.id, Math.floor(Number(t))),
                )
              "
              @keydown.escape="
                revertField(frameKey(frame, 'baseline'), frame.sourceAnchor.baselineEdgeY, $event)
              "
            />
          </label>
          <label class="frames__field">
            <span>Loop</span>
            <UiSelect
              size="sm"
              :model-value="loopOf(frame.id)"
              aria-label="Loop"
              @update:model-value="moveFrame(frame.id, String($event))"
            >
              <option v-for="loop in celsLoops" :key="loop.id" :value="loop.id">
                {{ loop.id }}
              </option>
              <option value="">(none)</option>
            </UiSelect>
          </label>
        </div>
        <span class="frames__actions">
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="index === 0"
            title="Move earlier"
            @click="moveFrameOrder(frame.id, -1)"
            >↑</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="index === job.frames.length - 1"
            title="Move later"
            @click="moveFrameOrder(frame.id, 1)"
            >↓</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            title="Split into left and right halves"
            @click="splitFrame(frame.id, 'vertical')"
            >Split |</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            title="Split into top and bottom halves"
            @click="splitFrame(frame.id, 'horizontal')"
            >Split —</UiButton
          >
          <UiButton size="sm" variant="ghost" @click="removeFrame(frame.id)">Remove</UiButton>
        </span>
      </li>
    </ul>

    <div class="frames__loops">
      <h3 class="frames__sub">Loops</h3>
      <ul role="list" class="frames__looplist">
        <li v-for="(loop, loopIndex) in job.loops" :key="loop.id" class="frames__looprow">
          <span class="frames__id">{{ loop.id }}</span>
          <template v-if="'frameIds' in loop">
            <span class="frames__loopmeta">{{ loop.frameIds.join(", ") || "no frames" }}</span>
          </template>
          <template v-else>
            <span class="frames__loopmeta">mirror of {{ loop.mirrorOf }} (approved)</span>
          </template>
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="loopIndex === 0"
            title="Move loop earlier"
            @click="moveLoopOrder(loop.id, -1)"
            >↑</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="loopIndex === job.loops.length - 1"
            title="Move loop later"
            @click="moveLoopOrder(loop.id, 1)"
            >↓</UiButton
          >
          <UiSelect
            size="sm"
            :model-value="loop.facing ?? ''"
            aria-label="Facing"
            @update:model-value="setFacing(loop.id, String($event) as ViewFacing | '')"
          >
            <option value="">facing…</option>
            <option v-for="facing in FACINGS" :key="facing" :value="facing">{{ facing }}</option>
          </UiSelect>
          <template v-if="'frameIds' in loop">
            <UiSelect
              v-if="job.loops.indexOf(loop) > 0"
              size="sm"
              model-value=""
              aria-label="Mirror another loop"
              @update:model-value="makeMirror(loop.id, String($event))"
            >
              <option value="">make mirror…</option>
              <option
                v-for="target in celsLoops.filter(
                  (t) => job.loops.indexOf(t) < job.loops.indexOf(loop),
                )"
                :key="target.id"
                :value="target.id"
              >
                mirror of {{ target.id }}
              </option>
            </UiSelect>
          </template>
          <UiButton v-else size="sm" variant="ghost" @click="makeCels(loop.id)"
            >Use own frames</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="job.loops.length <= 1"
            title="A view needs at least one loop"
            @click="removeLoop(loop.id)"
            >Remove</UiButton
          >
        </li>
      </ul>
      <UiButton size="sm" icon="plus" @click="addLoop">Add loop</UiButton>
    </div>

    <div class="frames__mask">
      <h3 class="frames__sub">Transparency</h3>
      <label class="frames__field">
        <span>Alpha below</span>
        <input
          type="range"
          min="0"
          max="255"
          :value="job.mask.alphaThreshold"
          aria-label="Alpha threshold"
          @input="
            emit('update-mask', {
              alphaThreshold: num($event),
              key: job.mask.key,
            })
          "
        />
        <span class="frames__value">{{ job.mask.alphaThreshold }}</span>
      </label>
      <label class="frames__field">
        <input
          type="checkbox"
          :checked="job.mask.key !== null"
          aria-label="Use transparent colour"
          @change="
            emit('update-mask', {
              alphaThreshold: job.mask.alphaThreshold,
              key: ($event.target as HTMLInputElement).checked
                ? { mode: 'ega-index-v1', rgb: [255, 0, 255] }
                : null,
            })
          "
        />
        <span>Transparent colour</span>
        <input
          v-if="job.mask.key !== null"
          type="color"
          :value="`#${job.mask.key.rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`"
          aria-label="Transparent colour"
          @input="
            emit('update-mask', {
              alphaThreshold: job.mask.alphaThreshold,
              key: {
                mode: 'ega-index-v1',
                rgb: [
                  parseInt(($event.target as HTMLInputElement).value.slice(1, 3), 16),
                  parseInt(($event.target as HTMLInputElement).value.slice(3, 5), 16),
                  parseInt(($event.target as HTMLInputElement).value.slice(5, 7), 16),
                ],
              },
            })
          "
        />
      </label>
    </div>

    <label class="frames__field frames__description">
      <span>Description</span>
      <input
        type="text"
        :value="drafts.show(descriptionKey(), job.description, job.description)"
        placeholder="A short note for the recipe"
        aria-label="Description"
        @input="drafts.edit(descriptionKey(), job.description, $event)"
        @change="
          drafts.commit(
            descriptionKey(),
            job.description,
            $event,
            () => true,
            (t) => emit('update-description', t),
          )
        "
        @keydown.escape="revertField(descriptionKey(), job.description, $event)"
      />
    </label>

    <p v-if="preparedError" class="frames__error" role="alert">{{ preparedError }}</p>
    <ul v-else-if="prepared" class="frames__diag">
      <li>
        {{ prepared.diagnostics.totals.cels }} cels,
        {{ prepared.diagnostics.totals.payloadBytes }} bytes, EGA palette
      </li>
      <li v-for="frame in prepared.frames" :key="frame.id">
        {{ frame.id }}: {{ frame.width }}×{{ frame.height }}, {{ frame.diagnostics.opaque }} opaque,
        {{ frame.diagnostics.alphaErased }} erased by alpha<template
          v-if="frame.diagnostics.keyErased > 0"
          >, {{ frame.diagnostics.keyErased }} by key</template
        ><template v-if="frame.diagnostics.cropLoss.belowBaseline.opaque > 0"
          >, {{ frame.diagnostics.cropLoss.belowBaseline.opaque }} px below the feet</template
        ><template v-if="frame.diagnostics.cropLoss.outsideCanvas.opaque > 0"
          >, {{ frame.diagnostics.cropLoss.outsideCanvas.opaque }} px outside canvas</template
        >
      </li>
    </ul>
  </div>
</template>

<style scoped>
.frames {
  display: grid;
  /* A pinned column: frame rows, quads and tool rows wrap inside the panel
     instead of widening it past the dock's clip. */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
}
.frames__source {
  position: relative;
  width: 100%;
  max-width: 26rem;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  overflow: hidden;
  touch-action: none;
  cursor: crosshair;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 0 0 / 12px
    12px;
}
.frames__sourcecanvas {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}
.frames__box {
  position: absolute;
  border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  cursor: move;
}
.frames__box--new {
  border-style: dashed;
  pointer-events: none;
}
.frames__boxid {
  position: absolute;
  top: 0;
  left: 0;
  padding: 0 var(--space-1);
  background: var(--accent);
  color: var(--surface-0);
  font: var(--weight-semibold) var(--text-2xs) / 1.4 var(--font-mono);
  pointer-events: none;
}
.frames__baseline {
  position: absolute;
  left: 0;
  right: 0;
  height: 6px;
  margin-top: -3px;
  cursor: ns-resize;
}
.frames__baseline::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 2px;
  border-top: 2px dashed var(--warn);
}
.frames__handle {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 10px;
  height: 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--surface-0);
  cursor: nwse-resize;
}
.frames__hint {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.frames__grid {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}
.frames__empty {
  margin: 0;
  padding: var(--space-3);
  border: 1px dashed var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.frames__list,
.frames__looplist {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.frames__row,
.frames__looprow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
}
.frames__cel {
  width: 48px;
  height: 64px;
  object-fit: contain;
  image-rendering: pixelated;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 0 0 / 12px
    12px;
}
.frames__fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  min-width: 0;
  flex: 1;
}
.frames__field {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.frames__field input[type="number"],
.frames__field input[type="text"] {
  width: 4.5rem;
  padding: 2px var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-0);
  color: var(--ink);
  font: var(--weight-medium) var(--text-xs) / 1.6 var(--font-mono);
}
.frames__grid input[type="number"] {
  width: 3.5rem;
}
.frames__description {
  display: flex;
  flex: 1 1 100%;
}
.frames__description input[type="text"] {
  flex: 1;
  min-width: 0;
  width: auto;
}
.frames__quad {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.frames__quad input {
  width: 3.5rem;
}
.frames__id {
  color: var(--ink);
  font: var(--weight-semibold) var(--text-xs) / 1 var(--font-mono);
}
.frames__actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.frames__loopmeta {
  color: var(--ink-2);
  font-size: var(--text-xs);
  flex: 1;
}
.frames__sub {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.frames__loops,
.frames__mask {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
}
.frames__value {
  color: var(--ink-2);
  font: var(--weight-medium) var(--text-xs) / 1 var(--font-mono);
}
.frames__error {
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
}
.frames__diag {
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
</style>
