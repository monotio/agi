<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import type { StudioNotice } from "./useStudioNotice.ts";
import type { KeepBanner, KeepRecovery } from "./useStudioKeep.ts";

/**
 * The stage's messages: a failed Keep with the one recovery it allows, else
 * the last edit's notice (why it was refused, or that it was kept) with its
 * technical detail behind a disclosure. The editing keys are the status
 * bar's line and the `?` sheet, never the stage's.
 */
const { banner, notice } = defineProps<{
  banner: KeepBanner | null;
  notice: StudioNotice | null;
}>();
const emit = defineEmits<{
  recover: [recovery: KeepRecovery];
  /** The notice's details opened (true) or closed: hold it up meanwhile. */
  hold: [open: boolean];
}>();

const RECOVERY_LABELS: Record<KeepRecovery, string> = {
  reopen: "Reopen",
  reload: "Reload game",
  retry: "Retry",
};
</script>

<template>
  <p
    v-if="banner"
    class="stage-note stage-note--error"
    role="alert"
    data-testid="studio-keep-error"
  >
    <span>{{ banner.message }}</span>
    <UiButton
      size="sm"
      :data-recovery="banner.recovery"
      data-testid="studio-recover"
      @click="emit('recover', banner.recovery)"
    >
      {{ RECOVERY_LABELS[banner.recovery] }}
    </UiButton>
  </p>
  <div v-else-if="notice" class="stage-note" :class="`stage-note--${notice.tone}`" role="status">
    <span data-testid="studio-notice">{{ notice.text }}</span>
    <details
      v-if="notice.detail"
      class="stage-note__details"
      data-testid="studio-notice-detail"
      @toggle="emit('hold', ($event.target as HTMLDetailsElement).open)"
    >
      <summary>Details</summary>
      <p>{{ notice.detail }}</p>
    </details>
  </div>
</template>

<style scoped>
.stage-note {
  position: absolute;
  top: var(--space-4);
  left: 50%;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: max-content;
  max-width: min(560px, calc(100% - 2 * var(--space-4)));
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-xs);
  transform: translateX(-50%);
}
.stage-note:has(.stage-note__details) {
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.stage-note__details summary {
  color: var(--ink-2);
  cursor: pointer;
}
.stage-note__details p {
  margin: var(--space-1) 0 0;
  color: var(--ink-2);
  font-family: var(--font-mono);
  white-space: pre-line;
}
.stage-note--error {
  border-color: var(--danger-line);
  background: var(--surface-1);
}
.stage-note--warn {
  border-color: var(--warn-line);
  color: var(--warn);
}
.stage-note--ok {
  border-color: var(--ok-line);
  color: var(--ok);
}
</style>
