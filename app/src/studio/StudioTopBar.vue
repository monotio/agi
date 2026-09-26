<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import { PAYLOAD_MAX_BYTES } from "../../../src/container/container.ts";
import { MAX_PAYLOAD_BYTES } from "../../../src/agent/pictureTools.ts";
import { byteMeter, type StudioLens } from "./studioView.ts";
import { changeCount } from "./useStudioDraft.ts";

/** Where the draft stands, for the status chip. */
export type DraftStatus = "view-only" | "clean" | "changed" | "keeping" | "kept" | "reload";

/**
 * Room Studio's top bar: the way back to Create and what is open, the lens
 * switch, and the draft's state: the picture's size against its limits,
 * undo and redo, the number of changes, Discard and Keep.
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
const LENSES = [
  { value: "art", label: "Art", shortcut: "1" },
  { value: "depth", label: "Depth", shortcut: "2" },
  { value: "walk", label: "Walk", shortcut: "3" },
] as const;
const meter = computed(() => byteMeter(bytes, MAX_PAYLOAD_BYTES, PAYLOAD_MAX_BYTES));
const picChip = computed(() => `PIC ${pictureNumber}`);
const STATUS: Record<
  DraftStatus,
  { tone: "neutral" | "action" | "ok" | "warn" | "danger"; text: string }
> = {
  "view-only": { tone: "warn", text: "View only" },
  clean: { tone: "neutral", text: "No changes" },
  changed: { tone: "action", text: "" },
  keeping: { tone: "action", text: "Keeping…" },
  kept: { tone: "ok", text: "Kept" },
  reload: { tone: "danger", text: "Reload to edit" },
};
const chip = computed(() =>
  status === "changed"
    ? { tone: "action" as const, text: changeCount(changes, notesOnly) }
    : STATUS[status],
);
</script>

<template>
  <header class="top-bar">
    <div class="top-bar__crumbs">
      <UiIconButton icon="chevron-left" label="Back to Create" size="sm" @click="emit('back')" />
      <b class="top-bar__title">{{ title }}</b>
      <UiChip v-if="title !== picChip" data-testid="studio-picture">{{ picChip }}</UiChip>
      <span v-if="subtitle" class="top-bar__subtitle">{{ subtitle }}</span>
    </div>
    <UiSegmented v-model="lens" label="Lens" :options="LENSES" />
    <div class="top-bar__meta">
      <UiChip v-if="diagnostics > 0" tone="warn" dot>{{ diagnostics }} annotation issues</UiChip>
      <div
        class="top-bar__meter"
        :class="`is-${meter.tone}`"
        role="meter"
        aria-label="Picture size"
        aria-valuemin="0"
        :aria-valuemax="PAYLOAD_MAX_BYTES"
        :aria-valuenow="bytes"
        :aria-valuetext="`${bytes} bytes. ${meter.note}`"
        :title="meter.note"
        data-testid="studio-bytes"
        :data-tone="meter.tone"
      >
        <span>{{ bytes }} B · {{ commands }} cmds</span>
        <i :style="{ width: `${Math.max(2, meter.fraction * 100)}%` }"></i>
      </div>
      <UiIconButton
        icon="undo"
        label="Undo"
        shortcut="⌘Z"
        size="sm"
        :disabled="!canUndo"
        data-testid="studio-undo"
        @click="emit('undo')"
      />
      <UiIconButton
        icon="redo"
        label="Redo"
        shortcut="⇧⌘Z"
        size="sm"
        :disabled="!canRedo"
        data-testid="studio-redo"
        @click="emit('redo')"
      />
      <UiChip :tone="chip.tone" dot data-testid="studio-draft-status" :data-status="status">
        <UiIcon v-if="status === 'view-only'" name="lock" :size="12" />{{ chip.text }}
      </UiChip>
      <UiButton
        variant="ghost"
        size="sm"
        :disabled="changes === 0 || status === 'keeping'"
        data-testid="studio-discard"
        @click="emit('discard')"
      >
        Discard
      </UiButton>
      <UiButton
        variant="primary"
        size="sm"
        :disabled="!canKeep"
        data-testid="studio-keep"
        @click="emit('keep')"
      >
        Keep<span v-if="changes > 0" class="top-bar__count">{{ changes }}</span>
      </UiButton>
      <UiIconButton
        icon="x"
        label="Close studio"
        shortcut="Esc"
        size="sm"
        data-testid="studio-close"
        @click="emit('close')"
      />
    </div>
  </header>
</template>

<style scoped>
.top-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
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
.top-bar__count {
  margin-left: var(--space-2);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  color: var(--action);
  background: var(--action-ink);
  font: var(--weight-bold) var(--text-2xs) / var(--leading) var(--font-mono);
}
</style>
