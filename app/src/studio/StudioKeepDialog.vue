<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

/**
 * The draft's confirmations: closing Studio with unkept changes offers Keep,
 * Discard or Cancel; Discard alone asks before throwing changes away; a
 * reload of a game changed elsewhere offers Reload or Cancel, since the
 * draft was made on bytes storage no longer holds.
 */
const {
  subject,
  noun,
  changes,
  notesOnly = false,
  canKeep,
} = defineProps<{
  /** What the draft edits, as the top bar names it: "PIC 5", "VIEW 0". */
  subject: string;
  /** The kind of resource: "picture", "view". */
  noun: string;
  changes: number;
  /** The changes touch only notes (labels, kinds, locks), not the picture's bytes. */
  notesOnly?: boolean;
  canKeep: boolean;
}>();
/** `discard` answers the open question when true, the top bar's Discard when false. */
const emit = defineEmits<{ keep: []; discard: [answer: boolean] }>();
const ask = defineModel<"close" | "reload" | "discard" | undefined>("ask", {
  default: undefined,
});
const open = computed({
  get: () => ask.value !== undefined,
  set: (value) => {
    if (!value) ask.value = undefined;
  },
});
const closing = computed(() => ask.value === "close");
const TITLES = {
  close: "Save your changes?",
  reload: "Reload the saved game?",
  discard: "Discard your changes?",
} as const;
const DISCARD_LABELS = { close: "Discard", reload: "Reload", discard: "Discard changes" } as const;
const description = computed(() =>
  ask.value === "close"
    ? `${subject} has ${changes} unkept ${notesOnly ? "note " : ""}${changes === 1 ? "change" : "changes"}.`
    : ask.value === "reload"
      ? `Your unkept changes in this ${noun} will be discarded because the game was changed elsewhere.`
      : `The ${noun} goes back to how it was last kept.`,
);
</script>

<template>
  <UiDialog v-model:open="open" size="sm" :title="TITLES[ask ?? 'discard']" :description>
    <template #footer>
      <UiButton variant="ghost" data-testid="studio-dialog-cancel" @click="ask = undefined">
        Cancel
      </UiButton>
      <UiButton
        variant="danger"
        :data-testid="ask === 'reload' ? 'studio-dialog-reload' : 'studio-dialog-discard'"
        @click="emit('discard', ask !== 'discard')"
      >
        {{ DISCARD_LABELS[ask ?? "discard"] }}
      </UiButton>
      <UiButton
        v-if="closing"
        variant="primary"
        :disabled="!canKeep"
        :title="canKeep ? undefined : 'Save waits for a reload or the Save in progress'"
        data-testid="studio-dialog-keep"
        @click="emit('keep')"
      >
        Save
      </UiButton>
    </template>
  </UiDialog>
</template>
