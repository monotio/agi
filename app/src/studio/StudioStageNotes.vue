<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import UiKbd from "../ui/UiKbd.vue";
import type { StudioNotice } from "./useStudioEditing.ts";
import type { KeepBanner, KeepRecovery } from "./useStudioKeep.ts";

/**
 * The stage's messages: a failed Keep with the one recovery it allows, else
 * the last edit's notice (why it was refused, or that it was kept) with its
 * technical detail behind a disclosure, and the editing keys while an item
 * is selected.
 */
const { banner, notice, editing } = defineProps<{
  banner: KeepBanner | null;
  notice: StudioNotice | null;
  /** An editable item is selected: show the editing keys. */
  editing: boolean;
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
  <dl v-if="editing" class="stage-hint" data-testid="studio-hint" aria-label="Editing keys">
    <dt>Drag</dt>
    <dd>move the item or a point</dd>
    <dt><UiKbd>←↑→↓</UiKbd></dt>
    <dd>nudge 1 px, <UiKbd>⇧</UiKbd> 8 px</dd>
    <dt><UiKbd>⌥</UiKbd> + arrows</dt>
    <dd>next item</dd>
    <dt><UiKbd>[</UiKbd> <UiKbd>]</UiKbd></dt>
    <dd>draw order</dd>
  </dl>
</template>

<style scoped>
.stage-note {
  position: absolute;
  top: calc(var(--space-5) + var(--control-h));
  left: 50%;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  width: max-content;
  /* Clear of the Walk legend in the top-left corner. */
  max-width: min(560px, calc(100% - 2 * 184px));
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
.stage-hint {
  position: absolute;
  bottom: var(--space-4);
  left: var(--space-4);
  display: grid;
  grid-template-columns: auto auto;
  gap: var(--space-1) var(--space-3);
  align-items: center;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  color: var(--ink-3);
  background: var(--surface-overlay);
  font-size: var(--text-2xs);
  white-space: nowrap;
  pointer-events: none;
}
.stage-hint dt {
  color: var(--ink-2);
  text-align: right;
}
.stage-hint dd {
  margin: 0;
}
</style>
