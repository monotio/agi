<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import UiIcon from "../ui/UiIcon.vue";
import { depthValuesLocked, lockedPlanes, type LensUnlocks } from "./studioLocks.ts";
import { explain, type StudioTerm } from "./studioTerms.ts";
import type { StudioLens } from "./studioView.ts";

/**
 * What the lens keeps from changing, as one chip: "Depth & walk lines" in
 * the Art lens (both live on AGI's priority plane), "Art" in the Depth lens,
 * "Art & depth" in the Walk lens, each with a lock. The locks guard painting
 * within those planes; moving a whole item takes all of them along. Its ⓘ says why in one sentence and holds the way out: Unlock for now
 * (Unlock art and Allow depth in the Walk lens), which lasts for this Studio
 * session, and Lock again. It sits beside the lens tabs and again in Ask's scope row,
 * where the same locks hold the AI. In a narrow top bar (under 960 px) the
 * chip shows its lock and ⓘ alone; its words stay for screen readers.
 */
const { lens, held = null } = defineProps<{
  lens: StudioLens;
  /** Why the locks cannot change right now; the actions are off and say so. */
  held?: string | null;
}>();
const unlocks = defineModel<LensUnlocks>("unlocks", { required: true });

const TERMS: Record<StudioLens, StudioTerm> = {
  art: "lens-lock-depth",
  depth: "lens-lock-art",
  walk: "lens-lock-walk",
};
/** The plane this lens locks. */
const plane = computed(() => (lens === "art" ? "priority" : "visual"));
const planeLocked = computed(() => lockedPlanes(lens, unlocks.value).length > 0);
const depthLocked = computed(() => depthValuesLocked(lens, unlocks.value));
const locked = computed(() => planeLocked.value || depthLocked.value);
const text = computed(() => {
  const name = plane.value === "priority" ? "Depth & walk lines" : "Art";
  if (lens !== "walk") return planeLocked.value ? name : `${name} unlocked`;
  if (planeLocked.value && depthLocked.value) return "Art & depth";
  return planeLocked.value ? "Art" : depthLocked.value ? "Depth" : "Unlocked";
});

function toggle(which: keyof LensUnlocks, close: () => void): void {
  unlocks.value = { ...unlocks.value, [which]: !unlocks.value[which] };
  close();
}
</script>

<template>
  <span
    class="lock-chip"
    :class="{ 'is-locked': locked }"
    :title="locked ? `${text} locked` : text"
    data-testid="studio-lock-chip"
    :data-locked="locked"
  >
    <UiIcon :name="locked ? 'lock' : 'lock-open'" :size="12" />
    <span class="lock-chip__text">{{ text }}</span>
    <UiExplain v-bind="explain(TERMS[lens])">
      <template #action="{ close }">
        <UiButton
          size="sm"
          data-testid="studio-unlock"
          :disabled="!!held"
          :title="held ?? undefined"
          @click="toggle(plane, close)"
        >
          {{
            lens === "walk"
              ? planeLocked
                ? "Unlock art"
                : "Lock art"
              : planeLocked
                ? "Unlock"
                : "Lock again"
          }}
        </UiButton>
        <UiButton
          v-if="lens === 'walk'"
          size="sm"
          data-testid="studio-allow-depth"
          :disabled="!!held"
          :title="held ?? undefined"
          @click="toggle('depthInWalk', close)"
        >
          {{ depthLocked ? "Allow depth" : "Lock depth" }}
        </UiButton>
      </template>
    </UiExplain>
  </span>
</template>

<style scoped>
.lock-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  min-height: 24px;
  padding: 0 var(--space-1) 0 var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-2);
  background: var(--surface-2);
  font: var(--weight-medium) var(--text-xs) / 1.4 var(--font-sans);
  white-space: nowrap;
}
.lock-chip.is-locked {
  border-color: var(--warn-line);
  color: var(--warn);
  background: var(--warn-soft);
}
.lock-chip.is-locked :deep(.ui-explain) {
  color: var(--warn);
}
@media (max-width: 960px) {
  .lock-chip {
    padding-left: var(--space-2);
  }
  .lock-chip__text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
}
</style>
