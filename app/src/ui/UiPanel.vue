<script setup lang="ts">
/**
 * A titled region of the workspace (scene list, inspector, map). The header
 * holds a small caps title and optional actions; the body scrolls on its own.
 */
const { title = undefined, flush = false } = defineProps<{
  title?: string | undefined;
  /** Remove body padding for lists that draw their own rows. */
  flush?: boolean;
}>();
</script>

<template>
  <section class="ui-panel" :aria-label="title">
    <header v-if="title || $slots['actions']" class="ui-panel__head">
      <h2 v-if="title" class="ui-panel__title">{{ title }}</h2>
      <div class="ui-panel__actions"><slot name="actions" /></div>
    </header>
    <div class="ui-panel__body" :class="[{ 'ui-panel__body--flush': flush }]"><slot /></div>
    <footer v-if="$slots['footer']" class="ui-panel__foot"><slot name="footer" /></footer>
  </section>
</template>

<style scoped>
.ui-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface-1);
}
.ui-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 40px;
  padding: 0 var(--space-3) 0 var(--space-5);
}
.ui-panel__title {
  margin: 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.ui-panel__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.ui-panel__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--space-5) var(--space-5);
}
.ui-panel__body--flush {
  padding: 0;
}
.ui-panel__foot {
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--hairline);
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
