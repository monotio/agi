<script setup lang="ts">
import { ref, useId } from "vue";
import UiIcon from "./UiIcon.vue";

/**
 * One "Details ▸" row that folds a panel's expert parts away: a full-width
 * button (its label, then a quiet hint of what is inside) and the content
 * under it while open. Closed by default. With `storageKey`, whether it is
 * open is remembered per viewer under that key (a JSON object of `id` to
 * true), and every storage access is guarded: a private window or blocked
 * storage just starts closed.
 */
const {
  id,
  label = "Details",
  hint = "",
  storageKey = undefined,
  testId = "details",
} = defineProps<{
  /** This disclosure's name in the remembered state. */
  id: string;
  label?: string;
  /** What is inside, in a few words: "Steps · Pixel · Colours". */
  hint?: string;
  storageKey?: string | undefined;
  /** The toggle's test id; the body's is `{testId}-body`. */
  testId?: string;
}>();

function remembered(): Record<string, boolean> {
  if (!storageKey) return {};
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

const open = ref(remembered()[id] === true);
const bodyId = useId();

function toggle(): void {
  open.value = !open.value;
  remember();
}
/** Open it, as the viewer would: a "Choose another…" that leads into Details. */
function show(): void {
  if (open.value) return;
  open.value = true;
  remember();
}
function remember(): void {
  if (!storageKey) return;
  try {
    globalThis.localStorage?.setItem(
      storageKey,
      JSON.stringify({ ...remembered(), [id]: open.value }),
    );
  } catch {
    // Blocked storage: the choice lasts while the panel is open.
  }
}
defineExpose({ show });
</script>

<template>
  <section class="ui-disclosure" :class="{ 'is-open': open }">
    <button
      type="button"
      class="ui-disclosure__toggle"
      :aria-expanded="open"
      :aria-controls="bodyId"
      :data-testid="testId"
      @click="toggle"
    >
      <UiIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" />
      <b class="ui-disclosure__label">{{ label }}</b>
      <span v-if="hint && !open" class="ui-disclosure__hint">{{ hint }}</span>
    </button>
    <div v-if="open" :id="bodyId" class="ui-disclosure__body" :data-testid="`${testId}-body`">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.ui-disclosure {
  border-bottom: 1px solid var(--hairline);
}
.ui-disclosure__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  min-height: var(--control-h);
  padding: 0 var(--space-5);
  border: 0;
  color: var(--ink-2);
  background: transparent;
  font: var(--text-sm) var(--font-sans);
  text-align: left;
  cursor: pointer;
}
.ui-disclosure__toggle:hover {
  color: var(--ink);
  background: var(--surface-2);
}
.ui-disclosure__toggle:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.ui-disclosure__toggle :deep(svg) {
  color: var(--ink-3);
}
.ui-disclosure__label {
  font-weight: var(--weight-semibold);
}
.ui-disclosure__hint {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (pointer: coarse) {
  .ui-disclosure__toggle {
    min-height: var(--control-h-touch);
  }
}
</style>
