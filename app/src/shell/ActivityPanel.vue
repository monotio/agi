<script setup lang="ts">
/** Create mode's Activity tab: developer activity, docked open. */
import AgentLogPanel from "../AgentLogPanel.vue";

defineProps<{ readOnly: boolean }>();
</script>

<template>
  <AgentLogPanel docked />
</template>
