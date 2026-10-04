<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import {
  importSoundDocument,
  type SoundDocument,
  type SoundEvent,
} from "../../../../src/sound/document.ts";
import { applySoundPreset } from "../../../../src/sound/presets.ts";
import { createSoundDocument } from "../../../../src/sound/document.ts";
import SoundPicker, { type SoundChoice, type NamedSound } from "./SoundPicker.vue";
import { createSoundPreview } from "../sound/soundPreview.ts";
import {
  attenuationToVolume,
  divisorNoteLabel,
  editSoundNote,
  LANE_NAMES,
  NOISE_CONTROL_NAMES,
  retimeSound,
} from "../sound/soundEdits.ts";
import UiButton from "../../ui/UiButton.vue";
import UiExplain from "../../ui/UiExplain.vue";
import SoundGrid from "../sound/SoundGrid.vue";
import SoundTracker from "../sound/SoundTracker.vue";
import SoundImport from "../sound/SoundImport.vue";
import { exportMidi } from "../../../../src/sound/midi.ts";
import { gridTick, beatLengthLabel, silenceSoundEvent } from "../../../../src/sound/sequencer.ts";
import { DRUM_SOUNDS } from "../../../../src/sound/sequencer.ts";
const props = defineProps<{
  readOnly?: boolean;
  documentKey: string;
  bytes: Uint8Array;
  profileId: ProfileId;
  tempo: number;
  active: boolean;
  importFile?: File | undefined;
  sounds: readonly NamedSound[];
}>();
const emit = defineEmits<{
  edit: [bytes: Uint8Array, tempo: number];
  add: [bytes: Uint8Array, tempo: number];
  imported: [];
  open: [sound: number];
}>();
const mode = ref("grid");
const voice = ref(0);
const division = ref(16);
const drawVolume = ref(12);
const cursorLabel = ref("");
const musicFile = shallowRef<File>();
const fileInput = useTemplateRef("fileInput");
watch(
  () => props.importFile,
  (file) => {
    if (file) musicFile.value = file;
  },
  { immediate: true },
);
const notice = ref("");
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
const position = ref(0);
const unsubscribe = preview.subscribe(() => {
  status.value = preview.snapshot.status;
  position.value = preview.snapshot.positionTicks;
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
  if (props.readOnly) return;
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
function selectNote(id: string | undefined): void {
  selected.value = id;
  const note = tracks.value?.flat().find((entry) => entry.id === id);
  if (note) voice.value = note.lane;
}
function commit(field: SoundField, edit: () => void): void {
  if (props.readOnly) return;
  edit();
  delete drafts.value[field];
}
watch(selected, () => {
  drafts.value = {};
});
function draft(field: SoundField, event: Event): void {
  if (!props.readOnly) drafts.value[field] = value(event);
}
function value(event: Event): string {
  return (event.target as HTMLInputElement).value;
}
function pitch(event: SoundEvent): string {
  const data = event.data;
  return data.kind === "tone"
    ? divisorNoteLabel(data.divisor)
    : data.kind === "noise"
      ? DRUM_SOUNDS.find((drum) => drum.control === data.control)!.name
      : data.kind === "rest"
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
const pickerOpen = ref(false);
function chooseSound(choice: SoundChoice): void {
  if (props.readOnly) return;
  if (choice.preset)
    emit(
      "add",
      applySoundPreset(createSoundDocument({ profileId: props.profileId }), choice.preset).encode(),
      tempo.value,
    );
  else if (choice.sound !== undefined) emit("open", choice.sound);
  pickerOpen.value = false;
}
function setTempo(after: number): void {
  change((doc) => {
    const next = retimeSound(doc, tempo.value, after);
    tempo.value = after;
    return next;
  });
}
function remove(note: SoundEvent): void {
  change((doc) => silenceSoundEvent(doc, note.id));
}
function gridEdit(next: SoundDocument): void {
  change(() => next);
}
function chooseFile(event: Event): void {
  if (props.readOnly) return;
  const input = event.target as HTMLInputElement;
  musicFile.value = input.files?.[0];
  input.value = "";
}
function drop(event: DragEvent): void {
  if (props.readOnly) return;
  const file = event.dataTransfer?.files[0];
  if (!file || !/\.(mid|midi|vgm)$/i.test(file.name)) return;
  event.preventDefault();
  event.stopPropagation();
  musicFile.value = file;
}
function applyImport(bytes: Uint8Array, after: number, add: boolean): void {
  if (props.readOnly) return;
  if (add) emit("add", bytes, after);
  else
    change(() => {
      const next = importSoundDocument(bytes, { profileId: props.profileId });
      tempo.value = after;
      selected.value = undefined;
      return next;
    });
  musicFile.value = undefined;
  emit("imported");
}
function midiDownload(): void {
  try {
    const bytes = exportMidi(document.value);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/midi" }));
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${props.documentKey.replace(":", "-")}.mid`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (cause) {
    notice.value = cause instanceof Error ? cause.message : String(cause);
  }
}
function keys(key: KeyboardEvent): void {
  if (!props.active || key.ctrlKey || key.metaKey) return;
  const element = key.target as HTMLElement;
  if (element.matches("input, select, textarea, summary")) return;
  if (key.code === "Space") {
    key.preventDefault();
    key.stopPropagation();
    if (!key.repeat) transport();
  }
}
onBeforeUnmount(() => {
  unsubscribe();
  void preview.close();
});
</script>
<template>
  <div
    class="workspace-sound"
    data-testid="workspace-sound"
    @keydown="keys"
    @dragover.prevent
    @drop="drop"
  >
    <header class="sound-heading">
      <div>
        <h2>
          <UiExplain
            term="sound-editor"
            :name="VOCABULARY.sound.label"
            :says="VOCABULARY.sound.help"
            >SOUND {{ documentKey.split(":")[1] }}</UiExplain
          >
        </h2>
      </div>
      <div class="sound-transport">
        <button
          type="button"
          class="sound-play"
          data-testid="sound-play"
          :aria-label="status === 'playing' ? 'Stop' : 'Play'"
          title="Play or stop (Space)"
          :aria-pressed="status === 'playing'"
          @click="transport"
        >
          <span aria-hidden="true">{{ status === "playing" ? "■" : "▶" }}</span>
        </button>
        <UiButton
          size="sm"
          variant="ghost"
          :title="VOCABULARY.exportMidi.help"
          @click="midiDownload"
          >{{ VOCABULARY.exportMidi.label }}</UiButton
        >
      </div>
    </header>
    <div class="sound-toolbar">
      <div v-if="tracks" class="sound-lenses" role="group" aria-label="Sound view">
        <UiButton
          size="sm"
          variant="ghost"
          :aria-pressed="mode === 'grid'"
          @click="mode = 'grid'"
          >{{ VOCABULARY.grid.label }}</UiButton
        >
        <UiButton
          size="sm"
          variant="ghost"
          :aria-pressed="mode === 'tracker'"
          @click="mode = 'tracker'"
          >{{ VOCABULARY.tracker.label }}</UiButton
        >
      </div>
      <UiButton
        v-if="tracks"
        size="sm"
        variant="ghost"
        :disabled="readOnly"
        :title="readOnly ? 'Editing is paused in this tab' : undefined"
        :aria-expanded="pickerOpen"
        @click="pickerOpen = !pickerOpen"
        >Choose preset</UiButton
      >
      <UiButton
        size="sm"
        variant="ghost"
        :disabled="readOnly"
        :title="readOnly ? 'Editing is paused in this tab' : undefined"
        @click="fileInput?.click()"
        >{{ VOCABULARY.importMusic.label }}</UiButton
      >
      <input
        ref="fileInput"
        hidden
        type="file"
        accept=".mid,.midi,.vgm"
        aria-label="Music file"
        :disabled="readOnly"
        :title="readOnly ? 'Editing is paused in this tab' : undefined"
        @change="chooseFile"
      />
    </div>
    <SoundPicker
      v-if="pickerOpen"
      class="sound-recipe-picker"
      :sounds="sounds"
      :profile-id="profileId"
      :disabled="readOnly"
      @choose="chooseSound"
    />
    <SoundImport
      v-if="musicFile"
      :read-only="readOnly"
      :file="musicFile"
      :profile-id="profileId"
      :replace-name="`SOUND ${documentKey.split(':')[1]}`"
      @apply="applyImport"
      @cancel="
        musicFile = undefined;
        emit('imported');
      "
    />
    <template v-if="tracks">
      <div class="sound-toolbar">
        <label class="sound-tempo"
          >Tempo
          <input
            type="number"
            aria-label="Tempo"
            :disabled="readOnly"
            :title="readOnly ? 'Editing is paused in this tab' : undefined"
            :value="drafts.tempo ?? tempo"
            @input="draft('tempo', $event)"
            min="40"
            max="240"
            @change="commit('tempo', () => setTempo(Number(value($event))))"
          />
          <span>beats/min</span>
        </label>
        <label class="sound-snap"
          >Snap
          <select aria-label="Snap" v-model.number="division">
            <option :value="16">1/16 · ¼ beat</option>
            <option :value="8">⅛ · ½ beat</option>
            <option :value="4">¼ · 1 beat</option>
            <option :value="2">½ · 2 beats</option>
          </select>
        </label>
      </div>
      <div class="sound-voices" role="group" aria-label="Voice to draw with">
        <UiButton
          v-for="lane in [0, 1, 2, 3]"
          :key="lane"
          size="sm"
          variant="ghost"
          :class="`voice-${lane}`"
          :aria-pressed="voice === lane"
          @click="voice = lane"
          ><i class="sound-voice-swatch" aria-hidden="true"></i
          >{{
            lane === 3 ? VOCABULARY.drums.label : `${VOCABULARY.voice.label} ${lane + 1}`
          }}</UiButton
        >
      </div>
      <SoundGrid
        v-if="mode === 'grid'"
        :read-only="readOnly"
        :document="document"
        :tempo="tempo"
        :division="division"
        :voice="voice"
        :volume="drawVolume"
        :position="status === 'playing' ? position : 0"
        :selected="selected"
        @edit="gridEdit"
        @select="selectNote"
        @cursor="cursorLabel = $event"
        @voice="voice = $event"
        @error="notice = $event"
      />
      <SoundTracker
        v-else
        :read-only="readOnly"
        :document="document"
        :step-ticks="gridTick(1, tempo, division)"
        :position="status === 'playing' ? position : 0"
        @edit="gridEdit"
        @select="selectNote"
        @error="notice = $event"
      />
      <div v-if="!event" class="sound-footer">
        <span>{{ cursorLabel }}</span
        ><label
          >{{ VOCABULARY.volume.label
          }}<input
            type="range"
            aria-label="Drawing volume"
            :disabled="readOnly"
            :title="readOnly ? 'Editing is paused in this tab' : undefined"
            v-model.number="drawVolume"
            min="0"
            max="15"
        /></label>
      </div>
      <section v-if="event" class="sound-note-editor" aria-label="Selected note">
        <div class="sound-footer-row">
          <h3>
            {{ LANE_NAMES[event.lane] }} · {{ pitch(event) }} ·
            {{ beatLengthLabel(event.durationTicks, tempo) }} · {{ event.durationTicks }} ticks
          </h3>
          <div class="sound-footer-volume">
            <label v-if="'attenuation' in event.data" :title="VOCABULARY.volume.help"
              >Volume<input
                type="number"
                aria-label="Volume"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                :value="drafts.volume ?? attenuationToVolume(event.data.attenuation)"
                @input="draft('volume', $event)"
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
              :disabled="readOnly"
              :title="readOnly ? 'Editing is paused in this tab' : 'Remove (Delete)'"
              @click="remove(event)"
              >Remove</UiButton
            >
          </div>
        </div>
        <details class="sound-details">
          <summary>Details</summary>
          <div class="sound-fields">
            <label v-if="event.lane < 3 && event.data.kind !== 'raw'" :title="VOCABULARY.pitch.help"
              >Note<input
                aria-label="Note"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                :value="drafts.note ?? pitch(event)"
                @input="draft('note', $event)"
                @change="commit('note', () => friendly(event!.id, { note: value($event) }))"
            /></label>
            <label v-if="event.lane === 3 && event.data.kind !== 'raw'"
              >Noise<select
                aria-label="Noise pattern"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
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
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                :value="drafts.beats ?? beats(event)"
                @input="draft('beats', $event)"
                min="0.001"
                step="0.25"
                @change="
                  commit('beats', () => friendly(event!.id, { beats: Number(value($event)) }))
                "
            /></label>
          </div>

          <p>
            {{ VOCABULARY.pitch.technical }} {{ VOCABULARY.volume.technical }} Timing uses 60 ticks
            per second.
          </p>
          <div class="sound-fields">
            <label
              >Ticks<input
                type="number"
                aria-label="Ticks"
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                :value="drafts.ticks ?? event.durationTicks"
                @input="draft('ticks', $event)"
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
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                :value="drafts.divisor ?? event.data.divisor"
                @input="draft('divisor', $event)"
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
                :disabled="readOnly"
                :title="readOnly ? 'Editing is paused in this tab' : undefined"
                :value="drafts.attenuation ?? event.data.attenuation"
                @input="draft('attenuation', $event)"
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
      <p class="sound-help">Drop a .mid or .vgm file here or onto the game.</p>
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
.sound-note-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.sound-heading > div:first-child {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sound-play {
  width: var(--control-h);
  height: var(--control-h);
  flex: none;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--action);
  color: var(--action-ink);
  font-size: var(--text-sm);
  cursor: pointer;
}
.sound-play[aria-pressed="true"] {
  background: var(--warn);
}
.sound-play:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.sound-voices .ui-btn {
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
}
.sound-voice-swatch {
  display: inline-block;
  margin-right: var(--space-2);
  width: 10px;
  height: 10px;
  border-radius: var(--radius-sm);
  background: var(--voice-colour);
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
.sound-toolbar,
.sound-voices,
.sound-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-3) 0;
}
.sound-lenses {
  display: flex;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.sound-preset,
.sound-snap,
.sound-footer label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.sound-preset select,
.sound-snap select {
  width: auto;
}
.sound-footer {
  font-size: var(--text-xs);
  color: var(--ink-2);
}
.sound-footer input {
  width: 6em;
}
.sound-voices .voice-0 {
  --voice-colour: var(--action);
}
.sound-voices .voice-1 {
  --voice-colour: var(--warn);
}
.sound-voices .voice-2 {
  --voice-colour: var(--danger);
}
.sound-voices .voice-3 {
  --voice-colour: var(--ink-2);
}
.sound-voices [aria-pressed="true"],
.sound-lenses [aria-pressed="true"] {
  background: var(--surface-3);
  outline: 1px solid var(--hairline-strong);
}
.sound-note-editor {
  padding: var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}
.sound-footer-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.sound-footer-row h3 {
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  flex: 1;
}
.sound-footer-volume label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.sound-footer-volume input {
  width: 4em;
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
