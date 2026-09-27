<script setup lang="ts">
/**
 * Remove game's preview: removing a stored game deletes its body, history,
 * saves, map and checkpoint in one step, so the card asks first, names what
 * is lost, and offers the Download game action before it. Cancel has focus.
 */
import UiButton from "../ui/UiButton.vue";
import UiDialog from "../ui/UiDialog.vue";

const { title, downloadDisabled = false } = defineProps<{
  title: string;
  downloadDisabled?: boolean;
}>();
const emit = defineEmits<{ download: []; remove: [] }>();
const open = defineModel<boolean>("open", { required: true });
</script>

<template>
  <UiDialog
    v-model:open="open"
    :title="`Remove ${title}?`"
    size="sm"
    data-testid="remove-game-dialog"
  >
    <p class="remove-game__copy">
      <strong>{{ title }}</strong> will be removed from this browser with its saves, history, notes
      and any changes you made. This cannot be undone.
    </p>
    <p class="remove-game__copy">Games you downloaded as files are not affected.</p>
    <template #footer>
      <UiButton autofocus data-testid="remove-game-cancel" @click="open = false">Cancel</UiButton>
      <UiButton
        variant="ghost"
        icon="download"
        data-testid="remove-game-download"
        :disabled="downloadDisabled"
        @click="emit('download')"
      >
        Download game first
      </UiButton>
      <UiButton variant="danger" data-testid="remove-game-confirm" @click="emit('remove')">
        Remove
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.remove-game__copy {
  margin: 0 0 var(--space-4);
  color: var(--ink-2);
}
.remove-game__copy:last-child {
  margin-bottom: 0;
}
</style>
