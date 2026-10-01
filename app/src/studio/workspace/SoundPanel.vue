<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { onBeforeUnmount, ref, watch } from "vue";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { importSoundDocument } from "../../../../src/sound/document.ts";
import { applySoundPreset, SOUND_PRESETS } from "../../../../src/sound/presets.ts";
import { createSoundPreview } from "../sound/soundPreview.ts";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{
  documentKey: string;
  bytes: Uint8Array;
  profileId: ProfileId;
  active: boolean;
}>();
const emit = defineEmits<{ edit: [bytes: Uint8Array] }>();
const notice = ref("");
// Audition owns private audio. The workspace's MAIN continues during playback.
const preview = createSoundPreview({ acquirePauseLease: async () => ({ release() {} }) });
watch(
  () => props.bytes,
  (bytes) =>
    preview.setTarget({
      projectId: "workspace",
      documentId: props.documentKey,
      revision: 0,
      payload: bytes,
      profileId: props.profileId,
    }),
  { immediate: true },
);
watch(
  () => props.active,
  (active) => {
    if (!active) preview.stop();
  },
);
function preset(id: string): void {
  try {
    emit(
      "edit",
      applySoundPreset(
        importSoundDocument(props.bytes, { profileId: props.profileId }),
        id,
      ).encode(),
    );
    notice.value = "";
  } catch (cause) {
    notice.value = String(cause instanceof Error ? cause.message : cause);
  }
}
onBeforeUnmount(() => {
  void preview.close();
});
</script>
<template>
  <div class="workspace-sound" data-testid="workspace-sound">
    <h2>SOUND {{ documentKey.split(":")[1] }}</h2>
    <p>{{ VOCABULARY.sound.help }}</p>
    <UiButton size="sm" @click="preview.play">Play</UiButton>
    <UiButton size="sm" @click="preview.stop">Stop</UiButton>
    <h3>Presets</h3>
    <UiButton
      v-for="entry in SOUND_PRESETS"
      :key="entry.id"
      size="sm"
      :title="entry.description"
      @click="preset(entry.id)"
      >{{ entry.name }}</UiButton
    >
    <p v-if="notice" role="alert">{{ notice }}</p>
  </div>
</template>
