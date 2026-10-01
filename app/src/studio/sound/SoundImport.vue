<script setup lang="ts">
import { ref, shallowRef, watch, onBeforeUnmount } from "vue";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { importMidi } from "../../../../src/sound/midi.ts";
import { importVgm } from "../../../../src/sound/vgm.ts";
import type { SoundImport } from "../../../../src/sound/musicImport.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{ file: File; profileId: ProfileId; replaceName?: string }>();
const emit = defineEmits<{ apply: [bytes: Uint8Array, tempo: number, add: boolean]; cancel: [] }>();
const result = shallowRef<SoundImport>(),
  error = ref("");
let epoch = 0;
watch(
  () => props.file,
  async (file) => {
    const reading = ++epoch;
    result.value = undefined;
    error.value = "";
    try {
      if (file.size > 4 * 1024 * 1024)
        throw new Error("Music file is too large. Choose a file under 4 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (reading !== epoch) return;
      result.value = /\.vgm$/i.test(file.name)
        ? importVgm(bytes, props.profileId)
        : importMidi(bytes, props.profileId);
    } catch (cause) {
      if (reading === epoch) error.value = cause instanceof Error ? cause.message : String(cause);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => epoch++);
</script>
<template>
  <section class="sound-music-preview" aria-label="Music import" data-testid="sound-import-summary">
    <strong>{{ file.name }}</strong>
    <p v-if="result">{{ result.summary }}</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <p v-else>Reading music…</p>
    <div>
      <UiButton
        v-if="result && replaceName"
        size="sm"
        @click="emit('apply', result.document.encode(), result.tempo, false)"
        >Replace {{ replaceName }}</UiButton
      >
      <UiButton
        v-if="result"
        size="sm"
        variant="ghost"
        @click="emit('apply', result.document.encode(), result.tempo, true)"
        >{{ VOCABULARY.addSound.label }}</UiButton
      >
      <UiButton size="sm" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
    </div>
  </section>
</template>
<style scoped>
.sound-music-preview {
  padding: var(--space-4);
  margin: var(--space-3) 0;
  border: 1px solid var(--action-line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
p {
  color: var(--ink-2);
  font-size: var(--text-sm);
  line-height: 1.5;
}
div {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
</style>
