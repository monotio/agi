<script setup lang="ts">
/**
 * The stage's note that storage moved past the running game — another tab
 * kept an edit or asked the assistant — shown once per stale event while the
 * Assistant (which says the same) may be closed. Never modal: the player can
 * keep playing; nothing writes the game's files until it reloads.
 */
import UiButton from "./ui/UiButton.vue";
import UiToast from "./ui/UiToast.vue";
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
  <UiToast
    v-if="state.staleTab && state.phase === 'running'"
    tone="warn"
    dismissible
    data-testid="stale-tab-note"
    @dismiss="state.staleTab = false"
  >
    This game changed in another tab. Reload game to continue from the saved version.
    <UiButton size="sm" data-testid="stale-tab-reload" @click="reload">Reload game</UiButton>
  </UiToast>
</template>
