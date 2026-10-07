<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue";
import type { SoundDocument } from "../../../../src/sound/document.ts";
import {
  DRUM_SOUNDS,
  setSoundInterval,
  silenceSoundEvent,
  timedSoundEvents,
  type TimedSoundEvent,
} from "../../../../src/sound/sequencer.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { divisorNoteLabel } from "./soundEdits.ts";
const props = defineProps<{
  readOnly?: boolean;
  document: SoundDocument;
  stepTicks: number;
  position: number;
}>();
const emit = defineEmits<{
  edit: [document: SoundDocument];
  select: [id: string | undefined];
  error: [message: string];
}>();
const root = useTemplateRef("root");
const drafts = ref<Record<string, string>>({});
const notes = computed(() => timedSoundEvents(props.document));
const rows = computed(() =>
  [
    ...new Set([
      0,
      ...notes.value.map((n) => n.start),
      Math.max(0, ...notes.value.map((n) => n.end)),
    ]),
  ].sort((a, b) => a - b),
);
const names = computed(() =>
  [1, 2, 3].map((n) => `${VOCABULARY.voice.label} ${n}`).concat(VOCABULARY.drums.label),
);
type Field = "note" | "ticks" | "volume";
function entry(tick: number, lane: number): TimedSoundEvent | undefined {
  return notes.value.find((n) => n.start === tick && n.event.lane === lane);
}
function label(note: TimedSoundEvent | undefined): string {
  const data = note?.event.data;
  return !data
    ? ""
    : data.kind === "tone"
      ? divisorNoteLabel(data.divisor)
      : data.kind === "noise"
        ? DRUM_SOUNDS.find((d) => d.control === data.control)!.name
        : data.kind === "rest"
          ? "Rest"
          : "Raw";
}
function fieldValue(tick: number, lane: number, field: Field): string {
  const draft = drafts.value[`${tick}:${lane}:${field}`];
  if (draft !== undefined) return draft;
  const n = entry(tick, lane);
  return field === "note"
    ? label(n)
    : field === "ticks"
      ? String(n?.event.durationTicks ?? "")
      : n && "attenuation" in n.event.data
        ? (15 - n.event.data.attenuation).toString(16).toUpperCase()
        : "";
}
function input(event: Event, tick: number, lane: number, field: Field): void {
  if (props.readOnly) return;
  drafts.value[`${tick}:${lane}:${field}`] = (event.target as HTMLInputElement).value;
}
function commit(tick: number, lane: number, field: Field): void {
  if (props.readOnly) return;
  const key = `${tick}:${lane}:${field}`,
    text = drafts.value[key];
  if (text === undefined) return;
  const note = entry(tick, lane);
  try {
    let next = props.document;
    if (field === "note") {
      const rest = text.trim().toLowerCase() === "rest" || text.trim() === "";
      const attenuation =
        note && "attenuation" in note.event.data ? note.event.data.attenuation : 3;
      const drum = DRUM_SOUNDS.find(
        (d) =>
          d.name.toLowerCase() === text.trim().toLowerCase() || String(d.control) === text.trim(),
      );
      if (lane === 3 && !rest && !drum)
        throw new Error("Type Kick, Snare, Hat or a noise control from 0 to 7.");
      const data = rest
        ? { kind: "rest" as const }
        : lane === 3
          ? { kind: "noise" as const, control: drum!.control, attenuation }
          : { kind: "tone" as const, note: text, attenuation };
      next = note
        ? next.replaceEventData(note.event.id, data)
        : setSoundInterval(next, lane, tick, props.stepTicks, data);
    } else {
      if (!note) throw new Error("Enter a note before its length or volume.");
      if (field === "ticks") {
        if (!/^\d+$/.test(text)) throw new Error("Length uses whole ticks from 1 to 65536.");
        next = next.updateEvent(note.event.id, { ticks: Number(text) });
      } else {
        if (!/^[0-9a-f]$/i.test(text)) throw new Error("Volume uses one hex digit from 0 to F.");
        next = next.updateEvent(note.event.id, { attenuation: 15 - Number.parseInt(text, 16) });
      }
    }
    emit("edit", next);
    emit(
      "select",
      timedSoundEvents(next).find((n) => n.start === tick && n.event.lane === lane)?.event.id,
    );
    emit("error", "");
  } catch (error) {
    emit("error", error instanceof Error ? error.message : String(error));
  }
  delete drafts.value[key];
}
function key(event: KeyboardEvent, tick: number, lane: number, field: Field): void {
  if (event.key === "Enter") {
    commit(tick, lane, field);
    event.preventDefault();
    return;
  }
  if (event.key === "Escape") {
    delete drafts.value[`${tick}:${lane}:${field}`];
    event.preventDefault();
    return;
  }
  if (!props.readOnly && event.key === "Delete" && !(event.target as HTMLInputElement).value) {
    const note = entry(tick, lane);
    if (note) emit("edit", silenceSoundEvent(props.document, note.event.id));
    return;
  }
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
  commit(tick, lane, field);
  const fields: Field[] = ["note", "ticks", "volume"];
  let row = rows.value.indexOf(tick),
    column = lane * 3 + fields.indexOf(field);
  if (event.key === "ArrowUp") row--;
  else if (event.key === "ArrowDown") row++;
  else if (event.key === "ArrowLeft") column--;
  else column++;
  const target = root.value?.querySelector<HTMLInputElement>(
    `[data-cell="${Math.max(0, Math.min(rows.value.length - 1, row))}:${Math.max(0, Math.min(11, column))}"]`,
  );
  target?.focus();
  target?.select();
  event.preventDefault();
  event.stopPropagation();
}
</script>
<template>
  <div ref="root" class="sound-tracker" data-testid="sound-tracker">
    <table :aria-label="VOCABULARY.tracker.label">
      <thead>
        <tr>
          <th scope="col">Tick</th>
          <th v-for="(name, lane) in names" :key="lane" scope="col" :class="`voice-${lane}`">
            {{ name }}<small>Note · Ticks · 0–F</small>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(tick, row) in rows"
          :key="tick"
          :class="{ playing: position > tick && position <= (rows[row + 1] ?? tick + stepTicks) }"
        >
          <th scope="row">
            {{ tick.toString(16).toUpperCase().padStart(4, "0") }}<small>{{ tick }}</small>
          </th>
          <td
            v-for="(_, lane) in names"
            :key="lane"
            :class="`voice-${lane}`"
            :data-note-id="entry(tick, lane)?.event.id"
          >
            <div>
              <input
                v-for="(field, column) in ['note', 'ticks', 'volume'] as const"
                :key="field"
                :class="field"
                :data-cell="`${row}:${lane * 3 + column}`"
                :aria-label="`${names[lane]}, tick ${tick}, ${field === 'ticks' ? 'length in ticks' : field === 'volume' ? 'volume in hex' : 'note'}`"
                :value="fieldValue(tick, lane, field)"
                :placeholder="field === 'note' ? '···' : field === 'ticks' ? '··' : '·'"
                :readonly="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                spellcheck="false"
                autocomplete="off"
                @focus="emit('select', entry(tick, lane)?.event.id)"
                @input="input($event, tick, lane, field)"
                @change="commit(tick, lane, field)"
                @keydown="key($event, tick, lane, field)"
              />
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="tracker-help">
    Notes use names such as E5 or Rest. Length is in ticks; volume uses 0–9 and A–F.
  </p>
</template>
<style scoped>
.sound-tracker {
  overflow: auto;
  max-height: 560px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
}
table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
th,
td {
  padding: var(--space-1);
  border-right: 1px solid var(--hairline);
  border-bottom: 1px solid var(--hairline);
  text-align: left;
}
thead th {
  position: sticky;
  top: 0;
  background: var(--surface-2);
  z-index: 1;
}
th small {
  display: block;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  font-weight: normal;
  white-space: nowrap;
  margin-top: var(--space-1);
}
td > div {
  display: flex;
  gap: var(--space-1);
}
input {
  box-sizing: border-box;
  width: 3.5em;
  min-width: 0;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
}
input.note {
  width: 4.5em;
}
input.volume {
  width: 1.5em;
}
input:focus {
  outline: 1px solid var(--focus);
  background: var(--surface-2);
}
.voice-0 {
  color: var(--action);
}
.voice-1 {
  color: var(--warn);
}
.voice-2 {
  color: var(--danger);
}
.voice-3 {
  color: var(--ink-2);
}
.playing {
  background: var(--action-soft);
}
.tracker-help {
  font-size: var(--text-xs);
  color: var(--ink-2);
  margin: var(--space-3) 0;
}
</style>
