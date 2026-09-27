<script setup lang="ts">
/** Create mode's Activity tab: developer activity, docked open. */
import AgentLogPanel from "../authoring/AgentLogPanel.vue";

defineProps<{ readOnly: boolean }>();
</script>

<template>
  <AgentLogPanel />
</template>
