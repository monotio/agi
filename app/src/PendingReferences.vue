<script setup lang="ts">
import {
  openReferenceUpload,
  pendingReferences,
  removePendingReference,
} from "./referenceUploadState.ts";
defineProps<{ busy: boolean; room: number; allowAttach: boolean }>();
</script>

<template>
  <div
    v-if="allowAttach || pendingReferences.length"
    class="agent-pending-references"
    aria-label="References for next message"
  >
    <button
      v-if="allowAttach"
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="agent-attach-reference"
      title="Attach reference art for the agent"
      :disabled="busy"
      @click="openReferenceUpload(room || undefined)"
    >
      Art
    </button>
    <div
      v-if="pendingReferences.length"
      class="agent-pending-selection"
      data-testid="agent-pending-references"
    >
      <span>Next message:</span>
      <button
        v-for="reference in pendingReferences"
        :key="reference.id"
        type="button"
        class="ui-button ui-button--secondary"
        :aria-label="`Remove ${reference.label} from next message`"
        :disabled="busy"
        @click="removePendingReference(reference.id)"
      >
        {{ reference.label }} ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.agent-pending-references,
.agent-pending-selection {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  margin-block: 0.5rem;
  max-height: 8rem;
  overflow-y: auto;
}
.agent-pending-references button {
  max-width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}
</style>
