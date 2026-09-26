<script setup lang="ts">
/**
 * The room list: a listbox over the graph's nodes with roving selection on
 * ArrowUp/ArrowDown. The window shows each room's evidence badges; the
 * World panel's compact rows show a status (visited, built or planned) and
 * a chip with the picture the room's logic draws.
 */
import { computed, useTemplateRef } from "vue";
import UiChip from "../ui/UiChip.vue";
import { useEngineApi } from "../engineContext.ts";
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { roomPictureLabels, type RoomPictureLabels } from "./roomPictureLabels.ts";
import type { RoomGraphNode } from "../../../src/agent/roomMap.ts";

const { compact = false } = defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ pick: [room: number] }>();

const map = useEngineApi().roomMap;
const { selected } = map;
const nodes = computed(() => map.graph.value.nodes);
const currentRoom = computed(() => map.currentRoom.value);
const listEl = useTemplateRef("listEl");

function badges(n: RoomGraphNode): string {
  const out: string[] = [];
  if (n.observed) out.push("visited");
  if (n.referenced) out.push("named by a stored test");
  if (n.playtested) out.push("playtested");
  if (n.planned) out.push("planned");
  if (n.authored) out.push("logic");
  if (n.picture) out.push("picture");
  if (n.staticTarget) out.push("named in logic");
  if (n.variableExit) out.push("computed exit");
  return out.join(" · ");
}

/** Compact rows: one status word, then how the room connects. */
function status(n: RoomGraphNode, exits: number): string {
  const word = n.observed
    ? "visited"
    : n.authored
      ? "built"
      : n.planned
        ? "planned · not built"
        : "named in logic";
  return exits ? `${word} · ${exits} exit${exits === 1 ? "" : "s"}` : word;
}

const rows = computed(() => {
  const edges = map.graph.value.edges;
  const scan = compact ? map.resources.value : null;
  return nodes.value.map((node) => {
    const exits = new Set(edges.filter((e) => e.from === node.room).map((e) => e.to)).size;
    const pictures: RoomPictureLabels | null = scan
      ? roomPictureLabels(
          roomPictureUse(node.room, {
            scans: scan.scans,
            shared: scan.shared,
            pictures: scan.picture,
          }),
          node.planned,
        )
      : null;
    return { node, meta: compact ? status(node, exits) : badges(node), pictures };
  });
});

function onListKeydown(ev: KeyboardEvent): void {
  const list = nodes.value;
  if (!list.length) return;
  const at = list.findIndex((n) => n.room === selected.value);
  let next: number;
  if (ev.key === "ArrowDown") next = at < 0 ? 0 : Math.min(list.length - 1, at + 1);
  else if (ev.key === "ArrowUp") next = at < 0 ? 0 : Math.max(0, at - 1);
  else return;
  ev.preventDefault();
  const room = list[next]!.room;
  emit("pick", room);
  listEl.value?.querySelector(`[data-room="${room}"]`)?.scrollIntoView({ block: "nearest" });
}
</script>

<template>
  <ul
    ref="listEl"
    class="map-list"
    :class="{ compact }"
    role="listbox"
    aria-label="Rooms"
    data-testid="map-room-list"
    tabindex="0"
    @keydown="onListKeydown"
  >
    <li
      v-for="{ node, meta, pictures } in rows"
      :key="node.room"
      role="option"
      :aria-selected="selected === node.room"
      :data-room="node.room"
      class="map-list-item"
      :class="{ selected: selected === node.room, current: currentRoom === node.room }"
      :data-testid="`map-room-${node.room}`"
    >
      <button type="button" class="map-list-button" @click="emit('pick', node.room)">
        <span class="map-room-name">
          <template v-if="currentRoom === node.room">▶ </template>
          <template v-if="compact && node.title">{{ node.room }} · {{ node.title }}</template>
          <template v-else
            >Room {{ node.room
            }}<template v-if="node.title"> — {{ node.title }}</template></template
          >
        </span>
        <span class="map-room-badges">{{ meta }}</span>
        <UiChip
          v-if="pictures"
          class="map-room-pic"
          :tone="pictures.tone"
          :dot="pictures.tone === 'warn'"
          :title="pictures.detail"
          :data-testid="`map-room-pic-${node.room}`"
          >{{ pictures.chip }}</UiChip
        >
      </button>
    </li>
  </ul>
</template>

<style scoped>
.map-list {
  margin: 0;
  padding: var(--space-2);
  list-style: none;
}
.map-list-item {
  margin: 0;
}
.map-list-button {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius);
  color: inherit;
  background: none;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}
.map-list-button:hover {
  background: var(--surface-2);
}
.map-list-item.selected .map-list-button {
  background: var(--action-soft);
  box-shadow: inset 2px 0 var(--action);
}
.map-list-item.current .map-room-name {
  color: var(--ok);
}
.map-room-name {
  font-weight: var(--weight-semibold);
}
.map-room-badges {
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
/* Compact rows: name and status stacked, the picture chip at the right. */
.compact {
  padding: var(--space-1) 0;
}
.compact .map-list-button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: var(--space-3);
  row-gap: var(--space-0);
}
.compact .map-room-name,
.compact .map-room-badges {
  grid-column: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.map-room-pic {
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
  font-family: var(--font-mono);
}
</style>
