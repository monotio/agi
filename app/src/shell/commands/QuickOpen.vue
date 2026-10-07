<script setup lang="ts">
import { computed, ref, watch } from "vue";
import KeyboardChooser from "./KeyboardChooser.vue";
import { commandItems, type PartsProvider } from "./chooserItems.ts";
import type { CommandContext, CommandRegistry } from "./commandRegistry.ts";
const props = defineProps<{
  provider: PartsProvider;
  registry: CommandRegistry;
  context: CommandContext;
}>();
const open = defineModel<boolean>("open", { required: true });
const commands = ref(false);
watch(open, () => {
  commands.value = false;
});
const items = computed(() =>
  commands.value ? commandItems(props.registry, props.context) : props.provider(),
);
</script>
<template>
  <KeyboardChooser
    v-model:open="open"
    :title="commands ? 'Command palette' : 'Quick open'"
    placeholder="Find a part, or type > for commands"
    :items="items"
    command-prefix
    @mode="commands = $event"
  />
</template>
