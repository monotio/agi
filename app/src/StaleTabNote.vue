<script setup lang="ts">
/**
 * The stage's note that storage moved past the running game — another tab
 * kept an edit or asked the assistant — shown once per stale event while the
 * Assistant (which says the same) may be closed. Never modal: the player can
 * keep playing; nothing writes the game's files until it reloads.
 */
import UiButton from "./ui/UiButton.vue";
import { useEngineApi } from "./engineContext.ts";

const engine = useEngineApi();
const { state } = engine;

async function reload(): Promise<void> {
  state.staleTab = false;
  state.powerUp.offerReload = false;
  await engine.reloadFromStorage();
}
</script>

<template>
  <p
    v-if="state.staleTab && state.phase === 'running'"
    class="stale-tab-note"
    role="status"
    data-testid="stale-tab-note"
  >
    This game changed in another tab. Reload game to continue from the saved version.
    <UiButton size="sm" data-testid="stale-tab-reload" @click="reload">Reload game</UiButton>
    <button
      type="button"
      class="stale-tab-note__dismiss"
      aria-label="Dismiss"
      @click="state.staleTab = false"
    >
      ×
    </button>
  </p>
</template>

<style scoped>
/* The stage's notice look, as the Play-here note wears it. */
.stale-tab-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  max-width: calc(var(--space-9) * 10);
  margin: var(--space-2) 0 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warn-line);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-overlay);
  font-size: var(--text-sm);
}
.stale-tab-note__dismiss {
  border: 0;
  color: var(--ink-2);
  background: none;
  font: inherit;
  cursor: pointer;
}
</style>
