<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import {
  importSoundDocument,
  type SoundDocument,
  type SoundEvent,
} from "../../../../src/sound/document.ts";
import { applySoundPreset, SOUND_PRESETS } from "../../../../src/sound/presets.ts";
import { createSoundPreview } from "../sound/soundPreview.ts";
import {
  attenuationToVolume,
  divisorNoteLabel,
  editSoundNote,
  LANE_NAMES,
  moveSoundNote,
  NOISE_CONTROL_NAMES,
  retimeSound,
} from "../sound/soundEdits.ts";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{
  documentKey: string;
  bytes: Uint8Array;
  profileId: ProfileId;
  tempo: number;
  active: boolean;
}>();
const emit = defineEmits<{ edit: [bytes: Uint8Array, tempo: number] }>();
const notice = ref("");
const root = useTemplateRef("root");
type SoundField = "tempo" | "note" | "beats" | "volume" | "ticks" | "divisor" | "attenuation";
const drafts = ref<Partial<Record<SoundField, string>>>({});
const document = shallowRef(importSoundDocument(props.bytes, { profileId: props.profileId }));
const tempo = ref(props.tempo);
const selected = ref<string>();
const tracks = computed(() => document.value.tracks());
const event = computed(() => tracks.value?.flat().find((entry) => entry.id === selected.value));
// Private audition leaves the workspace's MAIN running.
const preview = createSoundPreview({ acquirePauseLease: async () => ({ release() {} }) });
const status = ref(preview.snapshot.status);
const unsubscribe = preview.subscribe(() => {
  status.value = preview.snapshot.status;
  if (preview.snapshot.refusal) notice.value = preview.snapshot.refusal;
});
function target(bytes: Uint8Array): void {
  preview.setTarget({
    projectId: "workspace",
    documentId: props.documentKey,
    revision: 0,
    payload: bytes,
    profileId: props.profileId,
  });
}
watch(
  () => props.tempo,
  (next) => {
    tempo.value = next;
  },
);
watch(
  () => props.bytes,
  (bytes) => {
    const prior = document.value.encode();
    if (prior.length !== bytes.length || prior.some((byte, index) => byte !== bytes[index])) {
      document.value = importSoundDocument(bytes, { profileId: props.profileId });
      selected.value = undefined;
      tempo.value = props.tempo;
      target(bytes);
    } else if (preview.snapshot.target === null) target(bytes);
  },
  { immediate: true },
);
watch(
  () => props.active,
  (active) => {
    if (!active) preview.stop();
  },
);
function change(edit: (value: SoundDocument) => SoundDocument): void {
  try {
    const next = edit(document.value);
    const bytes = next.encode();
    document.value = next;
    target(bytes);
    emit("edit", bytes, tempo.value);
    notice.value = "";
  } catch (cause) {
    notice.value = String(cause instanceof Error ? cause.message : cause);
  }
}
function friendly(id: string, edit: { note?: string; beats?: number; volume?: number }): void {
  change((doc) => editSoundNote(doc, id, edit, tempo.value));
}
function commit(field: SoundField, edit: () => void): void {
  edit();
  delete drafts.value[field];
}
watch(selected, () => {
  drafts.value = {};
});
function value(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
function pitch(event: SoundEvent): string {
  return event.data.kind === "tone"
    ? divisorNoteLabel(event.data.divisor)
    : event.data.kind === "noise"
      ? NOISE_CONTROL_NAMES[event.data.control]!
      : event.data.kind === "rest"
        ? "Rest"
        : "Raw";
}
function beats(event: SoundEvent): number {
  return Number(((event.durationTicks * tempo.value) / 3600).toFixed(3));
}
function transport(): void {
  if (status.value === "playing") preview.stop();
  else preview.play();
}
function preset(id: string): void {
  change((doc) => applySoundPreset(doc, id));
  selected.value = undefined;
}
function setTempo(after: number): void {
  change((doc) => {
    const next = retimeSound(doc, tempo.value, after);
    tempo.value = after;
    return next;
  });
}
async function focusNote(lane: number, index: number): Promise<void> {
  const note = tracks.value?.[lane]?.[index];
  selected.value = note?.id;
  await nextTick();
  const selector = note ? `[data-note-id="${note.id}"]` : `[data-add-lane="${lane}"]`;
  root.value?.querySelector<HTMLElement>(selector)?.focus();
}
function add(lane: number, rest = false): void {
  const index = tracks.value?.[lane]?.length ?? 0;
  change((doc) =>
    doc.insertEvent(lane, index, {
      ticks: Math.round(3600 / tempo.value),
      data: rest
        ? { kind: "rest" }
        : lane === 3
          ? { kind: "noise", control: 5, attenuation: 4 }
          : { kind: "tone", note: "A4", attenuation: 4 },
    }),
  );
  void focusNote(lane, index);
}
function remove(note: SoundEvent): void {
  const index = tracks.value![note.lane]!.findIndex((entry) => entry.id === note.id);
  change((doc) => doc.removeEvent(note.id));
  void focusNote(note.lane, Math.max(0, index - 1));
}
function move(note: SoundEvent, direction: -1 | 1): void {
  const index = tracks.value![note.lane]!.findIndex((entry) => entry.id === note.id);
  change((doc) => moveSoundNote(doc, note.id, direction));
  void focusNote(
    note.lane,
    Math.max(0, Math.min(tracks.value![note.lane]!.length - 1, index + direction)),
  );
}
function keys(key: KeyboardEvent): void {
  if (!props.active || key.ctrlKey || key.metaKey) return;
  const element = key.target as HTMLElement;
  if (element.matches("input, select, textarea, summary")) return;
  if (key.code === "Space") {
    key.preventDefault();
    key.stopPropagation();
    if (!key.repeat) transport();
    return;
  }
  const id = element.dataset["noteId"];
  const note = tracks.value?.flat().find((entry) => entry.id === id);
  if (!note) return;
  const index = tracks.value![note.lane]!.findIndex((entry) => entry.id === id);
  if (key.key === "Delete" || key.key === "Backspace") remove(note);
  else if (key.key === "Insert") add(note.lane);
  else if (key.key === "ArrowLeft" || key.key === "ArrowRight") {
    const direction = key.key === "ArrowLeft" ? -1 : 1;
    if (key.altKey) move(note, direction);
    else
      void focusNote(
        note.lane,
        Math.max(0, Math.min(tracks.value![note.lane]!.length - 1, index + direction)),
      );
  } else return;
  key.preventDefault();
  key.stopPropagation();
}
onBeforeUnmount(() => {
  unsubscribe();
  void preview.close();
});
</script>
<template>
  <div ref="root" class="workspace-sound" data-testid="workspace-sound" @keydown="keys">
    <header class="sound-heading">
      <div>
        <h2>SOUND {{ documentKey.split(":")[1] }}</h2>
        <p>{{ VOCABULARY.sound.help }}</p>
      </div>
      <div class="sound-transport">
        <UiButton
          size="sm"
          data-testid="sound-play"
          title="Play or stop (Space)"
          :aria-pressed="status === 'playing'"
          @click="transport"
          >{{ status === "playing" ? "Stop" : "Play" }}</UiButton
        >
        <span role="status" data-testid="sound-status">{{
          status === "playing" ? "Playing" : status === "complete" ? "Finished" : "Ready"
        }}</span>
      </div>
    </header>
    <template v-if="tracks">
      <section class="sound-presets" aria-label="Presets">
        <h3>Start from</h3>
        <div>
          <UiButton
            v-for="entry in SOUND_PRESETS"
            :key="entry.id"
            size="sm"
            variant="ghost"
            :title="entry.description"
            @click="preset(entry.id)"
            >{{ entry.name }}</UiButton
          >
        </div>
      </section>
      <label class="sound-tempo"
        >Tempo
        <input
          type="number"
          aria-label="Tempo"
          :value="drafts.tempo ?? tempo"
          @input="drafts.tempo = value($event)"
          min="40"
          max="240"
          @change="commit('tempo', () => setTempo(Number(value($event))))"
        />
        <span>beats / minute</span></label
      >
      <p class="sound-help">
        Choose a note to change it. Lengths use beats; tempo changes the whole sound.
      </p>
      <section
        v-for="(lane, laneIndex) in tracks"
        :key="laneIndex"
        class="sound-voice"
        :aria-label="LANE_NAMES[laneIndex]"
      >
        <h3>{{ LANE_NAMES[laneIndex] }}</h3>
        <div class="sound-notes">
          <button
            v-for="note in lane"
            :key="note.id"
            type="button"
            class="sound-note"
            :class="{ 'sound-note--selected': selected === note.id }"
            :data-note-id="note.id"
            :aria-pressed="selected === note.id"
            @focus="selected = note.id"
            @click="selected = note.id"
          >
            <strong>{{ pitch(note) }}</strong
            ><span>{{ beats(note) }} beats</span
            ><span v-if="'attenuation' in note.data"
              >{{ VOCABULARY.volume.label }} {{ attenuationToVolume(note.data.attenuation) }}</span
            >
          </button>
          <UiButton
            size="sm"
            variant="ghost"
            :data-add-lane="laneIndex"
            :aria-label="`Add note to ${LANE_NAMES[laneIndex]}`"
            @click="add(laneIndex)"
            >+ Note</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            :aria-label="`Add rest to ${LANE_NAMES[laneIndex]}`"
            @click="add(laneIndex, true)"
            >+ Rest</UiButton
          >
        </div>
      </section>
      <section v-if="event" class="sound-note-editor" aria-label="Selected note">
        <h3>{{ LANE_NAMES[event.lane] }} · {{ pitch(event) }}</h3>
        <div class="sound-fields">
          <label v-if="event.lane < 3 && event.data.kind !== 'raw'" :title="VOCABULARY.pitch.help"
            >Note<input
              aria-label="Note"
              :value="drafts.note ?? pitch(event)"
              @input="drafts.note = value($event)"
              @change="commit('note', () => friendly(event!.id, { note: value($event) }))"
          /></label>
          <label v-if="event.lane === 3 && event.data.kind !== 'raw'"
            >Noise<select
              aria-label="Noise pattern"
              :value="event.data.kind === 'noise' ? event.data.control : 'rest'"
              @change="
                change((doc) =>
                  doc.replaceEventData(
                    event!.id,
                    value($event) === 'rest'
                      ? { kind: 'rest' }
                      : {
                          kind: 'noise',
                          control: Number(value($event)),
                          attenuation: event!.data.kind === 'noise' ? event!.data.attenuation : 4,
                        },
                  ),
                )
              "
            >
              <option value="rest">Rest</option>
              <option
                v-for="(name, control) in NOISE_CONTROL_NAMES"
                :key="control"
                :value="control"
              >
                {{ name }}
              </option>
            </select></label
          >
          <label
            >Length<input
              type="number"
              aria-label="Length in beats"
              :value="drafts.beats ?? beats(event)"
              @input="drafts.beats = value($event)"
              min="0.001"
              step="0.25"
              @change="
                commit('beats', () => friendly(event!.id, { beats: Number(value($event)) }))
              "
          /></label>
          <label v-if="'attenuation' in event.data" :title="VOCABULARY.volume.help"
            >Volume<input
              type="number"
              aria-label="Volume"
              :value="drafts.volume ?? attenuationToVolume(event.data.attenuation)"
              @input="drafts.volume = value($event)"
              min="0"
              max="15"
              @change="
                commit('volume', () => friendly(event!.id, { volume: Number(value($event)) }))
              "
          /></label>
        </div>
        <div class="sound-note-actions">
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="tracks[event.lane]?.[0]?.id === event.id"
            title="Move earlier (Alt+Left)"
            @click="move(event, -1)"
            >← Earlier</UiButton
          >
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="tracks[event.lane]?.at(-1)?.id === event.id"
            title="Move later (Alt+Right)"
            @click="move(event, 1)"
            >Later →</UiButton
          >
          <UiButton size="sm" variant="ghost" title="Remove (Delete)" @click="remove(event)"
            >Remove</UiButton
          >
        </div>
        <details class="sound-details">
          <summary>Details</summary>
          <p>
            {{ VOCABULARY.pitch.technical }} {{ VOCABULARY.volume.technical }} Timing uses 60 ticks
            per second.
          </p>
          <div class="sound-fields">
            <label
              >Ticks<input
                type="number"
                aria-label="Ticks"
                :value="drafts.ticks ?? event.durationTicks"
                @input="drafts.ticks = value($event)"
                min="0"
                max="65536"
                @change="
                  commit('ticks', () =>
                    change((doc) => doc.updateEvent(event!.id, { ticks: Number(value($event)) })),
                  )
                "
            /></label>
            <label v-if="event.data.kind === 'tone'"
              >Divisor<input
                type="number"
                aria-label="Divisor"
                :value="drafts.divisor ?? event.data.divisor"
                @input="drafts.divisor = value($event)"
                min="1"
                max="1023"
                @change="
                  commit('divisor', () =>
                    change((doc) => doc.updateEvent(event!.id, { divisor: Number(value($event)) })),
                  )
                "
            /></label>
            <label v-if="'attenuation' in event.data"
              >Attenuation<input
                type="number"
                aria-label="Attenuation"
                :value="drafts.attenuation ?? event.data.attenuation"
                @input="drafts.attenuation = value($event)"
                min="0"
                max="15"
                @change="
                  commit('attenuation', () =>
                    change((doc) =>
                      doc.updateEvent(event!.id, { attenuation: Number(value($event)) }),
                    ),
                  )
                "
            /></label>
          </div>
          <p v-if="event.data.kind === 'raw'">
            Raw bytes: {{ event.data.toneLow }}, {{ event.data.toneHigh }},
            {{ event.data.control }}. Length can be changed.
          </p>
        </details>
      </section>
      <p class="sound-help">
        Arrow keys choose notes. Alt + arrows move them. Insert adds; Delete removes. Space plays or
        stops.
      </p>
    </template>
    <p v-else>This SOUND uses an inspection format. {{ document.diagnostics.join(" ") }}</p>
    <p v-if="notice" class="workspace-error" role="alert">{{ notice }}</p>
  </div>
</template>
<style scoped>
.workspace-sound {
  overflow: auto;
  height: 100%;
  box-sizing: border-box;
}
h2,
h3,
p {
  margin: 0;
}
p {
  color: var(--ink-2);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.sound-heading {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  justify-content: space-between;
}
.sound-transport,
.sound-note-actions,
.sound-presets > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.sound-transport span {
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.sound-presets {
  margin: var(--space-5) 0;
}
.sound-presets h3 {
  margin-bottom: var(--space-2);
  color: var(--ink-2);
}
.sound-tempo {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-sm);
}
.sound-tempo span {
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.sound-tempo input {
  width: 5em;
}
.sound-help {
  margin: var(--space-3) 0;
}
.sound-voice {
  border-top: 1px solid var(--hairline);
  padding: var(--space-4) 0;
}
.sound-voice h3 {
  margin-bottom: var(--space-3);
}
.sound-notes {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  overflow-x: auto;
  padding-bottom: var(--space-2);
}
.sound-note {
  flex: 0 0 auto;
  display: grid;
  gap: var(--space-1);
  text-align: left;
  padding: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--ink);
  cursor: pointer;
}
.sound-note span {
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.sound-note--selected {
  border-color: var(--accent);
  background: var(--surface-3);
}
.sound-note:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sound-note-editor {
  padding: var(--space-4);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.sound-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}
.sound-fields label {
  display: grid;
  gap: var(--space-2);
  font-size: var(--text-sm);
  flex: 1 1 5em;
  min-width: 0;
}
input,
select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  color: var(--ink);
  background: var(--surface-0);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  font: inherit;
}
.sound-details {
  margin-top: var(--space-4);
  font-size: var(--text-sm);
}
.sound-details summary {
  cursor: pointer;
  color: var(--ink-2);
}
.sound-details p {
  margin-top: var(--space-3);
}
</style>
