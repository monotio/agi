<script setup lang="ts">
import { ref, watch } from "vue";
import type { SoundEvent } from "../../../../src/sound/document.ts";
import type { SoundEntry } from "./soundWorkspace.ts";
import { VOCABULARY } from "../../../../src/studio/vocabulary.ts";
import {
  attenuationToVolume,
  volumeToAttenuation,
  divisorNoteLabel,
  LANE_NAMES,
  NOISE_CONTROL_NAMES,
  ticksSeconds,
} from "./soundEdits.ts";
import UiButton from "../../ui/UiButton.vue";

/**
 * The contextual inspector: with an event selected it edits that event's
 * native fields; without one it shows the cue's authored tempo, usage and
 * diagnostics. Validation is the document's — the model's own messages are
 * shown verbatim, so 0 = 65,536 ticks and the 65,535 terminator refusal read
 * exactly.
 */
const props = defineProps<{
  event: SoundEvent | null;
  /** The cue summary from the workspace; null when nothing is open. */
  cue: SoundEntry | null;
  /** A refused edit's message to show until the next change. */
  error: string | null;
  /** True when the document is opaque (byte inspection only). */
  readonly: boolean;
}>();

const emit = defineEmits<{
  setTicks: [ticks: number];
  setNote: [note: string];
  setAttenuation: [attenuation: number];
  setControl: [control: number];
  replaceData: [kind: "tone" | "noise" | "rest"];
  removeEvent: [];
  duplicateEvent: [];
  splitEvent: [ticks: number];
  setTempo: [tempo: number];
}>();

const ticksText = ref("");
const noteText = ref("");
const attenuationText = ref("");
const tempoText = ref("");
const splitText = ref("");

watch(
  () => props.event,
  (event) => {
    ticksText.value = event === null ? "" : String(event.durationTicks);
    noteText.value =
      event?.data.kind === "tone" ? divisorNoteLabel(event.data.divisor).replace("≈", "") : "";
    attenuationText.value =
      event !== null && event.data.kind !== "rest" && "attenuation" in event.data
        ? String(attenuationToVolume(event.data.attenuation))
        : "";
    splitText.value = "";
  },
  { immediate: true },
);

watch(
  () => props.cue?.tempo,
  (tempo) => {
    tempoText.value = tempo === null || tempo === undefined ? "" : String(tempo);
  },
  { immediate: true },
);

function textOf(text: string | number): string {
  return String(text).trim();
}

function commitTicks(): void {
  const raw = textOf(ticksText.value);
  const ticks = Number(raw);
  if (raw === "" || !Number.isInteger(ticks)) return;
  emit("setTicks", ticks);
}

function commitNote(): void {
  if (textOf(noteText.value) === "") return;
  emit("setNote", textOf(noteText.value));
}

function commitAttenuation(): void {
  const raw = textOf(attenuationText.value);
  const attenuation = Number(raw);
  if (raw === "" || !Number.isInteger(attenuation)) return;
  if (attenuation < 0 || attenuation > 15) return;
  emit("setAttenuation", volumeToAttenuation(attenuation));
}

function commitTempo(): void {
  const raw = textOf(tempoText.value);
  const tempo = Number(raw);
  if (raw === "" || !Number.isInteger(tempo)) return;
  emit("setTempo", tempo);
}

function commitSplit(): void {
  const raw = textOf(splitText.value);
  const at = Number(raw);
  if (raw === "" || !Number.isInteger(at)) return;
  emit("splitEvent", at);
}

const CONTROL_OPTIONS = Object.entries(NOISE_CONTROL_NAMES).map(([value, name]) => ({
  value: Number(value),
  name,
}));
</script>

<template>
  <aside class="sound-inspector" aria-label="Inspector" data-testid="sound-inspector">
    <template v-if="event !== null">
      <h2 class="sound-inspector__head">
        {{ LANE_NAMES[event.lane] }} · {{ event.data.kind === "rest" ? "Rest" : "Note" }}
      </h2>
      <p v-if="readonly" class="sound-inspector__note">This sound format is read-only.</p>
      <fieldset class="sound-inspector__field" :disabled="readonly">
        <label for="sound-event-ticks">Duration (ticks)</label>
        <input
          id="sound-event-ticks"
          v-model="ticksText"
          type="number"
          min="0"
          max="65536"
          step="1"
          data-testid="sound-event-ticks"
          @change="commitTicks"
        />
        <p class="sound-inspector__help">
          60 ticks per second. A single note lasts 1–65,534 or 65,536 ticks.
        </p>
      </fieldset>

      <template v-if="event.data.kind === 'tone'">
        <fieldset class="sound-inspector__field" :disabled="readonly">
          <label
            for="sound-event-note"
            :title="`${VOCABULARY.pitch.help} ${VOCABULARY.pitch.technical} Divisor: ${event.data.divisor}.`"
            >Pitch</label
          >
          <input
            id="sound-event-note"
            v-model="noteText"
            type="text"
            :placeholder="divisorNoteLabel(event.data.divisor) || 'A4'"
            data-testid="sound-event-note"
            @change="commitNote"
          />
        </fieldset>
      </template>

      <template v-if="event.data.kind === 'noise'">
        <fieldset class="sound-inspector__field" :disabled="readonly">
          <label for="sound-event-control">Noise</label>
          <select
            id="sound-event-control"
            :value="event.data.control & 7"
            data-testid="sound-event-control"
            @change="emit('setControl', Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="option in CONTROL_OPTIONS" :key="option.value" :value="option.value">
              {{ option.name }}
            </option>
          </select>
        </fieldset>
      </template>

      <fieldset
        v-if="event.data.kind === 'tone' || event.data.kind === 'noise'"
        class="sound-inspector__field"
        :disabled="readonly"
      >
        <label
          for="sound-event-attenuation"
          :title="`${VOCABULARY.volume.help} ${VOCABULARY.volume.technical}`"
          >Volume (0–15)</label
        >
        <input
          id="sound-event-attenuation"
          v-model="attenuationText"
          type="number"
          min="0"
          max="15"
          step="1"
          data-testid="sound-event-attenuation"
          @change="commitAttenuation"
        />
      </fieldset>

      <template v-if="event.data.kind === 'raw'">
        <p class="sound-inspector__note" data-testid="sound-event-raw">
          Raw record {{ event.data.toneLow }}, {{ event.data.toneHigh }}, {{ event.data.control }}.
          Replace its data to edit pitch or volume.
        </p>
        <div class="sound-inspector__row">
          <UiButton
            size="sm"
            variant="ghost"
            data-testid="sound-replace-tone"
            @click="emit('replaceData', 'tone')"
          >
            Make tone
          </UiButton>
          <UiButton
            size="sm"
            variant="ghost"
            data-testid="sound-replace-noise"
            @click="emit('replaceData', 'noise')"
          >
            Make noise
          </UiButton>
          <UiButton
            size="sm"
            variant="ghost"
            data-testid="sound-replace-rest"
            @click="emit('replaceData', 'rest')"
          >
            Make rest
          </UiButton>
        </div>
      </template>

      <template v-if="event.data.kind === 'rest'">
        <div class="sound-inspector__row">
          <UiButton
            size="sm"
            variant="ghost"
            data-testid="sound-rest-tone"
            @click="emit('replaceData', 'tone')"
          >
            Make tone
          </UiButton>
          <UiButton
            v-if="event.lane === 3"
            size="sm"
            variant="ghost"
            data-testid="sound-rest-noise"
            @click="emit('replaceData', 'noise')"
          >
            Make noise
          </UiButton>
        </div>
      </template>

      <div class="sound-inspector__row">
        <input
          v-model="splitText"
          type="number"
          min="1"
          :max="Math.max(1, event.durationTicks - 1)"
          step="1"
          placeholder="split at tick"
          aria-label="Split after ticks"
          data-testid="sound-event-split"
          :disabled="readonly || event.durationTicks < 2"
        />
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="readonly || event.durationTicks < 2"
          :title="
            readonly
              ? 'Read-only sound format'
              : event.durationTicks < 2
                ? 'Splitting requires at least two ticks'
                : 'Split into two notes; the second re-triggers its envelope'
          "
          data-testid="sound-event-split-apply"
          @click="commitSplit"
        >
          Split
        </UiButton>
      </div>
      <div class="sound-inspector__row">
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="readonly"
          :title="readonly ? 'Read-only sound format' : 'Copy this note'"
          data-testid="sound-event-duplicate"
          @click="emit('duplicateEvent')"
        >
          Duplicate
        </UiButton>
        <UiButton
          size="sm"
          variant="danger"
          :disabled="readonly"
          :title="readonly ? 'Read-only sound format' : 'Delete this note'"
          data-testid="sound-event-remove"
          @click="emit('removeEvent')"
        >
          Remove
        </UiButton>
      </div>
    </template>

    <template v-else-if="cue !== null">
      <h2 class="sound-inspector__head">SOUND {{ cue.num }}</h2>
      <p class="sound-inspector__meta">
        {{ cue.bytes }} bytes<template v-if="cue.extentTicks !== null">
          · {{ cue.extentTicks }} ticks · {{ ticksSeconds(cue.extentTicks).toFixed(2) }} s</template
        >
      </p>
      <p v-if="cue.opaque" class="sound-inspector__note" data-testid="sound-opaque-note">
        This {{ cue.family }} sound is read-only here. Export keeps it exactly as it is.
      </p>
      <p v-else class="sound-inspector__help" data-testid="sound-cue-hint">
        Select a note or rest to edit it. Click the timeline to use these keys: N adds a note, R
        adds a rest, Space plays.
      </p>
      <fieldset class="sound-inspector__field" :disabled="cue.opaque">
        <label for="sound-cue-tempo">Tempo (BPM)</label>
        <input
          id="sound-cue-tempo"
          v-model="tempoText"
          type="number"
          min="20"
          max="600"
          step="1"
          data-testid="sound-cue-tempo"
          @change="commitTempo"
        />
      </fieldset>
      <template v-if="cue.usedBy.length > 0">
        <h3 class="sound-inspector__sub">Used by</h3>
        <ul class="sound-inspector__uses" data-testid="sound-used-by">
          <li v-for="use in cue.usedBy" :key="use">{{ use }}</li>
        </ul>
      </template>
      <template v-if="cue.diagnostics.length > 0">
        <h3 class="sound-inspector__sub">Notes</h3>
        <ul class="sound-inspector__uses" data-testid="sound-diagnostics">
          <li v-for="(diagnostic, index) in cue.diagnostics" :key="index">{{ diagnostic }}</li>
        </ul>
      </template>
    </template>

    <p v-else class="sound-inspector__empty">Select a note, rest or SOUND.</p>
    <p v-if="error" class="sound-inspector__error" role="alert" data-testid="sound-edit-error">
      {{ error }}
    </p>
  </aside>
</template>

<style scoped>
.sound-inspector {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-left: 1px solid var(--hairline-strong);
  background: var(--surface-1);
  overflow-y: auto;
}
.sound-inspector__head {
  margin: 0;
  font: var(--weight-semibold) var(--text-sm) / var(--leading) var(--font-sans);
}
.sound-inspector__sub {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
}
.sound-inspector__meta,
.sound-inspector__help,
.sound-inspector__note,
.sound-inspector__empty {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.sound-inspector__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  border: 0;
}
.sound-inspector__field:disabled {
  opacity: 0.55;
}
.sound-inspector__field label {
  color: var(--ink-2);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.sound-inspector__field input,
.sound-inspector__field select,
.sound-inspector__row input {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.sound-inspector__field input:focus-visible,
.sound-inspector__field select:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.sound-inspector__row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.sound-inspector__row input {
  width: 7em;
}
.sound-inspector__uses {
  margin: 0;
  padding-left: var(--space-4);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.sound-inspector__error {
  margin: 0;
  padding: var(--space-2);
  border: 1px solid var(--danger-line);
  border-radius: var(--radius-sm);
  color: var(--danger);
  background: var(--danger-soft);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
</style>
