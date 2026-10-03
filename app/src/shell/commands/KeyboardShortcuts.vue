<script setup lang="ts">
import UiKbd from "../../ui/UiKbd.vue";
import { keyLabel } from "../../ui/keyLabel.ts";
import type { CommandRegistry } from "./commandRegistry.ts";
defineProps<{ registry: CommandRegistry }>();
</script>
<template>
  <section class="keyboard-shortcuts" aria-label="Keyboard shortcuts">
    <h3>Keyboard shortcuts</h3>
    <table>
      <thead>
        <tr>
          <th scope="col">Command</th>
          <th scope="col">Keys</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="command in registry.commands.value" :key="command.id">
          <th scope="row">
            {{ command.category ? `${command.category}: ` : "" }}{{ command.title
            }}<span v-if="!command.run"> · Unavailable</span>
          </th>
          <td>
            <UiKbd v-for="binding in command.keys" :key="binding.key">{{
              keyLabel(binding.key)
            }}</UiKbd>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
<style scoped>
.keyboard-shortcuts table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}
.keyboard-shortcuts th,
.keyboard-shortcuts td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--hairline);
  text-align: left;
}
.keyboard-shortcuts tbody th {
  font-weight: 400;
}
.keyboard-shortcuts td {
  white-space: nowrap;
}
.keyboard-shortcuts span {
  color: var(--ink-3);
}
</style>
