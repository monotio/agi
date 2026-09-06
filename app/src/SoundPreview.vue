<script setup lang="ts">
import type { AgentLogAudio } from "./useEngine.ts";

defineProps<{
  audio: readonly AgentLogAudio[];
}>();
</script>

<template>
  <section
    class="sound-previews"
    aria-label="Sound listening previews"
    data-testid="sound-previews"
    @click.stop
  >
    <figure v-for="(preview, index) in audio" :key="preview.url" class="sound-preview">
      <figcaption>{{ preview.caption }}</figcaption>
      <audio
        :src="preview.url"
        controls
        preload="metadata"
        data-testid="sound-preview-audio"
      ></audio>
      <a
        :href="preview.url"
        :download="`agi-sound-preview-${index + 1}.wav`"
        class="ui-button ui-button--secondary"
        data-testid="sound-preview-download"
      >
        Download WAV
      </a>
    </figure>
  </section>
</template>

<style scoped>
.sound-previews {
  display: grid;
  gap: 8px;
  margin: 10px 0;
  padding: 10px;
  border: 1px solid #35535b;
  border-radius: 6px;
  background: #071216;
  color: #dce9eb;
  font:
    12px/1.45 system-ui,
    sans-serif;
}

.sound-preview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 10px;
  margin: 0;
}

.sound-preview figcaption {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
}

.sound-preview audio {
  width: 100%;
  min-width: 180px;
  height: 34px;
}

.sound-preview a {
  white-space: nowrap;
}

@media (max-width: 520px) {
  .sound-preview {
    grid-template-columns: 1fr;
  }

  .sound-preview audio {
    min-width: 0;
  }
}
</style>
