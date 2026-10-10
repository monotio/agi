<script setup lang="ts">
import type { AgentResult } from "../../../src/agent/chats.ts";
import { documentLabel } from "../../../src/logic/numberedLabels.ts";
import { useProjectLabels } from "../shell/useProjectLabels.ts";
import UiButton from "../ui/UiButton.vue";
const { result } = defineProps<{ result: AgentResult }>();
defineEmits<{ command: [command: string]; resource: [resource: string]; review: [] }>();
const labels = useProjectLabels();
</script>
<template>
  <div class="agent-result" data-testid="agent-result">
    <ul v-if="result.kind === 'commands'" class="agent-result__commands">
      <li v-for="command in result.commands" :key="command">
        <code>{{ command }}</code>
        <UiButton size="sm" variant="ghost" @click="$emit('command', command)"
          >Use command</UiButton
        >
      </li>
    </ul>
    <table v-else-if="result.kind === 'table'">
      <thead>
        <tr>
          <th v-for="(column, index) in result.columns" :key="index">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in result.rows" :key="rowIndex">
          <td v-for="(cell, index) in row" :key="index">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
    <ul v-else-if="result.kind === 'diagnostics'" class="agent-result__findings">
      <li v-for="(item, index) in result.items" :key="index">
        {{ item.message }}
        <UiButton
          v-if="item.resource"
          size="sm"
          variant="ghost"
          @click="$emit('resource', item.resource)"
          >{{ documentLabel(item.resource, labels) }}</UiButton
        >
      </li>
    </ul>
    <div v-else-if="result.kind === 'resources'" class="agent-result__resources">
      <UiButton
        v-for="resource in result.resources"
        :key="resource"
        size="sm"
        variant="ghost"
        @click="$emit('resource', resource)"
        >{{ documentLabel(resource, labels) }}</UiButton
      >
    </div>
    <UiButton
      v-else-if="result.kind === 'changes'"
      size="sm"
      variant="ghost"
      data-testid="agent-view-result"
      @click="$emit('review')"
      >View changes</UiButton
    >
  </div>
</template>
<style scoped>
.agent-result {
  margin-top: var(--space-3);
  overflow-x: auto;
}
.agent-result__commands {
  list-style: none;
  padding: 0;
}
.agent-result__commands li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.agent-result table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-xs);
}
.agent-result th,
.agent-result td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--hairline);
  text-align: left;
}
.agent-result__resources {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.agent-result__findings {
  padding-left: var(--space-4);
}
</style>
