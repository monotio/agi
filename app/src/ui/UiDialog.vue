<script setup lang="ts">
import { nextTick, useTemplateRef, watch } from "vue";
import UiIconButton from "./UiIconButton.vue";

/**
 * A native modal <dialog> on the top layer, so nothing can render behind a
 * parent modal. Esc and the close button set `open` to false; focus returns
 * to whatever had it before opening, unless `restoreFocus` is false and the
 * `closed` listener hands it on (the game's input, say). It arrives with the
 * motion recipe's dialog entrance (motion.css). The `actions` slot puts
 * controls in the header, before the close button; `flush` drops the body
 * padding for panes that draw their own.
 */
const {
  description = undefined,
  size = "md",
  closeTestid = undefined,
  closeLabel = "Close",
  restoreFocus = true,
  flush = false,
} = defineProps<{
  title: string;
  description?: string | undefined;
  size?: "sm" | "md" | "lg";
  closeTestid?: string | undefined;
  closeLabel?: string;
  restoreFocus?: boolean;
  flush?: boolean;
}>();
const emit = defineEmits<{ closed: [] }>();
const open = defineModel<boolean>("open", { required: true });
const dialog = useTemplateRef("dialog");
let returnFocus: HTMLElement | null = null;

watch(
  open,
  async (value) => {
    await nextTick();
    const element = dialog.value;
    if (!element) return;
    if (value && !element.open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!value && element.open) {
      element.close();
    }
  },
  { immediate: true },
);

function onClose(): void {
  open.value = false;
  if (restoreFocus) returnFocus?.focus({ preventScroll: true });
  returnFocus = null;
  emit("closed");
}
</script>

<template>
  <dialog
    ref="dialog"
    class="ui-dialog"
    :class="[`ui-dialog--${size}`]"
    :aria-label="title"
    @close="onClose"
    @cancel.prevent="open = false"
  >
    <header class="ui-dialog__head">
      <div class="ui-dialog__heading">
        <h2 class="ui-dialog__title">{{ title }}</h2>
        <p v-if="description" class="ui-dialog__desc">{{ description }}</p>
      </div>
      <div v-if="$slots['actions']" class="ui-dialog__actions"><slot name="actions" /></div>
      <UiIconButton
        icon="x"
        :label="closeLabel"
        size="sm"
        :data-testid="closeTestid"
        @click="open = false"
      />
    </header>
    <div class="ui-dialog__body" :class="{ 'ui-dialog__body--flush': flush }"><slot /></div>
    <footer v-if="$slots['footer']" class="ui-dialog__foot"><slot name="footer" /></footer>
  </dialog>
</template>

<style scoped>
.ui-dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: min(85dvh, 900px);
  padding: 0;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  box-shadow: var(--shadow-dialog);
  font: var(--text-md) / var(--leading) var(--font-sans);
}
.ui-dialog[open] {
  display: flex;
  flex-direction: column;
}
.ui-dialog--sm {
  width: min(420px, calc(100vw - 32px));
}
.ui-dialog--lg {
  width: min(880px, calc(100vw - 32px));
}
.ui-dialog::backdrop {
  background: var(--scrim);
}
.ui-dialog__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5) var(--space-4) var(--space-3) var(--space-6);
}
.ui-dialog__heading {
  min-width: 0;
}
.ui-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}
.ui-dialog__title {
  margin: 0;
  font: var(--weight-semibold) var(--text-xl) / var(--leading-tight) var(--font-sans);
}
.ui-dialog__desc {
  margin: var(--space-1) 0 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.ui-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-3) var(--space-6) var(--space-6);
}
.ui-dialog__body--flush {
  padding: 0;
}
.ui-dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--hairline);
}
</style>
