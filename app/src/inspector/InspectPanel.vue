<script setup lang="ts">
/**
 * Create mode's Inspect tab: the inspector's controls docked beside the
 * stage. Its marks and point-select work on the centre stage itself
 * (InspectorOverlay), so nothing floats over the game.
 */
import InspectorView from "./InspectorView.vue";
import { useInspector } from "./useInspector.ts";
import { useCreateWorkspace } from "../shell/useCreateWorkspace.ts";

defineProps<{ readOnly: boolean }>();

const { tab } = useInspector();
const { viewOnly } = useCreateWorkspace();
const TABS = ["screen", "state", "timeline"] as const;
</script>

<template>
  <div class="inspect-panel" data-testid="inspect-panel">
    <nav class="inspect-panel__tabs" aria-label="Inspector views">
      <button
        v-for="t in TABS"
        :key="t"
        type="button"
        class="inspect-panel__tab"
        :aria-pressed="tab === t"
        :data-testid="`dbg-tab-${t}`"
        @click="tab = t"
      >
        {{ t }}
      </button>
    </nav>
    <InspectorView :view-only="viewOnly" />
  </div>
</template>

<style scoped>
.inspect-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin: calc(var(--space-5) * -1);
}
.inspect-panel__tabs {
  display: flex;
  gap: var(--space-0);
  margin: var(--space-4) var(--space-4) 0;
  padding: 3px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-lg);
  background: var(--surface-0);
}
.inspect-panel__tab {
  flex: 1;
  min-height: var(--control-h-sm);
  border: 0;
  border-radius: var(--radius);
  color: var(--ink-2);
  background: transparent;
  font: var(--weight-semibold) var(--text-xs) / 1 var(--font-sans);
  text-transform: capitalize;
  cursor: pointer;
}
.inspect-panel__tab[aria-pressed="true"] {
  color: var(--ink);
  background: var(--surface-3);
  box-shadow: inset 0 0 0 1px var(--hairline-strong);
}
</style>
