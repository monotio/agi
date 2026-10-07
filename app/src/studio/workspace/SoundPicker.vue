<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import { ref, onBeforeUnmount } from "vue";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { applySoundPreset, SOUND_PRESETS } from "../../../../src/sound/presets.ts";
import { createSoundDocument } from "../../../../src/sound/document.ts";
import { createSoundPreview } from "../sound/soundPreview.ts";
import UiButton from "../../ui/UiButton.vue";
export interface SoundChoice {
  sound?: number;
  preset?: string;
}
export interface NamedSound {
  sound: number;
  name: string;
  bytes: Uint8Array;
}
const {
  sounds,
  profileId,
  disabled = false,
} = defineProps<{ sounds: readonly NamedSound[]; profileId: ProfileId; disabled?: boolean }>();
const emit = defineEmits<{ choose: [choice: SoundChoice] }>();
const choice = defineModel<SoundChoice>({ default: () => ({}) });
const preview = createSoundPreview({ acquirePauseLease: async () => ({ release() {} }) });
const playing = ref("");
const error = ref("");
const off = preview.subscribe(() => {
  if (preview.snapshot.status !== "playing") playing.value = "";
  if (preview.snapshot.refusal) error.value = "This sound could not play. Choose another sound.";
});
function audition(id: string, bytes: Uint8Array): void {
  error.value = "";
  if (playing.value === id) {
    preview.stop();
    return;
  }
  preview.setTarget({
    projectId: "workspace",
    documentId: id,
    revision: 0,
    payload: bytes,
    profileId,
  });
  playing.value = id;
  preview.play();
}
function recipe(id: string): void {
  try {
    audition(id, applySoundPreset(createSoundDocument({ profileId }), id).encode());
  } catch {
    error.value = "This recipe needs a three-voice SOUND. Choose one of your sounds.";
  }
}
function choose(next: SoundChoice): void {
  preview.stop();
  choice.value = next;
  emit("choose", next);
}
onBeforeUnmount(() => {
  off();
  void preview.close();
});
</script>
<template>
  <div class="sound-picker">
    <section role="group" aria-label="Your sounds">
      <h4>Your sounds</h4>
      <p v-if="!sounds.length">Your sounds appear here as you add them.</p>
      <div v-for="entry in sounds" :key="entry.sound" class="sound-choice">
        <UiButton
          size="sm"
          :variant="choice.sound === entry.sound && !choice.preset ? 'secondary' : 'ghost'"
          :aria-pressed="choice.sound === entry.sound && !choice.preset"
          :disabled
          :title="disabled ? 'Finish the current change, then choose a sound' : undefined"
          @click="choose({ sound: entry.sound })"
          >{{ entry.name }}</UiButton
        >
        <UiButton
          size="sm"
          variant="ghost"
          :aria-label="`${playing === `sound:${entry.sound}` ? 'Stop' : 'Play'} ${entry.name}`"
          @click="audition(`sound:${entry.sound}`, entry.bytes)"
          ><UiIcon :name="playing === `sound:${entry.sound}` ? 'square' : 'play'" :size="16"
        /></UiButton>
      </div>
    </section>
    <section role="group" aria-label="New sound from a recipe">
      <h4>New sound from a recipe</h4>
      <div v-for="entry in SOUND_PRESETS" :key="entry.id" class="sound-choice">
        <div>
          <UiButton
            size="sm"
            :variant="choice.preset === entry.id ? 'secondary' : 'ghost'"
            :aria-pressed="choice.preset === entry.id"
            :disabled
            :title="disabled ? 'Finish the current change, then choose a sound' : undefined"
            @click="choose({ preset: entry.id })"
            >{{ entry.name }}</UiButton
          >
          <small>{{ entry.description }}</small>
        </div>
        <UiButton
          size="sm"
          variant="ghost"
          :aria-label="`${playing === entry.id ? 'Stop' : 'Play'} ${entry.name}`"
          @click="recipe(entry.id)"
          ><UiIcon :name="playing === entry.id ? 'square' : 'play'" :size="16"
        /></UiButton>
      </div>
    </section>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.sound-picker {
  display: grid;
  gap: var(--space-3);
}
h4,
p {
  margin: 0 0 var(--space-2);
}
h4 {
  font-size: var(--text-sm);
  color: var(--ink);
}
p,
small {
  font-size: var(--text-xs);
  color: var(--ink-3);
}
small {
  display: block;
  padding: 0 var(--space-2) var(--space-2);
}
.sound-choice {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: var(--space-2);
  border-bottom: 1px solid var(--hairline);
}
.sound-choice > div {
  min-width: 0;
}
</style>
