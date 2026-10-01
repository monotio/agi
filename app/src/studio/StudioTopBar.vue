<script setup lang="ts">
import { VOCABULARY } from "../../../src/vocabulary.ts";
import { computed } from "vue";
import UiChip from "../ui/UiChip.vue";
import UiExplain from "../ui/UiExplain.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { PAYLOAD_MAX_BYTES } from "../../../src/container/container.ts";
import { MAX_PAYLOAD_BYTES } from "../../../src/agent/pictureTools.ts";
import StudioDraftControls, { type DraftStatus } from "./StudioDraftControls.vue";
import StudioLockChip from "./StudioLockChip.vue";
import type { LensUnlocks } from "./studioLocks.ts";
import { explain } from "./studioTerms.ts";
import { byteMeter, pictureSize, type StudioLens } from "./studioView.ts";

/**
 * Room Studio's top bar: the way back and what is open, the lens tabs with
 * the lock chip beside them (what the lens keeps as it is, and Unlock for
 * now), and the draft's controls (StudioDraftControls: undo and redo, the
 * changes, Discard and Keep). The `share` slot follows what is open. The
 * picture's size lives in the status bar; a byte meter joins the top bar
 * only once the picture nears its limits.
 */
const {
  title,
  pictureNumber,
  subtitle,
  diagnostics,
  bytes,
  commands,
  status,
  changes,
  notesOnly = false,
  canUndo,
  canRedo,
  canKeep,
  lensHeld = null,
} = defineProps<{
  title: string;
  pictureNumber: number;
  subtitle: string;
  diagnostics: number;
  bytes: number;
  commands: number;
  status: DraftStatus;
  changes: number;
  /** The changes touch only notes (labels, kinds, locks), not the picture's bytes. */
  notesOnly?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canKeep: boolean;
  /** Why the lens and its locks cannot change right now; the tabs are off and say so. */
  lensHeld?: string | null;
}>();
const emit = defineEmits<{
  back: [];
  close: [];
  undo: [];
  redo: [];
  keep: [];
  discard: [];
}>();
const lens = defineModel<StudioLens>("lens", { required: true });
const unlocks = defineModel<LensUnlocks>("unlocks", { required: true });
const LENSES = [
  { value: "art", label: VOCABULARY.art.label, shortcut: "1", title: VOCABULARY.art.help },
  { value: "depth", label: VOCABULARY.depth.label, shortcut: "2", title: VOCABULARY.depth.help },
  { value: "walk", label: VOCABULARY.walk.label, shortcut: "3", title: VOCABULARY.walk.help },
] as const;
const lenses = computed(() =>
  LENSES.map((option) => ({
    ...option,
    disabled: !!lensHeld,
    title: lensHeld ?? option.title,
  })),
);
const meter = computed(() => byteMeter(bytes, MAX_PAYLOAD_BYTES, PAYLOAD_MAX_BYTES));
const picChip = computed(() => `PIC ${pictureNumber}`);
const size = computed(() => pictureSize(bytes, commands));
</script>

<template>
  <header class="top-bar">
    <div class="top-bar__crumbs">
      <UiIconButton
        icon="chevron-left"
        label="Back"
        size="sm"
        data-testid="studio-back"
        @click="emit('back')"
      />
      <b class="top-bar__title">{{ title }}</b>
      <UiChip v-if="title !== picChip" data-testid="studio-picture">{{ picChip }}</UiChip>
      <span v-if="subtitle" class="top-bar__subtitle">{{ subtitle }}</span>
      <slot name="share" />
    </div>
    <div class="top-bar__lens">
      <UiSegmented v-model="lens" label="Lens" :options="lenses" data-testid="studio-lens" />
      <StudioLockChip v-model:unlocks="unlocks" class="top-bar__lock" :lens :held="lensHeld" />
    </div>
    <div class="top-bar__meta">
      <UiChip v-if="diagnostics > 0" tone="warn" dot data-testid="studio-issues"
        >{{ diagnostics }} {{ diagnostics === 1 ? "issue" : "issues" }}
        <UiExplain v-bind="explain('issues')"
      /></UiChip>
      <div
        v-if="meter.tone !== 'ok'"
        class="top-bar__meter"
        :class="`is-${meter.tone}`"
        role="meter"
        aria-label="Picture size"
        aria-valuemin="0"
        :aria-valuemax="PAYLOAD_MAX_BYTES"
        :aria-valuenow="bytes"
        :aria-valuetext="`${size.full}. ${meter.note}`"
        :title="`${size.full}. ${meter.note}`"
        data-testid="studio-bytes"
        :data-tone="meter.tone"
      >
        <span>{{ size.bytes }}</span>
        <i :style="{ width: `${Math.max(2, meter.fraction * 100)}%` }"></i>
      </div>
      <StudioDraftControls
        :status
        :changes
        :notes-only="notesOnly"
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
.top-bar {
  display: grid;
  /* The right column never gets less than the draft controls need. */
  grid-template-columns: minmax(0, 1fr) auto minmax(min-content, 1fr);
  align-items: center;
  gap: var(--space-5);
  padding: 0 var(--space-4) 0 var(--space-3);
  border-bottom: 1px solid var(--hairline);
}
.top-bar__crumbs {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.top-bar__title {
  overflow: hidden;
  font-weight: var(--weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top-bar__subtitle {
  overflow: hidden;
  color: var(--ink-3);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top-bar__lens {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.top-bar__meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}

.top-bar__meter {
  position: relative;
  display: grid;
  flex: none;
  gap: var(--space-0);
  padding: var(--space-1) var(--space-3) var(--space-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink-2);
  font: var(--text-2xs) var(--font-mono);
  white-space: nowrap;
}
.top-bar__meter i {
  display: block;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--ok);
}
.top-bar__meter.is-warn {
  border-color: var(--warn-line);
  color: var(--warn);
}
.top-bar__meter.is-warn i {
  background: var(--warn);
}
.top-bar__meter.is-danger {
  border-color: var(--danger-line);
  color: var(--danger);
}
.top-bar__meter.is-danger i {
  background: var(--danger);
}
</style>
