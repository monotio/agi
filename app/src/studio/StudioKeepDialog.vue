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
const { pictureNumber, changes, canKeep } = defineProps<{
  pictureNumber: number;
  changes: number;
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
  close: "Keep your changes?",
  reload: "Reload the saved game?",
  discard: "Discard your changes?",
} as const;
const DISCARD_LABELS = { close: "Discard", reload: "Reload", discard: "Discard changes" } as const;
const description = computed(() =>
  ask.value === "close"
    ? `PIC ${pictureNumber} has ${changes} unkept ${changes === 1 ? "change" : "changes"}.`
    : ask.value === "reload"
      ? "Your unkept changes in this picture will be discarded because the game was changed elsewhere."
      : "The picture goes back to how it was last kept.",
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
        data-testid="studio-dialog-keep"
        @click="emit('keep')"
      >
        Keep
      </UiButton>
    </template>
  </UiDialog>
</template>
