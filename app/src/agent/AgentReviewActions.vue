<script setup lang="ts">
import UiButton from "../ui/UiButton.vue";
const { creating, disabled, stale } = defineProps<{
  creating: boolean;
  disabled: boolean;
  stale: boolean;
}>();
defineEmits<{ apply: []; reject: []; create: [] }>();
</script>
<template>
  <div class="agent-panel__review-actions" role="group" aria-label="Review changes">
    <UiButton
      v-if="creating"
      size="sm"
      variant="primary"
      :disabled="disabled || stale"
      data-testid="agent-approve"
      @click="$emit('apply')"
      >Apply <kbd>⌘↵</kbd></UiButton
    >
    <UiButton v-else size="sm" variant="primary" @click="$emit('create')"
      >Continue in Create</UiButton
    >
    <UiButton
      v-if="creating"
      size="sm"
      variant="ghost"
      :disabled
      data-testid="agent-reject"
      @click="$emit('reject')"
      >Reject</UiButton
    >
  </div>
</template>
