<script setup lang="ts">
/**
 * Create mode's World panel: the world map docked beside the live game. A
 * small graph with real thumbnails, the rooms with their status and the
 * picture each one draws, and a card for the selected room with its plan
 * actions and the Studio entry points. Unlike the window it never pauses the
 * game; the room → picture facts come from the static scan
 * (roomPictureUse), never from the room number.
 */
import { computed, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import { useEngineApi } from "../engineContext.ts";
import { useCreateWorkspace, type StudioRequest } from "../shell/useCreateWorkspace.ts";
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { roomPictureLabels } from "./roomPictureLabels.ts";
import WorldGraph from "./WorldGraph.vue";
import WorldRoomDetail from "./WorldRoomDetail.vue";
import WorldRoomList from "./WorldRoomList.vue";

defineProps<{ readOnly: boolean }>();

const map = useEngineApi().roomMap;
const workspace = useCreateWorkspace();
const viewOnly = workspace.viewOnly;
const graphView = useTemplateRef("graphView");

// The dock is a creator surface: plan intent and technical status show. The
// window sets its own experience whenever it opens.
onMounted(() => {
  if (!map.open.value) map.experience.value = "create";
});
onUnmounted(() => {
  if (!map.open.value) map.experience.value = "play";
});

const selectedNode = computed(
  () => map.graph.value.nodes.find((n) => n.room === map.selected.value) ?? null,
);
// Nothing picked yet: the card describes the room the game is in.
watch(
  () => map.currentRoom.value,
  (room) => {
    if (map.selected.value === undefined && room !== null && room > 0) map.select(room);
  },
  { immediate: true },
);

const pictures = computed(() => {
  const node = selectedNode.value;
  if (!node) return null;
  const scan = map.resources.value;
  const use = roomPictureUse(node.room, {
    scans: scan.scans,
    shared: scan.shared,
    pictures: scan.picture,
  });
  return roomPictureLabels(use, node.planned);
});

const studioOpen = computed(() => workspace.studio.value !== null);
const studioFits = workspace.studioFits;
const STUDIO_TOO_SMALL = "Room Studio needs a larger screen";

function pickRoom(room: number): void {
  graphView.value?.selectRoom(room, true);
}

function addStandaloneRoom(): void {
  const result = map.addPlannedRoom(null, "New room", "", "");
  if (result.room !== undefined) pickRoom(result.room);
}

/** Studio's request for one room's picture, read from the running game each time it is asked. */
function studioRequest(room: number, title: string, picture: number): StudioRequest | null {
  const source = map.studioSource(picture);
  if (!source) return null;
  return {
    room,
    pictureNumber: picture,
    ...source,
    // A picture can serve several rooms: an untitled room is named by what Studio edits.
    title: title || `PIC ${picture}`,
    subtitle: `Room ${room} · PIC ${picture}`,
    reload: () => studioRequest(room, title, picture),
  };
}

function openInStudio(): void {
  const node = selectedNode.value;
  const picture = pictures.value?.studioPicture;
  if (!node || picture === undefined) return;
  const request = studioRequest(node.room, node.title ?? "", picture);
  if (request) workspace.openStudio(request);
}
</script>

<template>
  <div class="world-panel" data-testid="world-panel">
    <p v-if="map.storageError.value" class="world-alert" role="alert" data-testid="map-error">
      {{ map.storageError.value }}
    </p>
    <p v-if="map.unsaved.value" class="world-alert" data-testid="map-unsaved">
      Map data is not saved — retrying in the background.
      <UiButton size="sm" variant="ghost" @click="map.retrySave()">Retry now</UiButton>
    </p>
    <p
      v-if="map.canPlan.value && (map.planDirty.value || map.planSaveError.value)"
      class="world-alert"
      role="alert"
      data-testid="map-plan-unsaved"
    >
      {{ map.planSaveError.value || "The plan has unsaved edits." }}
      <UiButton size="sm" variant="ghost" data-testid="map-plan-retry" @click="map.retryPlanSave()">
        Retry
      </UiButton>
    </p>
    <WorldGraph ref="graphView" compact />
    <WorldRoomList compact @pick="pickRoom" />
    <UiButton
      v-if="map.canPlan.value && !viewOnly"
      icon="plus"
      size="sm"
      variant="ghost"
      class="world-add-room"
      data-testid="map-add-room"
      @click="addStandaloneRoom"
    >
      Add a room
    </UiButton>
    <WorldRoomDetail v-if="selectedNode" :node="selectedNode" compact :view-only="viewOnly">
      <template #lead>
        <p v-if="pictures" class="world-pictures" data-testid="world-room-pictures">
          <UiChip :tone="pictures.tone">{{ pictures.chip }}</UiChip>
          <span>{{ pictures.detail }}</span>
        </p>
        <div class="world-actions">
          <span :title="studioFits ? undefined : STUDIO_TOO_SMALL">
            <UiButton
              variant="primary"
              size="sm"
              icon="pencil"
              data-testid="world-open-studio"
              :disabled="pictures?.studioPicture === undefined || studioOpen || !studioFits"
              :aria-describedby="
                !studioFits
                  ? 'world-studio-small'
                  : pictures?.studioBlocked
                    ? 'world-studio-blocked'
                    : undefined
              "
              @click="openInStudio"
            >
              Open in Studio
            </UiButton>
          </span>
          <span title="Coming in a later update">
            <UiButton
              size="sm"
              icon="play"
              disabled
              aria-description="Coming in a later update"
              data-testid="world-play-here"
            >
              Play here
            </UiButton>
          </span>
        </div>
        <p
          v-if="!studioFits"
          id="world-studio-small"
          class="world-blocked"
          data-testid="world-studio-small"
        >
          {{ STUDIO_TOO_SMALL }}
        </p>
        <p
          v-else-if="!viewOnly && pictures?.studioBlocked"
          id="world-studio-blocked"
          class="world-blocked"
          data-testid="world-studio-blocked"
        >
          {{ pictures.studioBlocked }}
        </p>
      </template>
    </WorldRoomDetail>
  </div>
</template>

<style scoped>
.world-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.world-alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--danger);
  font-size: var(--text-xs);
}
.world-add-room {
  align-self: flex-start;
}
.world-pictures {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-xs);
}
.world-pictures .ui-chip {
  font-family: var(--font-mono);
}
.world-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.world-blocked {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
