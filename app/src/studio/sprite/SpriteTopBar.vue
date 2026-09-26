<script setup lang="ts">
import UiChip from "../../ui/UiChip.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import StudioDraftControls, { type DraftStatus } from "../StudioDraftControls.vue";

/**
 * Sprite Studio's top bar: the way back to Create, which VIEW is open, where
 * the game uses it and its loops and cels, then the draft's controls
 * (StudioDraftControls: undo and redo, the changes, Discard and Keep).
 */
defineProps<{
  viewNumber: number;
  description: string;
  usage: string;
  /** Some logic picks views at runtime: the rooms listed may not be all. */
  dynamic: boolean;
  loops: number;
  cels: number;
  status: DraftStatus;
  changes: number;
  canUndo: boolean;
  canRedo: boolean;
  canKeep: boolean;
}>();
const emit = defineEmits<{
  back: [];
  close: [];
  undo: [];
  redo: [];
  keep: [];
  discard: [];
}>();
</script>

<template>
  <header class="sprite-top">
    <div class="sprite-top__crumbs">
      <UiIconButton icon="chevron-left" label="Back to Create" size="sm" @click="emit('back')" />
      <b class="sprite-top__title" data-testid="sprite-title">VIEW {{ viewNumber }}</b>
      <span v-if="description" class="sprite-top__subtitle">{{ description }}</span>
      <UiChip
        data-testid="sprite-usage"
        :title="
          dynamic ? 'Some logic picks views at runtime, so other rooms may use it too.' : undefined
        "
        >{{ usage }}{{ dynamic ? " +" : "" }}</UiChip
      >
      <UiChip data-testid="sprite-counts"
        >{{ loops }} {{ loops === 1 ? "loop" : "loops" }} · {{ cels }}
        {{ cels === 1 ? "cel" : "cels" }}</UiChip
      >
    </div>
    <div class="sprite-top__meta">
      <StudioDraftControls
        :status
        :changes
        :can-undo="canUndo"
        :can-redo="canRedo"
        :can-keep="canKeep"
        @undo="emit('undo')"
        @redo="emit('redo')"
        @keep="emit('keep')"
        @discard="emit('discard')"
        @close="emit('close')"
      />
    </div>
  </header>
</template>

<style scoped>
.sprite-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding: 0 var(--space-4) 0 var(--space-3);
  border-bottom: 1px solid var(--hairline);
}
.sprite-top__crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.sprite-top__crumbs .ui-chip {
  font-family: var(--font-mono);
  white-space: nowrap;
}
.sprite-top__title {
  font-weight: var(--weight-semibold);
  white-space: nowrap;
}
.sprite-top__subtitle {
  overflow: hidden;
  color: var(--ink-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sprite-top__meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
