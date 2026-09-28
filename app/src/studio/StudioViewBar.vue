<script setup lang="ts">
import { ref, watch } from "vue";
import ActionMenu from "../ui/ActionMenu.vue";
import UiButton from "../ui/UiButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { CONTROL_VALUES, patternOn, type StudioLens, type StudioViewMode } from "./studioView.ts";

/**
 * The Depth and Walk lenses' view toggles, docked at the right of the
 * options bar: how the planes show (blend, split, priority only), the band
 * guides, and under the Walk lens a Legend toggle that opens the control
 * lines' legend under the bar, over the stage's corner, until it is put away.
 * The Art lens shows only its visual plane and needs none of them. Short of
 * room (`fold` 3 and up) they all fold into one View menu.
 */
const { lens, fold = 0 } = defineProps<{ lens: StudioLens; fold?: number }>();
const mode = defineModel<StudioViewMode>("mode", { required: true });
const bands = defineModel<boolean>("bands", { required: true });

const MODES = [
  { value: "blend", label: "Blend" },
  { value: "split", label: "Split" },
  { value: "priority", label: "Priority only" },
] as const;

/** The legend is open under the bar. */
const legendOpen = ref(false);
watch(
  () => lens,
  () => (legendOpen.value = false),
);
/** Esc inside the bar puts an open legend away before it reaches the studio. */
function closeLegend(event: KeyboardEvent): void {
  if (!legendOpen.value) return;
  legendOpen.value = false;
  event.stopPropagation();
}
</script>

<template>
  <div
    v-if="lens !== 'art'"
    class="view-bar"
    role="toolbar"
    aria-label="View"
    @keydown.esc="closeLegend"
  >
    <ActionMenu v-if="fold >= 3" label="View" test-id="studio-view-more">
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
      <button
        v-if="lens === 'walk'"
        type="button"
        role="menuitemcheckbox"
        :aria-checked="legendOpen"
        @click="legendOpen = !legendOpen"
      >
        <UiIcon name="check" :size="16" class="view-more__check" />Legend
      </button>
    </ActionMenu>
    <UiSegmented v-else v-model="mode" size="sm" label="Planes" :options="MODES" />
    <UiButton
      v-if="fold < 3"
      variant="ghost"
      class="view-bar__toggle"
      :aria-pressed="bands"
      @click="bands = !bands"
    >
      Bands
    </UiButton>
    <UiButton
      v-if="lens === 'walk' && fold < 3"
      variant="ghost"
      class="view-bar__toggle"
      trailing-icon="chevron-down"
      :aria-pressed="legendOpen"
      aria-controls="studio-control-legend"
      data-testid="studio-legend-toggle"
      @click="legendOpen = !legendOpen"
    >
      Legend
    </UiButton>
    <figure
      v-if="lens === 'walk' && legendOpen"
      id="studio-control-legend"
      class="view-legend"
      data-role="control-legend"
    >
      <figcaption>Control lines</figcaption>
      <div v-for="control in CONTROL_VALUES" :key="control.value" class="view-legend__row">
        <svg viewBox="0 0 8 2" width="32" height="8" aria-hidden="true">
          <rect
            v-for="x in 8"
            :key="x"
            :x="x - 1"
            y="0"
            width="1"
            height="2"
            :style="{
              fill: `var(--agi-${control.colour})`,
              opacity: patternOn(control.pattern, x - 1, 0) ? 1 : 0.45,
            }"
          />
        </svg>
        <span>{{ control.value }} · {{ control.name }}</span>
      </div>
    </figure>
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
/* Opened on purpose, it hangs under the bar's right end like a menu. */
.view-legend {
  position: absolute;
  top: calc(100% + var(--space-2));
  right: 0;
  z-index: var(--z-popover);
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-pop);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.view-legend figcaption {
  color: var(--ink-3);
  font-size: var(--text-2xs);
  font-weight: var(--weight-bold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.view-legend__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--ink-2);
}
</style>
