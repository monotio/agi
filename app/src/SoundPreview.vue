<script setup lang="ts">
import type { AgentLogAudio } from "./agent/agentLog.ts";

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
        class="sound-preview__download"
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
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-0);
  color: var(--ink);
  font: var(--text-xs) / 1.45 var(--font-sans);
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

/* A download needs an anchor, so the shared secondary look is restated here. */
.sound-preview__download {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--control-h);
  box-sizing: border-box;
  padding: 0 var(--space-5);
  border: 1px solid var(--action-line);
  border-radius: var(--radius);
  color: var(--action);
  background: transparent;
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
}
.sound-preview__download:hover {
  border-color: var(--action);
  background: var(--action-soft);
}
@media (pointer: coarse) {
  .sound-preview__download {
    min-height: var(--control-h-touch);
  }
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
