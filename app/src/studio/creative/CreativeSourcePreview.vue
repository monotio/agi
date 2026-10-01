<script setup lang="ts">
/**
 * One staged source's preview: the canonical orientation-applied raster on a
 * checkerboard (so transparency reads), the name first, and the identity,
 * hash and byte size under Details.
 */
import { computed, useTemplateRef, watchEffect } from "vue";
import { versionRefKey } from "../../../../src/creative/catalog.ts";
import { drawRaster } from "./rasterCanvas.ts";
import type { WorkspaceSource } from "./creativeWorkspace.ts";

const { source, selected = false } = defineProps<{
  readonly source: WorkspaceSource;
  readonly selected?: boolean;
}>();
const emit = defineEmits<{ select: [] }>();

const canvas = useTemplateRef("canvas");
const width = computed(() => source.record.normalized.width);
const height = computed(() => source.record.normalized.height);
const key = computed(() => versionRefKey(source.record.identity));
watchEffect(
  () => {
    const target = canvas.value;
    if (!target) return;
    drawRaster(target, source.pixels, width.value, height.value);
  },
  { flush: "post" },
);
</script>

<template>
  <button
    type="button"
    class="source-preview"
    :class="{ 'is-selected': selected }"
    :data-source-key="key"
    @click="emit('select')"
  >
    <canvas ref="canvas" class="source-preview__image" :width="width" :height="height" />
    <span class="source-preview__name">{{ source.record.origin.title }}</span>
    <span class="source-preview__meta">{{ width }}×{{ height }}</span>
    <details class="source-preview__details" @click.stop>
      <summary>Details</summary>
      <dl class="source-preview__facts">
        <dt>Kind</dt>
        <dd>{{ source.record.origin.kind }}</dd>
        <dt>Type</dt>
        <dd>{{ source.record.encoded.mime }}</dd>
        <dt>Bytes</dt>
        <dd>{{ source.record.encoded.byteLength }}</dd>
        <dt>Hash</dt>
        <dd class="source-preview__hash">{{ source.record.encoded.hash.slice(0, 16) }}…</dd>
        <template v-if="source.record.origin.attribution !== undefined">
          <dt>Credit</dt>
          <dd>{{ source.record.origin.attribution }}</dd>
        </template>
      </dl>
    </details>
  </button>
</template>

<style scoped>
.source-preview {
  display: grid;
  grid-template-rows: auto auto auto;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-0);
  text-align: start;
  cursor: pointer;
}
.source-preview.is-selected {
  border-color: var(--action);
  box-shadow: 0 0 0 1px var(--action);
}
.source-preview__image {
  width: 100%;
  max-height: 120px;
  object-fit: contain;
  image-rendering: pixelated;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface-1) 0% 50%) 0 0 / 16px
    16px;
}
.source-preview__name {
  color: var(--ink);
  font: var(--weight-semibold) var(--text-sm) / var(--leading-tight) var(--font-sans);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-preview__meta {
  color: var(--ink-3);
  font: var(--weight-medium) var(--text-2xs) / 1 var(--font-mono);
}
.source-preview__details {
  color: var(--ink-3);
  font: var(--weight-medium) var(--text-2xs) / var(--leading) var(--font-sans);
}
.source-preview__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
  margin: var(--space-2) 0 0;
}
.source-preview__facts dt {
  color: var(--ink-3);
}
.source-preview__facts dd {
  margin: 0;
  color: var(--ink-2);
}
.source-preview__hash {
  font-family: var(--font-mono);
}
</style>
