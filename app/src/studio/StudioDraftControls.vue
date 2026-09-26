<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { changeCount } from "./useStudioDraft.ts";

/** Where the draft stands, for the status chip. */
export type DraftStatus = "view-only" | "clean" | "changed" | "keeping" | "kept" | "reload";

/**
 * The draft's controls at the right of every Studio's top bar: undo and
 * redo, where the draft stands, Discard, Keep with its change count, and
 * the way out.
 */
const {
  status,
  changes,
  notesOnly = false,
  canUndo,
  canRedo,
  canKeep,
} = defineProps<{
  status: DraftStatus;
  changes: number;
  /** The changes touch only notes (labels, kinds, locks), not the resource's bytes. */
  notesOnly?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canKeep: boolean;
}>();
const emit = defineEmits<{ close: []; undo: []; redo: []; keep: []; discard: [] }>();
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
    Keep<span v-if="changes > 0" class="draft-controls__count">{{ changes }}</span>
  </UiButton>
  <UiIconButton
    icon="x"
    label="Close studio"
    shortcut="Esc"
    size="sm"
    data-testid="studio-close"
    @click="emit('close')"
  />
</template>

<style scoped>
.draft-controls__count {
  margin-left: var(--space-2);
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  color: var(--action);
  background: var(--action-ink);
  font: var(--weight-bold) var(--text-2xs) / var(--leading) var(--font-mono);
}
</style>
