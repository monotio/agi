<script setup lang="ts">
import { computed, onMounted, useTemplateRef, watch } from "vue";
import type { SoundDocument, SoundEventDataInput } from "../../../../src/sound/document.ts";
import {
  DRUM_SOUNDS,
  gridTick,
  beatLengthLabel,
  setSoundInterval,
  silenceSoundEvent,
  timedSoundEvents,
  type TimedSoundEvent,
} from "../../../../src/sound/sequencer.ts";
import { PSG_BASE_FREQ } from "../../../../src/sound/sound.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { ref } from "vue";
const props = defineProps<{
  readOnly?: boolean;
  document: SoundDocument;
  tempo: number;
  division: number;
  voice: number;
  volume: number;
  position: number;
  selected: string | undefined;
}>();
const emit = defineEmits<{
  edit: [document: SoundDocument];
  select: [id: string | undefined];
  cursor: [label: string];
  voice: [lane: number];
  error: [message: string];
}>();
const canvas = useTemplateRef("canvas");
const drumCanvas = useTemplateRef("drumCanvas");
const notes = computed(() => timedSoundEvents(props.document));
const low = computed(() =>
  Math.min(48, ...notes.value.filter((n) => n.event.data.kind === "tone").map((n) => midi(n))),
);
const high = computed(() =>
  Math.max(84, ...notes.value.filter((n) => n.event.data.kind === "tone").map((n) => midi(n))),
);
const drums = computed(() =>
  DRUM_SOUNDS.filter(
    (d, i) =>
      i < 3 ||
      notes.value.some((n) => n.event.data.kind === "noise" && n.event.data.control === d.control),
  ),
);
const raw = computed(() => notes.value.some((n) => n.event.data.kind === "raw"));
const pitchRows = computed(() => high.value - low.value + 1);
const rows = computed(() => pitchRows.value + drums.value.length + (raw.value ? 1 : 0));
const steps = computed(() =>
  Math.max(
    32,
    Math.ceil(
      (Math.max(0, ...notes.value.map((n) => n.end)) * props.tempo * props.division) / 14400,
    ) + 4,
  ),
);
const ROW_HEIGHT = 20;
const pageStart = ref(0);
const width = computed(() => 64 + 32 * 26),
  height = computed(() => 24 + rows.value * ROW_HEIGHT);
const toneHeight = computed(() => 24 + pitchRows.value * ROW_HEIGHT);
const drumHeight = computed(() => height.value - toneHeight.value);
const cursor = ref({ step: 0, row: 8 });
const cursorTick = ref<number>();
const live = ref("");
let drag:
  | {
      start: number;
      row: number;
      lane: number;
      end: number;
      hit: TimedSoundEvent | undefined;
      originX: number;
      moving: boolean;
    }
  | undefined;
function midi(note: TimedSoundEvent): number {
  return note.event.data.kind === "tone"
    ? Math.round(69 + 12 * Math.log2(PSG_BASE_FREQ / note.event.data.divisor / 440))
    : 0;
}
function noteRow(note: TimedSoundEvent): number {
  const data = note.event.data;
  return data.kind === "tone"
    ? high.value - midi(note)
    : data.kind === "noise"
      ? pitchRows.value + drums.value.findIndex((d) => d.control === data.control)
      : rows.value - 1;
}
function tickX(tick: number): number {
  return 64 + ((tick * props.tempo * props.division) / 14400 - pageStart.value) * 26;
}
function rowLabel(row: number): string {
  if (row >= pitchRows.value) return drums.value[row - pitchRows.value]?.name ?? "Raw";
  const note = high.value - row;
  return `${["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][note % 12]}${Math.floor(note / 12) - 1}`;
}
function cellLane(row: number): number {
  return row >= pitchRows.value && row < pitchRows.value + drums.value.length ? 3 : props.voice;
}
function hitAt(step: number, row: number, exactTick?: number): TimedSoundEvent | undefined {
  const tick = exactTick ?? gridTick(step, props.tempo, props.division);
  return notes.value
    .filter(
      (n) =>
        n.event.lane === cellLane(row) &&
        n.event.data.kind !== "rest" &&
        noteRow(n) === row &&
        n.start <= tick &&
        n.end > tick,
    )
    .sort((a, b) => Number(b.event.lane === props.voice) - Number(a.event.lane === props.voice))[0];
}
function describe(hit?: TimedSoundEvent): void {
  const { step, row } = cursor.value,
    note = hit ?? hitAt(step, row, cursorTick.value),
    lane = note?.event.lane ?? cellLane(row);
  const ticks =
    note?.event.durationTicks ??
    gridTick(step + 1, props.tempo, props.division) - gridTick(step, props.tempo, props.division);
  const name = lane === 3 ? VOCABULARY.drums.label : `${VOCABULARY.voice.label} ${lane + 1}`;
  const label = `${name}, ${rowLabel(row)}, ${beatLengthLabel(ticks, props.tempo)}, ${ticks} ticks`;
  live.value = label.replace("½ beat", "half beat");
  emit("cursor", label);
  emit("select", note?.event.id);
}
function draw(): void {
  if (canvas.value) drawSurface(canvas.value, 0, toneHeight.value);
  if (drumCanvas.value) drawSurface(drumCanvas.value, toneHeight.value, drumHeight.value);
}
function drawSurface(element: HTMLCanvasElement, offset: number, surfaceHeight: number): void {
  const c = element.getContext("2d");
  if (!c) return;
  const style = getComputedStyle(element),
    token = (name: string) => style.getPropertyValue(name).trim();
  const colours = [token("--action"), token("--warn"), token("--danger"), token("--ink-2")];
  const ratio = window.devicePixelRatio || 1;
  element.width = width.value * ratio;
  element.height = surfaceHeight * ratio;
  c.scale(ratio, ratio);
  c.translate(0, -offset);
  c.fillStyle = token("--surface-sunken");
  c.fillRect(0, 0, width.value, height.value);
  c.font = `${token("--text-2xs")} ${token("--font-mono")}`;
  for (let row = 0; row < rows.value; row++) {
    const y = 24 + row * ROW_HEIGHT,
      pitch = high.value - row,
      black = row < pitchRows.value && [1, 3, 6, 8, 10].includes(pitch % 12);
    c.fillStyle = token(black ? "--surface-0" : "--surface-1");
    c.fillRect(64, y, width.value - 64, ROW_HEIGHT - 1);
    c.fillStyle = token(black ? "--surface-3" : "--hairline-strong");
    c.fillRect(0, y, 60, ROW_HEIGHT - 1);
    c.fillStyle = token("--ink-2");
    if (row >= pitchRows.value || pitch % 12 === 0)
      c.fillText(rowLabel(row), 4, y + ROW_HEIGHT / 2 + 4, 56);
  }
  for (let localStep = 0; localStep <= 32; localStep++) {
    const step = pageStart.value + localStep;
    c.fillStyle = token(step % (props.division / 4) === 0 ? "--hairline-strong" : "--hairline");
    c.fillRect(64 + localStep * 26, 24, 1, height.value - 24);
    if (step % Math.max(1, props.division) === 0) {
      c.fillStyle = token("--ink-2");
      c.fillText(String(Math.floor(step / props.division) + 1), 66 + localStep * 26, 16);
    }
  }
  c.save();
  c.beginPath();
  c.rect(64, 24, width.value - 64, height.value - 24);
  c.clip();
  for (const note of notes.value) {
    if (note.event.data.kind === "rest") continue;
    const y = 24 + noteRow(note) * ROW_HEIGHT,
      x = tickX(note.start),
      length = Math.max(2, tickX(note.end) - x);
    c.globalAlpha =
      "attenuation" in note.event.data ? 0.3 + (0.7 * (15 - note.event.data.attenuation)) / 15 : 1;
    c.fillStyle = colours[note.event.lane]!;
    c.beginPath();
    c.roundRect(x + 1, y + 2, Math.max(1, length - 2), ROW_HEIGHT - 4, 3);
    c.fill();
    c.globalAlpha = 1;
    if (note.event.id === props.selected) {
      c.strokeStyle = token("--ink");
      c.stroke();
    }
  }
  c.strokeStyle = token("--focus");
  c.strokeRect(
    65 + (cursor.value.step - pageStart.value) * 26,
    25 + cursor.value.row * ROW_HEIGHT,
    24,
    ROW_HEIGHT - 2,
  );
  if (drag?.moving) {
    c.strokeStyle = colours[drag.lane]!;
    c.strokeRect(
      tickX(drag.start) + 1,
      25 + drag.row * ROW_HEIGHT,
      Math.max(2, tickX(drag.end) - tickX(drag.start) - 2),
      ROW_HEIGHT - 2,
    );
  }
  if (props.position > 0) {
    c.fillStyle = token("--action");
    c.fillRect(tickX(Math.max(0, props.position - 1)), 24, 2, height.value - 24);
  }
  c.restore();
}
function pointerCell(
  event: PointerEvent,
): { step: number; row: number; x: number; tick: number } | undefined {
  const element = event.currentTarget as HTMLCanvasElement;
  const drum = element === drumCanvas.value;
  const bounds = element.getBoundingClientRect(),
    x = ((event.clientX - bounds.left) * width.value) / bounds.width,
    y =
      ((event.clientY - bounds.top) * (drum ? drumHeight.value : toneHeight.value)) /
        bounds.height +
      (drum ? toneHeight.value : 0);
  if (x < 64 || y < 24 || y >= height.value) return;
  return {
    step: pageStart.value + Math.max(0, Math.min(31, Math.floor((x - 64) / 26))),
    row: Math.floor((y - 24) / ROW_HEIGHT),
    x,
    tick: (((x - 64) / 26 + pageStart.value) * 14400) / props.tempo / props.division,
  };
}
function down(event: PointerEvent): void {
  if (event.button !== 0 && event.button !== 2) return;
  const cell = pointerCell(event);
  if (!cell) return;
  if (cell.row < pitchRows.value && props.voice === 3) return;
  (event.currentTarget as HTMLCanvasElement).focus();
  cursor.value = { step: cell.step, row: cell.row };
  cursorTick.value = cell.tick;
  // Hit testing uses the actual pointer tick, including notes between grid lines.
  const hit = notes.value
    .filter(
      (n) =>
        n.event.lane === cellLane(cell.row) &&
        n.event.data.kind !== "rest" &&
        noteRow(n) === cell.row &&
        n.start <= cell.tick &&
        n.end > cell.tick,
    )
    .sort((a, b) => Number(b.event.lane === props.voice) - Number(a.event.lane === props.voice))[0];
  if (props.readOnly) {
    describe(hit);
    return;
  }
  if (event.button === 2) {
    if (hit) emit("edit", silenceSoundEvent(props.document, hit.event.id));
    return;
  }
  const lane = hit?.event.lane ?? cellLane(cell.row);
  emit("voice", lane);
  emit("select", hit?.event.id);
  drag = {
    start: hit?.start ?? gridTick(cell.step, props.tempo, props.division),
    end: hit?.end ?? gridTick(cell.step + 1, props.tempo, props.division),
    row: cell.row,
    lane,
    hit,
    originX: cell.x,
    moving: false,
  };
  (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
  describe(hit);
}
function move(event: PointerEvent): void {
  if (!drag) return;
  const cell = pointerCell(event);
  if (!cell) return;
  if (Math.abs(cell.x - drag.originX) > 3) drag.moving = true;
  if (drag.moving)
    drag.end = Math.max(drag.start + 1, gridTick(cell.step + 1, props.tempo, props.division));
  draw();
}
function data(row: number, lane: number): SoundEventDataInput {
  return lane === 3
    ? {
        kind: "noise",
        control: drums.value[row - pitchRows.value]?.control ?? 5,
        attenuation: 15 - props.volume,
      }
    : { kind: "tone", note: rowLabel(row), attenuation: 15 - props.volume };
}
function finish(event: PointerEvent): void {
  try {
    finishEdit(event);
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
  }
}
function finishEdit(event: PointerEvent): void {
  if (!drag) return;
  const edit = drag;
  cursorTick.value = edit.start;
  drag = undefined;
  (event.currentTarget as HTMLCanvasElement).releasePointerCapture(event.pointerId);
  if (props.readOnly) return;
  if (edit.hit && !edit.moving) emit("edit", silenceSoundEvent(props.document, edit.hit.event.id));
  else if (edit.row < pitchRows.value + drums.value.length || edit.hit) {
    const doc = edit.hit ? silenceSoundEvent(props.document, edit.hit.event.id) : props.document;
    emit(
      "edit",
      setSoundInterval(
        doc,
        edit.lane,
        edit.start,
        edit.end - edit.start,
        edit.hit?.event.data ?? data(edit.row, edit.lane),
      ),
    );
  }
  describe();
  draw();
}
function key(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey) return;
  try {
    keyEdit(event);
  } catch (cause) {
    emit("error", cause instanceof Error ? cause.message : String(cause));
    event.preventDefault();
    event.stopPropagation();
  }
}
function keyEdit(event: KeyboardEvent): void {
  if (props.readOnly && ["Enter", "Delete", "Backspace"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const { step, row } = cursor.value,
    note = hitAt(step, row, cursorTick.value);
  if (event.key === "Enter") {
    if (note) emit("edit", silenceSoundEvent(props.document, note.event.id));
    else if (row < pitchRows.value + drums.value.length)
      emit(
        "edit",
        setSoundInterval(
          props.document,
          cellLane(row),
          gridTick(step, props.tempo, props.division),
          gridTick(step + 1, props.tempo, props.division) -
            gridTick(step, props.tempo, props.division),
          data(row, cellLane(row)),
        ),
      );
  } else if (event.key === "Delete" || event.key === "Backspace") {
    if (note) emit("edit", silenceSoundEvent(props.document, note.event.id));
  } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    if (event.shiftKey && note && !props.readOnly) {
      const length = Math.max(
        1,
        note.event.durationTicks +
          direction *
            (gridTick(step + 1, props.tempo, props.division) -
              gridTick(step, props.tempo, props.division)),
      );
      emit(
        "edit",
        setSoundInterval(
          silenceSoundEvent(props.document, note.event.id),
          note.event.lane,
          note.start,
          length,
          note.event.data,
        ),
      );
    } else {
      cursor.value.step = Math.max(0, Math.min(steps.value - 1, step + direction));
      cursorTick.value = undefined;
    }
  } else if (["ArrowUp", "ArrowDown"].includes(event.key))
    cursor.value.row = Math.max(
      0,
      Math.min(rows.value - 1, row + (event.key === "ArrowUp" ? -1 : 1) * (event.altKey ? 12 : 1)),
    );
  else return;
  if (["ArrowUp", "ArrowDown"].includes(event.key)) cursorTick.value = undefined;
  event.preventDefault();
  event.stopPropagation();
  pageStart.value = Math.floor(cursor.value.step / 32) * 32;
  describe();
  draw();
  canvas.value?.parentElement?.scrollTo({
    left: Math.max(
      0,
      64 + (cursor.value.step - pageStart.value) * 26 - canvas.value.parentElement.clientWidth + 64,
    ),
    top: Math.max(
      0,
      24 + cursor.value.row * ROW_HEIGHT - canvas.value.parentElement.clientHeight + 28,
    ),
  });
}
watch(
  () => [props.document, props.tempo, props.division, props.voice, props.position, props.selected],
  draw,
  { flush: "post" },
);
watch(pageStart, draw, { flush: "post" });
watch(
  () => props.document,
  () => {
    pageStart.value = Math.min(pageStart.value, Math.floor((steps.value - 1) / 32) * 32);
    describe();
  },
  { flush: "post" },
);
watch(
  () => props.voice,
  () => {
    if (props.voice === 3 && cursor.value.row < pitchRows.value) cursor.value.row = pitchRows.value;
    else if (
      props.voice < 3 &&
      cursor.value.row >= pitchRows.value &&
      cursor.value.row < pitchRows.value + drums.value.length
    )
      cursor.value.row = Math.max(0, high.value - 76);
    describe();
    draw();
  },
  { flush: "post" },
);
watch(
  () => props.position,
  (position) => {
    if (position > 0)
      pageStart.value = Math.floor((position * props.tempo * props.division) / 14400 / 32) * 32;
  },
);
onMounted(() => {
  const selected = notes.value.find((n) => n.event.id === props.selected);
  if (selected && selected.event.data.kind !== "rest") {
    cursor.value = {
      step: Math.floor((selected.start * props.tempo * props.division) / 14400),
      row: noteRow(selected),
    };
    cursorTick.value = selected.start;
    pageStart.value = Math.floor(cursor.value.step / 32) * 32;
  }
  draw();
  describe();
});
</script>
<template>
  <div class="roll-pages">
    <button
      type="button"
      :disabled="pageStart === 0"
      :title="pageStart === 0 ? 'First steps' : 'Show earlier steps'"
      @click="pageStart = Math.max(0, pageStart - 32)"
    >
      ← Earlier</button
    ><span>Steps {{ pageStart + 1 }}–{{ pageStart + 32 }}</span
    ><button
      type="button"
      :disabled="pageStart + 32 >= steps"
      :title="pageStart + 32 >= steps ? 'Final steps' : 'Show later steps'"
      @click="pageStart += 32"
    >
      Later →
    </button>
  </div>
  <div class="sound-roll">
    <div class="tone-roll" :style="{ width: `${width}px` }">
      <canvas
        ref="canvas"
        data-testid="sound-grid"
        tabindex="0"
        :style="{ width: `${width}px`, height: `${toneHeight}px` }"
        :aria-label="VOCABULARY.grid.help"
        aria-describedby="sound-grid-keys"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="finish"
        @pointercancel="
          drag = undefined;
          draw();
        "
        @contextmenu.prevent
        @keydown="key"
      />
    </div>
    <canvas
      ref="drumCanvas"
      data-testid="sound-drums"
      tabindex="0"
      :style="{ width: `${width}px`, height: `${drumHeight}px` }"
      :aria-label="VOCABULARY.drums.help"
      aria-describedby="sound-grid-keys"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="finish"
      @pointercancel="
        drag = undefined;
        draw();
      "
      @contextmenu.prevent
      @keydown="key"
    />
  </div>
  <p class="sr-only" aria-live="polite" aria-atomic="true">{{ live }}</p>
  <p id="sound-grid-keys" class="sound-grid-help">
    Arrows move. Enter adds or removes. Shift + ← → changes length. Alt + ↑ ↓ moves an octave.
    Delete removes. Space plays.
  </p>
</template>
<style scoped>
.roll-pages {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.roll-pages button {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink-2);
  padding: var(--space-2);
  font: inherit;
  cursor: pointer;
}
.roll-pages button:disabled {
  opacity: 0.4;
  cursor: default;
}
.sound-roll {
  overflow: auto;
  background: var(--surface-sunken);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.tone-roll {
  overflow-y: auto;
  overflow-x: hidden;
  max-height: clamp(200px, calc(100dvh - 480px), 420px);
}
canvas {
  display: block;
  touch-action: none;
}
canvas:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.sound-grid-help {
  margin: var(--space-3) 0;
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
