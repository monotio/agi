<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import type { StudioNotice } from "./useStudioNotice.ts";
import type { KeepBanner, KeepRecovery } from "./useStudioKeep.ts";

/**
 * Studio's messages, in the status line where they never cover the
 * picture: a failed Keep with the one recovery it allows, else the last
 * edit's notice (why it was refused, or what it did) with the step it
 * offers and its technical detail behind a disclosure that opens above the
 * line. Each has its own close button.
 */
const { banner = null, notice } = defineProps<{
  banner?: KeepBanner | null;
  notice: StudioNotice | null;
}>();
const emit = defineEmits<{
  recover: [recovery: KeepRecovery];
  /** Close the notice. */
  dismiss: [];
  /** Close the failed Keep's message. */
  close: [];
}>();

const RECOVERY_LABELS: Record<KeepRecovery, string> = {
  reopen: "Reopen",
  reload: "Reload game",
  retry: "Retry",
};
</script>

<template>
  <span
    v-if="banner"
    class="status-notice status-notice--error"
    role="alert"
    data-testid="studio-keep-error"
  >
    <span class="status-notice__text">{{ banner.message }}</span>
    <UiButton
      size="sm"
      :data-recovery="banner.recovery"
      data-testid="studio-recover"
      @click="emit('recover', banner.recovery)"
    >
      {{ RECOVERY_LABELS[banner.recovery] }}
    </UiButton>
    <UiIconButton
      icon="x"
      label="Close"
      size="sm"
      data-testid="studio-keep-error-close"
      @click="emit('close')"
    />
  </span>
  <span
    v-else-if="notice"
    class="status-notice"
    :class="`status-notice--${notice.tone}`"
    role="status"
  >
    <span class="status-notice__text" data-testid="studio-notice">{{ notice.text }}</span>
    <UiButton
      v-if="notice.action"
      size="sm"
      data-testid="studio-notice-action"
      @click="notice.action.run()"
      >{{ notice.action.label }}</UiButton
    >
    <details v-if="notice.detail" class="status-notice__details" data-testid="studio-notice-detail">
      <summary>Details</summary>
      <p>{{ notice.detail }}</p>
    </details>
    <UiIconButton
      icon="x"
      label="Close"
      size="sm"
      data-testid="studio-notice-close"
      @click="emit('dismiss')"
    />
  </span>
</template>

<style scoped>
.status-notice {
  position: relative;
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-width: 24ch;
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  line-height: 1.2;
  white-space: normal;
}
.status-notice__text {
  min-width: 0;
}
.status-notice--warn .status-notice__text {
  color: var(--warn);
}
.status-notice--ok .status-notice__text {
  color: var(--ok);
}
.status-notice--error .status-notice__text {
  color: var(--danger);
}
.status-notice__details {
  flex: none;
}
.status-notice__details summary {
  color: var(--ink-2);
  cursor: pointer;
}
/* Opened, the detail rises above the status line like a menu. */
.status-notice__details[open] p {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  z-index: var(--z-popover);
  width: min(480px, 90vw);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink-2);
  background: var(--surface-1);
  box-shadow: var(--shadow-pop);
  font-family: var(--font-mono);
  white-space: pre-line;
}
</style>
