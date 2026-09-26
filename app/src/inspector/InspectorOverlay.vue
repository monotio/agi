<script setup lang="ts">
/**
 * The inspector's marks over the stage: object boxes with their baselines,
 * headings and move targets, the horizon and priority base, the hover
 * crosshair and the latched pick. While Inspect is armed the canvas takes
 * the stage's clicks — they latch a pick and never reach the game. In the
 * exploded view every mark is projected onto its priority band's layer.
 */
import { onBeforeUnmount, useTemplateRef, watch } from "vue";
import { useEngineApi } from "../engineContext.ts";
import { usePresentation } from "../usePresentation.ts";
import {
  cropFrameRgba,
  inspectPixel,
  latchPickAt,
  overlayBoxes,
  pickFromClient,
  pickVisualSource,
  type PickPoint,
} from "../debugView.ts";
import { useInspector } from "./useInspector.ts";

const { state } = useEngineApi();
const presentation = usePresentation();
const { debugFrame, debugViewMode } = presentation;
const inspector = useInspector();
const { overlayOn, inspectArmed, hover, picked, report } = inspector;
const overlayCanvas = useTemplateRef("overlayCanvas");

function eventPoint(ev: PointerEvent): PickPoint | null {
  const el = ev.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const frame = debugFrame.value;
  if (debugViewMode.value === "explode") {
    // Layers are displaced by depth — a flat mapping picks the wrong pixel.
    // Raycast the tap into the layer stack instead.
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const hit = presentation.debugPick3d(nx, ny);
    if (!hit) return null;
    const bandLayer =
      hit.kind === "control" ||
      hit.kind === "picture" ||
      hit.kind === "sprite" ||
      hit.kind === "preview";
    const point: PickPoint = {
      // Band layers pick in logical picture space; the text surface and
      // background report frame space (no logical pixel exists there).
      logical: bandLayer ? { x: hit.x, y: hit.y } : null,
      displayed: bandLayer
        ? { x: hit.x * 2, y: (frame?.picRow ?? 1) * 8 + hit.y }
        : { x: hit.x, y: hit.y },
      layerKind: hit.kind,
    };
    if (hit.band !== undefined) point.layerBand = hit.band;
    return point;
  }
  return pickFromClient(ev.clientX, ev.clientY, rect, frame?.picRow ?? 1);
}

function onOverlayMove(ev: PointerEvent): void {
  const point = eventPoint(ev);
  const frame = debugFrame.value;
  if (!point?.logical || !frame) {
    hover.value = point ? { point, inspection: null } : undefined;
    return;
  }
  hover.value = {
    point,
    inspection: inspectPixel(
      frame,
      point.logical.x,
      point.logical.y,
      point.layerKind === undefined
        ? undefined
        : {
            kind: point.layerKind,
            ...(point.layerBand !== undefined ? { band: point.layerBand } : {}),
          },
    ),
  };
}

function cropToDataUrl(width: number, height: number, data: Uint8Array): string {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return c.toDataURL();
}

function onOverlayClick(ev: PointerEvent): void {
  const point = eventPoint(ev);
  const frame = debugFrame.value;
  if (!point?.logical || !frame) {
    picked.value = undefined;
    return;
  }
  const latch = latchPickAt(frame, point);
  if (!latch) return;
  // Crop the same surface the inspection sampled — the picked layer's own.
  const surface = pickVisualSource(frame, point.layerKind) ?? frame.visual;
  const crop = cropFrameRgba(frame, point.logical.x, point.logical.y, 12, surface);
  picked.value = { ...latch, cropUrl: cropToDataUrl(crop.width, crop.height, crop.data) };
}

// ---- drawing -------------------------------------------------------------------

const DIR_DELTA: [number, number][] = [
  [0, 0],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** Mark colours are the AGI palette's own: marks annotate game pixels. */
const MARK = {
  horizon: "rgba(85,255,255,0.65)",
  base: "rgba(255,85,255,0.55)",
  box: "rgba(85,255,255,0.9)",
  hot: "#ffff55",
  heading: "#55ff55",
  target: "rgba(255,170,40,0.9)",
  tether: "rgba(255,255,255,0.45)",
  hover: "rgba(255,255,255,0.7)",
} as const;

function drawOverlay(): void {
  const c = overlayCanvas.value;
  const ctx = c?.getContext("2d");
  if (!c || !ctx) return;
  ctx.clearRect(0, 0, 320, 200);
  if (!overlayOn.value && !inspectArmed.value) return;
  const picTop = (debugFrame.value?.picRow ?? 1) * 8;
  const r = report.value;
  const exploded = debugViewMode.value === "explode";

  // Logical pic coords → overlay px. Exploded projects onto the band's layer
  // so marks hug the displaced sprites instead of their flat positions.
  const px = (band: number, x: number, y: number): [number, number] => {
    if (exploded) {
      const p = presentation.debugProject(band, x, y);
      if (p) return [p.x, p.y];
    }
    return [x * 2, picTop + y];
  };

  if (overlayOn.value) {
    // Horizon (cyan) and priority base (magenta) hug the control layer.
    if (r) {
      for (const [y, color] of [
        [r.horizon, MARK.horizon],
        [r.priorityBase, MARK.base],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const [x0, y0] = px(3, 0, y);
        const [x1, y1] = px(3, 160, y);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    ctx.font = "6px monospace";
    ctx.textBaseline = "top";
    for (const box of overlayBoxes(state.debugObjects)) {
      const hot = box.label === `o${picked.value?.inspection.owner ?? -1}`;
      const band = box.priority;
      // Project the box's four corners onto the object's layer — perspective
      // keystones the rectangle, so draw the quad, not an axis-aligned bbox.
      const corners = [
        px(band, box.x, box.y),
        px(band, box.x + box.w, box.y),
        px(band, box.x + box.w, box.y + box.h),
        px(band, box.x, box.y + box.h),
      ];
      ctx.strokeStyle = hot ? MARK.hot : MARK.box;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(corners[0]![0], corners[0]![1]);
      for (const pt of corners.slice(1)) ctx.lineTo(pt[0], pt[1]);
      ctx.closePath();
      ctx.stroke();
      // Baseline.
      ctx.fillStyle = hot ? MARK.hot : MARK.box;
      const [b0x, b0y] = px(band, box.x, box.baseline);
      const [b1x, b1y] = px(band, box.x + box.w, box.baseline);
      ctx.beginPath();
      ctx.moveTo(b0x, b0y);
      ctx.lineTo(b1x, b1y);
      ctx.stroke();
      ctx.fillText(`${box.label}·p${box.priority}`, corners[0]![0], corners[0]![1] - 7);
      // Heading arrow.
      const [dx, dy] = DIR_DELTA[box.direction] ?? [0, 0];
      if (dx || dy) {
        const len = Math.max(4, box.stepSize * 3);
        const [cx, cy] = px(band, box.x + box.w / 2, box.baseline - box.h / 2);
        const [ex, ey] = px(
          band,
          box.x + box.w / 2 + dx * len,
          box.baseline - box.h / 2 + dy * len,
        );
        ctx.strokeStyle = MARK.heading;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
      if (box.moveTarget) {
        const [sx, sy] = px(band, box.x + box.w / 2, box.baseline);
        const [tx, ty] = px(band, box.moveTarget.x, box.moveTarget.y);
        ctx.strokeStyle = MARK.target;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (exploded) {
        // Ground tether: the sprite floats on its band while the collision
        // logic still thinks in flat space — drop a plumb line to the same
        // logical point projected on the control layer, and mark it.
        const [fx, fy] = px(band, box.x + box.w / 2, box.baseline);
        const [gx, gy] = px(3, box.x + box.w / 2, box.baseline);
        ctx.strokeStyle = MARK.tether;
        ctx.setLineDash([1, 2]);
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(gx, gy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeRect(gx - 2, gy - 2, 5, 5);
      }
    }
  }

  // Hover crosshair and latched pick marker ride the pixel's own band.
  const h = hover.value;
  if (inspectArmed.value && h?.point.logical) {
    const [hx, hy] = px(h.inspection?.priority ?? 4, h.point.logical.x, h.point.logical.y);
    ctx.strokeStyle = MARK.hover;
    ctx.strokeRect(hx - 2, hy - 1, 6, 3);
  }
  const p = picked.value;
  if (p?.point.logical) {
    const [ppx, ppy] = px(p.inspection.priority, p.point.logical.x, p.point.logical.y);
    ctx.strokeStyle = MARK.hot;
    ctx.strokeRect(ppx - 3, ppy - 2, 8, 5);
    ctx.strokeRect(ppx - 1, ppy, 4, 1);
  }
}

watch([debugFrame, overlayOn, inspectArmed, picked, hover, report], drawOverlay);

// While exploded, the camera keeps easing toward the pointer — redraw every
// frame so projected marks track the parallax instead of lagging behind.
let overlayRaf: number | null = null;
watch(
  debugViewMode,
  (m) => {
    if (m === "explode" && overlayRaf === null) {
      const tick = () => {
        drawOverlay();
        overlayRaf = requestAnimationFrame(tick);
      };
      overlayRaf = requestAnimationFrame(tick);
    } else if (m !== "explode" && overlayRaf !== null) {
      cancelAnimationFrame(overlayRaf);
      overlayRaf = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (overlayRaf !== null) cancelAnimationFrame(overlayRaf);
});
</script>

<template>
  <canvas
    ref="overlayCanvas"
    class="dbg-overlay"
    :class="{ armed: inspectArmed }"
    width="320"
    height="200"
    data-testid="dbg-overlay"
    @pointermove="onOverlayMove"
    @click.stop.prevent="onOverlayClick"
    @pointerdown.stop
  />
</template>

<style scoped>
.dbg-overlay {
  position: absolute;
  inset: 0;
  /* Above the game surface, below the app's floating chrome: overlay marks
     belong to the game view, windows occlude them. */
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;
  image-rendering: pixelated;
}
.dbg-overlay.armed {
  pointer-events: auto;
  cursor: crosshair;
}
</style>
