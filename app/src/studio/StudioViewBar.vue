<script setup lang="ts">
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { explain } from "./studioTerms.ts";
import type { StudioLens, StudioViewMode } from "./studioView.ts";

/**
 * The Depth and Walk lenses' view toggles, docked at the right of the
 * options bar: how the planes show (blend, split, depth only) and the band
 * guides. The walk lines' legend is a row of the Walk panel. The Art lens
 * shows only its visual plane and needs none of them. Short of room (`fold`
 * 3 and up) they all fold into one View menu.
 */
const { lens, fold = 0 } = defineProps<{ lens: StudioLens; fold?: number }>();
const mode = defineModel<StudioViewMode>("mode", { required: true });
const bands = defineModel<boolean>("bands", { required: true });

const MODES = [
  { value: "blend", label: "Blend" },
  { value: "split", label: "Split" },
  { value: "priority", label: "Depth only" },
] as const;
</script>

<template>
  <div v-if="lens !== 'art'" class="view-bar" role="toolbar" aria-label="View">
    <ActionMenu v-if="fold >= 3" label="View">
      <button
        v-for="choice in MODES"
        :key="choice.value"
        type="button"
        role="menuitemradio"
        :aria-checked="mode === choice.value"
        @click="mode = choice.value"
      >
        <UiIcon name="check" :size="16" class="view-more__check" />{{ choice.label }}
      </button>
      <div role="separator"></div>
      <button type="button" role="menuitemcheckbox" :aria-checked="bands" @click="bands = !bands">
        <UiIcon name="check" :size="16" class="view-more__check" />Bands
      </button>
    </ActionMenu>
    <UiSegmented v-else v-model="mode" size="sm" label="Planes" :options="MODES" />
    <template v-if="fold < 3">
      <UiButton
        variant="ghost"
        class="view-bar__toggle"
        :aria-pressed="bands"
        @click="bands = !bands"
      >
        Bands
      </UiButton>
      <UiExplain v-bind="explain('bands')" />
    </template>
  </div>
</template>

<style scoped>
.view-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.view-bar :deep(.ui-seg) {
  border: 0;
  background: transparent;
}
.view-bar :deep(.ui-seg__item) {
  min-height: calc(var(--control-h) - 8px);
  font-weight: var(--weight-bold);
}
.view-bar__toggle {
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
}
[aria-checked="false"] > .view-more__check {
  visibility: hidden;
}
.view-bar__toggle[aria-pressed="true"] {
  color: var(--action);
  background: var(--action-soft);
}
</style>
