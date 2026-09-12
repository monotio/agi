<script setup lang="ts">
/**
 * AGI Inspector — the rc.9 debug surface. Three tabs inside one panel:
 *
 *   Screen   — view modes (visual / Sierra priority / blend / split / GPU
 *              exploded layers), the object overlay, and point-select.
 *   State    — live vars/flags grids with pins, change highlight, and
 *              Sierra's SET VAR / SET FLAG writes; the object table.
 *   Timeline — the per-cycle var/flag diff lane plus the structured
 *              instruction trace stream.
 *
 * Placement follows the usual inspector pattern: docked just outside the
 * frame's right edge by default so it never covers the game; grab the header
 * to float it anywhere over the stage; the − button collapses it to a title
 * strip. The dock also renders the transparent pick layer and the
 * object-overlay canvas over the stage — while pick mode is armed its clicks
 * are swallowed and never reach the game.
 */
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import type { Frame } from "./gameTypes.ts";
import type { ScreenObjectState, TraceRecord } from "../../src/runtime/engine.ts";
import {
  cropFrameRgba,
  describeDebugEvent,
  describeObject,
  formatTraceRecord,
  inspectPixel,
  overlayBoxes,
  pickFromClient,
  type DebugEvent,
  type DebugViewMode,
  type PickPoint,
} from "./debugView.ts";

type StampedTrace = TraceRecord & { seq: number; cycle: number };

interface StateReport {
  vars: number[];
  flags: number[];
  horizon: number;
  priorityBase: number;
  patchGeneration: number;
  room: number;
  egoX: number;
  egoY: number;
  egoDirection: number;
}

const props = defineProps<{
  frame: Frame | null;
  objects: ScreenObjectState[];
  trace: StampedTrace[];
  /** Records the worker dropped from its bounded backlog while we stalled. */
  traceDropped: number;
  channels: { ownership: boolean; objects: boolean; trace: boolean };
  viewMode: DebugViewMode;
  hasGpu: boolean;
  readState: () => Promise<Record<string, unknown>>;
  eventsSince: (since: number) => Promise<Record<string, unknown>>;
  write: (vars: [number, number][], flags: [number, number][]) => Promise<unknown>;
  /**
   * Exploded-view helpers from the GPU stage: project a logical picture point
   * on a priority band's layer into overlay pixels, and raycast a screen tap
   * (NDC -1..1, y up) back into logical picture space. Null while flat.
   */
  project: (band: number, x: number, y: number) => { x: number; y: number } | null;
  pick3d: (nx: number, ny: number) => { x: number; y: number } | null;
}>();

const emit = defineEmits<{
  /**
   * A surface that consumes debug payloads turned on or off. The engine
   * derives the armed channel set from all consumers, so a checkbox can
   * never disarm a channel another view still needs.
   */
  setConsumer: [consumer: "overlay" | "inspect" | "trace", on: boolean];
  setViewMode: [mode: DebugViewMode];
  close: [];
}>();

const tab = ref<"screen" | "state" | "timeline">("screen");
const overlayOn = ref(true);
const inspectArmed = ref(false);
const collapsed = ref(false);
const overlayCanvas = useTemplateRef("overlayCanvas");
const dockEl = useTemplateRef("dock");

// ---------- placement: docked / floating drag / collapsed ----------

const floating = ref(false);
const floatPos = ref({ x: 8, y: 8 });
let drag: { px: number; py: number; ox: number; oy: number } | null = null;

function onHeadPointerDown(ev: PointerEvent): void {
  if ((ev.target as HTMLElement).closest("button")) return;
  const dock = dockEl.value;
  const host = dock?.offsetParent;
  if (!dock || !(host instanceof HTMLElement)) return;
  const hostRect = host.getBoundingClientRect();
  const dockRect = dock.getBoundingClientRect();
  floating.value = true;
  floatPos.value = {
    x: dockRect.left - hostRect.left,
    y: dockRect.top - hostRect.top,
  };
  drag = { px: ev.clientX, py: ev.clientY, ox: floatPos.value.x, oy: floatPos.value.y };
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
}

function onHeadPointerMove(ev: PointerEvent): void {
  if (!drag) return;
  const dock = dockEl.value;
  const host = dock?.offsetParent;
  const w = dock?.offsetWidth ?? 320;
  const h = host instanceof HTMLElement ? host.offsetHeight : 400;
  const hw = host instanceof HTMLElement ? host.offsetWidth : 640;
  floatPos.value = {
    x: Math.min(Math.max(drag.ox + ev.clientX - drag.px, -w + 48), hw - 48),
    y: Math.min(Math.max(drag.oy + ev.clientY - drag.py, 0), h - 36),
  };
}

function onHeadPointerUp(): void {
  drag = null;
}

// ---------- pick / point-select ----------

interface LatchedPick {
  point: PickPoint;
  inspection: { color: number; priority: number; owner: number | null };
  cycle: number;
  patchGeneration: number;
  cropUrl: string;
}

const hover = ref<{
  point: PickPoint;
  inspection: { color: number; priority: number; owner: number | null } | null;
}>();
const picked = ref<LatchedPick>();

const pickedObject = computed<ScreenObjectState | null>(() => {
  const owner = picked.value?.inspection.owner;
  return owner === null || owner === undefined
    ? null
    : (props.objects.find((o) => o.num === owner) ?? null);
});

function eventPoint(ev: PointerEvent): PickPoint | null {
  const el = ev.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  if (props.viewMode === "explode") {
    // Layers are displaced by depth — a flat mapping picks the wrong pixel.
    // Raycast the tap into the layer stack instead.
    const nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    const hit = props.pick3d(nx, ny);
    if (!hit) return null;
    return {
      logical: hit,
      displayed: { x: hit.x * 2, y: (props.frame?.picRow ?? 1) * 8 + hit.y },
    };
  }
  return pickFromClient(ev.clientX, ev.clientY, rect, props.frame?.picRow ?? 1);
}

function onOverlayMove(ev: PointerEvent): void {
  const point = eventPoint(ev);
  if (!point?.logical || !props.frame) {
    hover.value = point ? { point, inspection: null } : undefined;
    return;
  }
  hover.value = {
    point,
    inspection: inspectPixel(props.frame, point.logical.x, point.logical.y),
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
  if (!point?.logical || !props.frame) {
    picked.value = undefined;
    return;
  }
  const { x, y } = point.logical;
  const inspection = inspectPixel(props.frame, x, y);
  if (!inspection) return;
  const crop = cropFrameRgba(props.frame, x, y, 12);
  picked.value = {
    point,
    inspection,
    cycle: props.frame.cycle ?? 0,
    patchGeneration: report.value?.patchGeneration ?? 0,
    cropUrl: cropToDataUrl(crop.width, crop.height, crop.data),
  };
}

async function copyPick(): Promise<void> {
  const p = picked.value;
  if (!p) return;
  const owner = pickedObject.value;
  const payload = {
    logical: p.point.logical,
    displayed: p.point.displayed,
    color: p.inspection.color,
    priority: p.inspection.priority,
    owner: p.inspection.owner,
    object: owner ?? null,
    cycle: p.cycle,
    patchGeneration: p.patchGeneration,
  };
  try {
    await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
  } catch {
    // Clipboard is optional (permissions); the card stays readable.
  }
}

// ---------- state polling ----------

const report = ref<StateReport>();
const prevVars = ref<number[]>([]);
const prevFlags = ref<number[]>([]);
const changedVars = ref<Set<number>>(new Set());
const changedFlags = ref<Set<number>>(new Set());

async function pollState(): Promise<void> {
  try {
    const r = (await props.readState()) as unknown as StateReport;
    const next = new Set<number>();
    for (let i = 0; i < 256; i++) {
      if (prevVars.value.length === 256 && r.vars[i] !== prevVars.value[i]) next.add(i);
    }
    changedVars.value = next;
    prevVars.value = r.vars;
    const fnext = new Set<number>();
    for (let i = 0; i < 256; i++) {
      if (prevFlags.value.length === 256 && r.flags[i] !== prevFlags.value[i]) fnext.add(i);
    }
    changedFlags.value = fnext;
    prevFlags.value = r.flags;
    report.value = r;
  } catch {
    // Worker gone (eject / HMR) — stop polling.
    stopPoll();
  }
}

// ---------- events lane ----------

const events = ref<DebugEvent[]>([]);
let lastEventSeq = 0;

async function pollEvents(): Promise<void> {
  try {
    const r = await props.eventsSince(lastEventSeq);
    const batch = (r["events"] as DebugEvent[] | undefined) ?? [];
    if (batch.length) {
      events.value = [...events.value, ...batch].slice(-800);
      lastEventSeq = Number(r["latestSeq"] ?? lastEventSeq);
    }
  } catch {
    /* same story as pollState */
  }
}

let pollTimer: number | null = null;
function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
onMounted(() => {
  void pollState();
  void pollEvents();
  pollTimer = setInterval(() => {
    void pollState();
    void pollEvents();
  }, 500) as unknown as number;
});
onBeforeUnmount(() => stopPoll());

// ---------- overlay drawing ----------

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

function drawOverlay(): void {
  const c = overlayCanvas.value;
  const ctx = c?.getContext("2d");
  if (!c || !ctx) return;
  ctx.clearRect(0, 0, 320, 200);
  if (!overlayOn.value && !inspectArmed.value) return;
  const frame = props.frame;
  const picTop = (frame?.picRow ?? 1) * 8;
  const r = report.value;
  const exploded = props.viewMode === "explode";

  // Logical pic coords → overlay px. Exploded projects onto the band's layer
  // so marks hug the displaced sprites instead of their flat positions.
  const px = (band: number, x: number, y: number): [number, number] => {
    if (exploded) {
      const p = props.project(band, x, y);
      if (p) return [p.x, p.y];
    }
    return [x * 2, picTop + y];
  };

  if (overlayOn.value) {
    // Horizon (cyan) and priority base (magenta) hug the control layer.
    if (r) {
      for (const [y, color] of [
        [r.horizon, "rgba(85,255,255,0.65)"],
        [r.priorityBase, "rgba(255,85,255,0.55)"],
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
    for (const box of overlayBoxes(props.objects)) {
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
      ctx.strokeStyle = hot ? "#ffff55" : "rgba(85,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(corners[0]![0], corners[0]![1]);
      for (const pt of corners.slice(1)) ctx.lineTo(pt[0], pt[1]);
      ctx.closePath();
      ctx.stroke();
      // Baseline.
      ctx.fillStyle = hot ? "#ffff55" : "rgba(85,255,255,0.9)";
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
        ctx.strokeStyle = "#55ff55";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
      if (box.moveTarget) {
        const [sx, sy] = px(band, box.x + box.w / 2, box.baseline);
        const [tx, ty] = px(band, box.moveTarget.x, box.moveTarget.y);
        ctx.strokeStyle = "rgba(255,170,40,0.9)";
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
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
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
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.strokeRect(hx - 2, hy - 1, 6, 3);
  }
  const p = picked.value;
  if (p?.point.logical) {
    const [ppx, ppy] = px(p.inspection.priority, p.point.logical.x, p.point.logical.y);
    ctx.strokeStyle = "#ffff55";
    ctx.strokeRect(ppx - 3, ppy - 2, 8, 5);
    ctx.strokeRect(ppx - 1, ppy, 4, 1);
  }
}

watch([() => props.frame, overlayOn, inspectArmed, picked, hover, report], drawOverlay);

// While exploded, the camera keeps easing toward the pointer — redraw every
// frame so projected marks track the parallax instead of lagging behind.
let overlayRaf: number | null = null;
watch(
  () => props.viewMode,
  (m) => {
    if (m === "explode" && overlayRaf === null) {
      const tick = () => {
        drawOverlay();
        overlayRaf = requestAnimationFrame(tick);
      };
      overlayRaf = requestAnimationFrame(tick);
    } else if (overlayRaf !== null) {
      cancelAnimationFrame(overlayRaf);
      overlayRaf = null;
    }
  },
);
onBeforeUnmount(() => {
  if (overlayRaf !== null) cancelAnimationFrame(overlayRaf);
});

// ---------- state tab helpers ----------

const pinnedVars = ref<Set<number>>(new Set());
const pinnedFlags = ref<Set<number>>(new Set());
const varEdit = ref<{ index: number; text: string }>();

function togglePin(set: Set<number>, i: number): void {
  if (set.has(i)) set.delete(i);
  else set.add(i);
}

function onVarClick(i: number): void {
  varEdit.value = { index: i, text: String(report.value?.vars[i] ?? 0) };
}

async function applyVar(): Promise<void> {
  const e = varEdit.value;
  if (!e) return;
  const v = Number.parseInt(e.text, 10);
  if (Number.isInteger(v) && v >= 0 && v <= 255) await props.write([[e.index, v]], []);
  varEdit.value = undefined;
}

async function onFlagClick(i: number): Promise<void> {
  const cur = report.value?.flags[i] ?? 0;
  await props.write([], [[i, cur ? 0 : 1]]);
}

// ---------- timeline tab ----------

const filter = ref("");
const eventsFiltered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const list = events.value;
  if (!f) return list;
  return list.filter((e) => describeDebugEvent(e).toLowerCase().includes(f));
});
const traceFiltered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const list = props.trace;
  if (!f) return list;
  return list.filter((r) => formatTraceRecord(r).toLowerCase().includes(f));
});

const traceEl = useTemplateRef("traceEl");
watch(
  () => props.trace.length,
  () => {
    const el = traceEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

function toggleTrace(): void {
  emit("setConsumer", "trace", !props.channels.trace);
}

// The dock unmounts with the inspector closed or the game ejected; release
// its channel consumers so nothing stays armed for a closed surface.
onBeforeUnmount(() => {
  emit("setConsumer", "overlay", false);
  emit("setConsumer", "inspect", false);
  emit("setConsumer", "trace", false);
});

const COLOR_NAMES = [
  "black",
  "blue",
  "green",
  "cyan",
  "red",
  "magenta",
  "brown",
  "l.gray",
  "d.gray",
  "l.blue",
  "l.green",
  "l.cyan",
  "l.red",
  "l.magenta",
  "yellow",
  "white",
];

const MODES: { id: DebugViewMode; label: string; title: string }[] = [
  { id: "visual", label: "Game", title: "Normal picture" },
  { id: "priority", label: "Priority", title: "Priority surface (Sierra show.pri.screen)" },
  { id: "blend", label: "Blend", title: "Depth ramp over the game; control lines hatch" },
  { id: "split", label: "Split", title: "Half game, half priority" },
  { id: "explode", label: "Layers", title: "Exploded priority layers (GPU, pointer parallax)" },
];
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
  <aside
    ref="dock"
    class="debug-dock"
    :class="{ floating, collapsed }"
    :style="floating ? { '--fx': `${floatPos.x}px`, '--fy': `${floatPos.y}px` } : {}"
    data-testid="debug-dock"
    @click.stop
    @pointerdown.stop
  >
    <header
      class="dd-head"
      data-testid="dbg-head"
      title="Drag to float · − collapses · ⇥ re-docks"
      @pointerdown="onHeadPointerDown"
      @pointermove="onHeadPointerMove"
      @pointerup="onHeadPointerUp"
      @pointercancel="onHeadPointerUp"
    >
      <span class="dd-grip">⠿</span>
      <span class="dd-title">Inspector</span>
      <nav v-if="!collapsed" class="dd-tabs">
        <button
          v-for="t in ['screen', 'state', 'timeline'] as const"
          :key="t"
          type="button"
          class="dd-tab"
          :class="{ on: tab === t }"
          :data-testid="`dbg-tab-${t}`"
          @click="tab = t"
        >
          {{ t }}
        </button>
      </nav>
      <button
        v-if="floating"
        type="button"
        class="dd-icon-btn"
        title="Dock beside the frame"
        data-testid="dbg-dock-back"
        @click="floating = false"
      >
        ⇥
      </button>
      <button
        type="button"
        class="dd-icon-btn"
        :title="collapsed ? 'Expand' : 'Collapse'"
        data-testid="dbg-collapse"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? "+" : "−" }}
      </button>
      <button
        type="button"
        class="dd-icon-btn dd-close"
        title="Close inspector"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <!-- ================= SCREEN ================= -->
    <section v-if="tab === 'screen' && !collapsed" class="dd-body">
      <div class="dd-row dd-modes">
        <button
          v-for="m in MODES"
          :key="m.id"
          type="button"
          class="dd-mode"
          :class="{ on: viewMode === m.id }"
          :disabled="m.id === 'explode' && !hasGpu"
          :title="m.id === 'explode' && !hasGpu ? 'Needs the GPU stage' : m.title"
          :data-testid="`dbg-mode-${m.id}`"
          @click="emit('setViewMode', m.id)"
        >
          {{ m.label }}
        </button>
      </div>
      <div class="dd-row">
        <label class="dd-check">
          <input
            v-model="overlayOn"
            type="checkbox"
            data-testid="dbg-overlay-toggle"
            @change="emit('setConsumer', 'overlay', overlayOn)"
          />
          Objects
        </label>
        <label class="dd-check">
          <input
            v-model="inspectArmed"
            type="checkbox"
            data-testid="dbg-inspect-toggle"
            @change="emit('setConsumer', 'inspect', inspectArmed)"
          />
          Inspect
        </label>
        <span class="dd-hint" v-if="inspectArmed">click the scene to latch a pick</span>
      </div>

      <div v-if="inspectArmed && hover?.point" class="dd-hover">
        <template v-if="hover.point.logical">
          ({{ hover.point.logical.x }},{{ hover.point.logical.y }}) disp ({{
            hover.point.displayed.x
          }},{{ hover.point.displayed.y }})
          <template v-if="hover.inspection">
            · {{ COLOR_NAMES[hover.inspection.color] }} · pri {{ hover.inspection.priority }}
            <template v-if="hover.inspection.owner !== null">
              · o{{ hover.inspection.owner }}
            </template>
          </template>
        </template>
        <template v-else>outside picture band</template>
      </div>

      <div v-if="picked" class="pick-card" data-testid="dbg-pick">
        <img
          v-if="picked.cropUrl"
          class="pick-crop"
          :src="picked.cropUrl"
          alt="crop around picked pixel"
        />
        <dl class="pick-fields">
          <dt>logical</dt>
          <dd>({{ picked.point.logical?.x }}, {{ picked.point.logical?.y }})</dd>
          <dt>displayed</dt>
          <dd>({{ picked.point.displayed.x }}, {{ picked.point.displayed.y }})</dd>
          <dt>pixel</dt>
          <dd>{{ COLOR_NAMES[picked.inspection.color] }} · pri {{ picked.inspection.priority }}</dd>
          <dt>owner</dt>
          <dd>{{ pickedObject ? describeObject(pickedObject) : "background" }}</dd>
          <dt>cycle</dt>
          <dd>{{ picked.cycle }} · rev {{ picked.patchGeneration }}</dd>
        </dl>
        <div class="dd-row">
          <button type="button" class="ui-button ui-button--secondary" @click="copyPick">
            Copy pick
          </button>
          <button type="button" class="ui-button ui-button--secondary" @click="picked = undefined">
            Clear
          </button>
        </div>
      </div>
    </section>

    <!-- ================= STATE ================= -->
    <section v-else-if="tab === 'state' && !collapsed" class="dd-body">
      <div class="dd-row dd-statehead">
        <span
          >room {{ report?.room ?? "?" }} · ego ({{ report?.egoX }},{{ report?.egoY }}) dir
          {{ report?.egoDirection }}</span
        >
        <span>rev {{ report?.patchGeneration ?? 0 }}</span>
      </div>

      <h3 class="dd-h3">Vars <span class="dd-hint">click to set · alt-click pins</span></h3>
      <div class="cell-grid" data-testid="dbg-vars">
        <button
          v-for="(v, i) in report?.vars ?? []"
          :key="`v${i}`"
          type="button"
          class="cell"
          :class="{ set: v !== 0, hot: changedVars.has(i), pin: pinnedVars.has(i) }"
          :title="`v${i} = ${v}`"
          @click.exact="onVarClick(i)"
          @click.alt.prevent="togglePin(pinnedVars, i)"
        >
          {{ v }}
        </button>
      </div>
      <form v-if="varEdit" class="dd-row var-edit" @submit.prevent="applyVar">
        <label
          >v{{ varEdit.index }} =
          <input v-model="varEdit.text" data-testid="dbg-var-set" size="4" autofocus
        /></label>
        <button type="submit" class="ui-button ui-button--secondary">set</button>
        <button type="button" class="ui-button ui-button--secondary" @click="varEdit = undefined">
          ×
        </button>
      </form>
      <div v-if="pinnedVars.size" class="dd-pins">
        <span v-for="i in [...pinnedVars].sort((a, b) => a - b)" :key="`pv${i}`" class="pin-tag">
          v{{ i }}={{ report?.vars[i] ?? "?" }}
        </span>
      </div>

      <h3 class="dd-h3">Flags <span class="dd-hint">click toggles · alt-click pins</span></h3>
      <div class="cell-grid" data-testid="dbg-flags">
        <button
          v-for="(f, i) in report?.flags ?? []"
          :key="`f${i}`"
          type="button"
          class="cell"
          :class="{ set: f !== 0, hot: changedFlags.has(i), pin: pinnedFlags.has(i) }"
          :title="`f${i} ${f ? 'set' : 'reset'}`"
          @click.exact="onFlagClick(i)"
          @click.alt.prevent="togglePin(pinnedFlags, i)"
        >
          {{ f ? "1" : "·" }}
        </button>
      </div>
      <div v-if="pinnedFlags.size" class="dd-pins">
        <span v-for="i in [...pinnedFlags].sort((a, b) => a - b)" :key="`pf${i}`" class="pin-tag">
          f{{ i }}={{ report?.flags[i] ?? "?" }}
        </span>
      </div>

      <h3 class="dd-h3">Objects</h3>
      <table class="obj-table" data-testid="dbg-objects">
        <tbody>
          <tr v-for="o in objects" :key="o.num">
            <td>o{{ o.num }}</td>
            <td>v{{ o.view }} l{{ o.loop }} c{{ o.cel }}</td>
            <td>({{ o.x }},{{ o.y }})</td>
            <td>p{{ o.priority }}</td>
            <td>{{ ["—", "move", "follow", "wander"][o.motionMode] }}</td>
          </tr>
          <tr v-if="!objects.length">
            <td colspan="5" class="dd-hint">no animated objects</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ================= TIMELINE ================= -->
    <section v-else-if="!collapsed" class="dd-body">
      <div class="dd-row">
        <input v-model="filter" class="dd-filter" placeholder="filter…" data-testid="dbg-filter" />
        <label class="dd-check">
          <input
            type="checkbox"
            :checked="channels.trace"
            data-testid="dbg-trace-toggle"
            @change="toggleTrace"
          />
          Trace
        </label>
      </div>
      <h3 class="dd-h3">State diffs</h3>
      <ol class="dd-list" data-testid="dbg-events">
        <li v-for="e in eventsFiltered.slice(-300)" :key="e.seq">
          <span class="cyc">c{{ e.cycle }}</span> {{ describeDebugEvent(e) }}
        </li>
        <li v-if="!eventsFiltered.length" class="dd-hint">no writes observed yet</li>
      </ol>
      <h3 class="dd-h3">Instruction trace</h3>
      <ol ref="traceEl" class="dd-list dd-trace" data-testid="dbg-trace">
        <li v-if="traceDropped > 0" class="dd-hint" data-testid="dbg-trace-dropped">
          …{{ traceDropped }} records dropped while the inspector was stalled
        </li>
        <li v-for="r in traceFiltered.slice(-400)" :key="r.seq">
          <span class="cyc">c{{ r.cycle }}</span> {{ formatTraceRecord(r) }}
        </li>
        <li v-if="!channels.trace" class="dd-hint">arm Trace to stream instructions</li>
      </ol>
    </section>
  </aside>
</template>

<style scoped>
.dbg-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  /* Above the game surface, below the app's floating chrome (power-up 3,
     bubble 4): overlay marks belong to the game view, windows occlude them. */
  z-index: 1;
  image-rendering: pixelated;
}
.dbg-overlay.armed {
  pointer-events: auto;
  cursor: crosshair;
}

.debug-dock {
  position: absolute;
  z-index: 6;
  display: flex;
  flex-direction: column;
  width: 320px;
  box-sizing: border-box;
  font-family: system-ui, sans-serif;
  font-size: 12px;
  color: #b8d0dc;
  background: rgba(6, 12, 20, 0.96);
  border: 1px solid #55ffff;
  border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

/* Docked: parked just outside the frame's right edge, never covering play. */
.debug-dock:not(.floating) {
  left: calc(100% + 12px);
  top: 0;
  bottom: 0;
}

/* Floating: user-dragged over the stage, clamped inside the frame. */
.debug-dock.floating {
  left: 0;
  top: 0;
  max-height: calc(100% - 12px);
  transform: translate(var(--fx, 8px), var(--fy, 8px));
}

/* Narrow/portrait screens: the docked position would overflow the viewport,
   so it starts as an in-frame floating panel instead. */
@media (max-width: 1340px), (orientation: portrait) {
  .debug-dock:not(.floating) {
    left: auto;
    right: 8px;
    top: 8px;
    bottom: 8px;
    width: min(320px, 62%);
  }
}

.debug-dock.collapsed {
  bottom: auto;
  height: auto;
}
.debug-dock.collapsed .dd-body {
  display: none;
}

.dd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #1d3a46;
  background: linear-gradient(#0e1a28, #081018);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.dd-head:active {
  cursor: grabbing;
}
.dd-grip {
  color: #3d5a6e;
  font-size: 10px;
}
.dd-title {
  color: var(--ui-action);
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.04em;
}
.dd-tabs {
  display: flex;
  gap: 2px;
  margin-left: auto;
  padding: 2px;
  background: #081217;
  border: 1px solid #38515b;
  border-radius: 7px;
}
.dd-tab {
  background: none;
  border: none;
  border-radius: 5px;
  color: #7e9aac;
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
  text-transform: capitalize;
}
.dd-tab.on {
  color: var(--ui-action-ink);
  background: var(--ui-action);
}
.dd-icon-btn {
  background: none;
  border: none;
  color: #7e9aac;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
}
.dd-icon-btn:hover {
  color: var(--ui-action-hover);
}
@media (any-pointer: coarse) {
  .dd-icon-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 10px;
    font-size: 18px;
  }
}
.dd-close:hover {
  color: var(--ui-danger-hover);
}
.collapsed .dd-head {
  border-bottom: none;
}
.collapsed .dd-head > button:first-of-type {
  margin-left: auto;
}

.dd-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
}
.dd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  flex-wrap: wrap;
}
.dd-modes {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
}
.dd-mode {
  background: transparent;
  border: 1px solid #38515b;
  border-radius: 6px;
  color: var(--ui-action);
  font: inherit;
  font-size: 11px;
  padding: 6px 0;
  cursor: pointer;
}
.dd-mode:hover:not(:disabled) {
  border-color: var(--ui-action-hover);
  color: var(--ui-action-hover);
  background: var(--ui-action-surface-hover);
}
.dd-mode.on {
  color: var(--ui-action-ink);
  background: var(--ui-action);
  border-color: var(--ui-action);
}
.dd-mode:disabled {
  opacity: 0.45;
  cursor: default;
}
.dd-check {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
}
.dd-check input {
  accent-color: var(--ui-action);
}
.dd-hint {
  color: #55707f;
  font-style: italic;
  font-size: 11px;
}
.dd-hover {
  margin: 6px 0;
  padding: 5px 8px;
  background: #0a1420;
  border-left: 2px solid var(--ui-action);
  border-radius: 0 6px 6px 0;
  color: #d8f0f8;
  font-family: monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dd-h3 {
  margin: 12px 0 6px;
  color: var(--ui-action);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-bottom: 1px solid #1d3a46;
  padding-bottom: 3px;
  display: flex;
  justify-content: space-between;
}
.dd-statehead {
  justify-content: space-between;
  color: #e8d878;
  font-family: monospace;
  font-size: 11px;
}

.pick-card {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid #4a5a30;
  border-radius: 8px;
  background: #0b1219;
}
.pick-crop {
  display: block;
  width: 100%;
  image-rendering: pixelated;
  border: 1px solid #223047;
  border-radius: 4px;
  margin-bottom: 8px;
}
.pick-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 10px;
  margin: 0 0 8px;
  font-family: monospace;
  font-size: 11px;
}
.pick-fields dt {
  color: #55707f;
}
.pick-fields dd {
  margin: 0;
  color: #e8f4f8;
}

.cell-grid {
  display: grid;
  grid-template-columns: repeat(16, 1fr);
  gap: 1px;
  font-family: monospace;
}
.cell {
  background: #0a1420;
  border: none;
  border-radius: 2px;
  color: #55707f;
  font: inherit;
  font-size: 9px;
  padding: 2px 0;
  cursor: pointer;
  min-width: 0;
}
.cell.set {
  color: #d8f0f8;
  background: #132b3a;
}
.cell.hot {
  background: #4a5a30;
  color: #ffff55;
}
.cell.pin {
  outline: 1px solid var(--ui-action);
}
.var-edit input {
  background: #000;
  color: #ffff55;
  border: 1px solid #38515b;
  border-radius: 4px;
  font: inherit;
  font-family: monospace;
  width: 5ch;
}
.dd-pins {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  font-family: monospace;
  font-size: 10px;
}
.pin-tag {
  border: 1px solid var(--ui-action);
  border-radius: 4px;
  color: var(--ui-action);
  padding: 1px 4px;
}

.obj-table {
  width: 100%;
  border-collapse: collapse;
  font-family: monospace;
  font-size: 10px;
}
.obj-table td {
  padding: 2px 4px;
  border-bottom: 1px dotted #16263a;
  white-space: nowrap;
}

.dd-filter {
  flex: 1;
  background: #000;
  border: 1px solid #38515b;
  border-radius: 6px;
  color: #d8f0f8;
  font: inherit;
  font-size: 11px;
  padding: 5px 8px;
}
.dd-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 10px;
}
.dd-list li {
  padding: 2px 0;
  border-bottom: 1px dotted #101c2c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dd-trace {
  max-height: 220px;
}
.cyc {
  color: #6e7045;
  margin-right: 5px;
}
</style>
