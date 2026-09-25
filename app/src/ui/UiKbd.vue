<template>
  <kbd class="ui-kbd"><slot /></kbd>
</template>

<style scoped>
.ui-kbd {
  display: inline-block;
  min-width: 1.6em;
  padding: 1px var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-2);
  font: var(--text-2xs) / 1.4 var(--font-mono);
  text-align: center;
}
</style>
