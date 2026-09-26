<script setup lang="ts">
import { computed } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

/**
 * The draft's two confirmations: closing Studio with unkept changes offers
 * Keep, Discard or Cancel; Discard alone asks before throwing changes away.
 */
const { pictureNumber, changes, canKeep } = defineProps<{
  pictureNumber: number;
  changes: number;
  canKeep: boolean;
}>();
const emit = defineEmits<{ keep: []; discard: [close: boolean] }>();
const ask = defineModel<"close" | "discard" | undefined>("ask", { default: undefined });
const open = computed({
  get: () => ask.value !== undefined,
  set: (value) => {
    if (!value) ask.value = undefined;
  },
});
const closing = computed(() => ask.value === "close");
const description = computed(() =>
  closing.value
    ? `PIC ${pictureNumber} has ${changes} unkept ${changes === 1 ? "change" : "changes"}.`
    : "The picture goes back to how it was last kept.",
);
</script>

<template>
  <UiDialog
    v-model:open="open"
    size="sm"
    :title="closing ? 'Keep your changes?' : 'Discard your changes?'"
    :description
  >
    <template #footer>
      <UiButton variant="ghost" data-testid="studio-dialog-cancel" @click="ask = undefined">
        Cancel
      </UiButton>
      <UiButton
        variant="danger"
        data-testid="studio-dialog-discard"
        @click="emit('discard', closing)"
      >
        {{ closing ? "Discard" : "Discard changes" }}
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
