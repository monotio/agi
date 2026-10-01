<script setup lang="ts">
import { computed } from "vue";
import KeyboardChooser from "./KeyboardChooser.vue";
import { commandItems } from "./chooserItems.ts";
import type { CommandContext, CommandRegistry } from "./commandRegistry.ts";
const props = defineProps<{ registry: CommandRegistry; context: CommandContext }>();
const open = defineModel<boolean>("open", { required: true });
const items = computed(() => commandItems(props.registry, props.context));
</script>
<template>
  <KeyboardChooser
    v-model:open="open"
    title="Command palette"
    placeholder="Type a command"
    :items="items"
  />
</template>
