<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../ui/UiIcon.vue";
import { lockedPlanes, PLANE_NAMES, type LensUnlocks } from "./studioLocks.ts";
import type { StudioLens } from "./studioView.ts";

/**
 * The Scene footer's lock line: what the lens keeps from changing, with an
 * explicit Unlock (and Lock again) that lasts for this Studio session.
 */
const { lens } = defineProps<{ lens: StudioLens }>();
const unlocks = defineModel<LensUnlocks>("unlocks", { required: true });

const LENS_NAMES: Record<StudioLens, string> = { art: "Art", depth: "Depth", walk: "Walk" };
/** The plane this lens locks. */
const plane = computed(() => (lens === "art" ? "priority" : "visual"));
const locked = computed(() => lockedPlanes(lens, unlocks.value).length > 0);

function toggle(which: keyof LensUnlocks): void {
  unlocks.value = { ...unlocks.value, [which]: !unlocks.value[which] };
}
</script>

<template>
  <div class="lock-note" data-testid="studio-lock-note">
    <p>
      <UiIcon :name="locked ? 'lock' : 'lock-open'" :size="12" />
      <template v-if="locked"
        >{{ PLANE_NAMES[plane] }} is locked in the {{ LENS_NAMES[lens] }} lens.</template
      >
      <template v-else>{{ PLANE_NAMES[plane] }} is unlocked for this session.</template>
      <button type="button" data-testid="studio-unlock" @click="toggle(plane)">
        {{ locked ? "Unlock" : "Lock" }}
      </button>
    </p>
    <p v-if="lens === 'walk'">
      <UiIcon :name="unlocks.depthInWalk ? 'lock-open' : 'lock'" :size="12" />
      Depth values 4–15 {{ unlocks.depthInWalk ? "are allowed" : "are locked" }}.
      <button type="button" data-testid="studio-allow-depth" @click="toggle('depthInWalk')">
        {{ unlocks.depthInWalk ? "Lock" : "Allow" }}
      </button>
    </p>
  </div>
</template>

<style scoped>
.lock-note {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
.lock-note p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--ink-2);
}
.lock-note button {
  padding: 0;
  border: 0;
  color: var(--action);
  background: none;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.lock-note button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
</style>
