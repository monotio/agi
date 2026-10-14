<script setup lang="ts">
import { ref, watchEffect } from "vue";
import { createRoomResourceUses, roomsUsingResources } from "../worker/roomChange.ts";
import type { AgentResult } from "../../../src/agent/chats.ts";
import { documentLabel, numberedLabel } from "../../../src/logic/numberedLabels.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useProjectLabels } from "../shell/useProjectLabels.ts";
import UiButton from "../ui/UiButton.vue";
const { result, showRooms = false } = defineProps<{ result: AgentResult; showRooms?: boolean }>();
defineEmits<{
  command: [command: string];
  resource: [resource: string];
  review: [];
  room: [room: number];
}>();
const labels = useProjectLabels();
const engine = useEngineApi();
/** Applied changes to rooms other than the one on screen show once the hero goes there. */
const elsewhere = ref<number[]>([]);
watchEffect(async (onCleanup) => {
  elsewhere.value = [];
  if (!showRooms || result.kind !== "changes" || result.status !== "applied") return;
  const resources = result.resources;
  const rooms = labels.value.rooms?.map((entry) => entry.room) ?? [];
  const currentRoom = engine.currentRoom.value;
  elsewhere.value = roomsUsingResources(resources, rooms, currentRoom, () => []);
  if (!resources.some((key) => /^(picture|view):/.test(key))) return;
  void engine.state.patchTick;
  const scan = engine.roomMap.resources.value;
  const profile = scan.profile;
  let current = true;
  onCleanup(() => {
    current = false;
  });
  if (!profile) return;
  const dependencies = await createRoomResourceUses(new Map(Object.entries(scan.files)), profile);
  if (!current) return;
  elsewhere.value = roomsUsingResources(resources, rooms, currentRoom, dependencies);
});
</script>
<template>
  <div class="agent-result" data-testid="agent-result">
    <ul v-if="result.kind === 'commands'" class="agent-result__commands">
      <!-- The command itself types into the game; no button per command. -->
      <li v-for="command in result.commands" :key="command">
        <button
          type="button"
          class="agent-result__command"
          :aria-label="`Type ${command} into the game`"
          :title="`Type ${command} into the game`"
          @click="$emit('command', command)"
        >
          <code>{{ command }}</code>
        </button>
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
    <template v-else-if="result.kind === 'changes'">
      <UiButton size="sm" variant="ghost" data-testid="agent-view-result" @click="$emit('review')"
        >View changes</UiButton
      >
      <UiButton
        v-for="room in elsewhere"
        :key="room"
        size="sm"
        variant="ghost"
        data-testid="agent-show-room"
        @click="$emit('room', room)"
        >Show {{ numberedLabel("room", room, labels) }}</UiButton
      >
    </template>
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
  gap: var(--space-3);
}
.agent-result__command {
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agent-result__command:hover,
.agent-result__command:focus-visible {
  border-color: var(--focus);
  outline: none;
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
