<script setup lang="ts">
/**
 * Stands in the Create centre for Room Studio (studio/RoomStudio.vue) until
 * the two are integrated: the same props and the same `close` emit, showing
 * what Studio was asked to open. The game stays paused while it shows.
 */
import { onMounted, useTemplateRef } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import type { AgiProfile } from "../../../src/runtime/profile.ts";

const {
  pictureNumber,
  bytes,
  authoredSource = undefined,
  profile,
  title,
  subtitle = undefined,
} = defineProps<{
  pictureNumber: number;
  bytes: Uint8Array;
  authoredSource?: string | undefined;
  profile: AgiProfile;
  title: string;
  subtitle?: string | undefined;
}>();
const emit = defineEmits<{ close: [] }>();

const closeButton = useTemplateRef("closeButton");
onMounted(() => closeButton.value?.$el.focus());

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  emit("close");
}
</script>

<template>
  <section
    class="studio-placeholder"
    aria-label="Room Studio"
    data-testid="studio-placeholder"
    data-shell-keys
    @keydown="onKeydown"
  >
    <header class="studio-placeholder__head">
      <div class="studio-placeholder__title">
        <h2>{{ title }}</h2>
        <span v-if="subtitle">{{ subtitle }}</span>
      </div>
      <UiChip tone="warn" dot>Game paused</UiChip>
      <UiButton
        ref="closeButton"
        icon="x"
        size="sm"
        data-testid="studio-close"
        @click="emit('close')"
      >
        Close Studio
      </UiButton>
    </header>
    <div class="studio-placeholder__body">
      <p class="studio-placeholder__lead">Room Studio opens here.</p>
      <dl class="studio-placeholder__facts">
        <dt>Picture</dt>
        <dd data-testid="studio-picture">PIC {{ pictureNumber }}</dd>
        <dt>Bytes</dt>
        <dd data-testid="studio-bytes">{{ bytes.length }}</dd>
        <dt>Interpreter</dt>
        <dd data-testid="studio-profile">{{ profile.id }}</dd>
        <dt>Picture text</dt>
        <dd data-testid="studio-source">
          {{
            authoredSource === undefined ? "none trusted" : `${authoredSource.length} characters`
          }}
        </dd>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.studio-placeholder {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--surface-sunken);
}
.studio-placeholder__head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  border-bottom: 1px solid var(--hairline);
  background: var(--surface-0);
}
.studio-placeholder__title {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  line-height: var(--leading-tight);
}
.studio-placeholder__title h2 {
  margin: 0;
  font: var(--weight-semibold) var(--text-md) / var(--leading-tight) var(--font-sans);
}
.studio-placeholder__title span {
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.studio-placeholder__body {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: var(--space-5);
  padding: var(--space-7);
}
.studio-placeholder__lead {
  margin: 0;
  color: var(--ink-2);
}
.studio-placeholder__facts {
  display: grid;
  grid-template-columns: auto auto;
  gap: var(--space-2) var(--space-5);
  margin: 0;
  padding: var(--space-5) var(--space-6);
  border: 1px dashed var(--hairline-strong);
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
}
.studio-placeholder__facts dt {
  color: var(--ink-3);
}
.studio-placeholder__facts dd {
  margin: 0;
  font-family: var(--font-mono);
}
</style>
