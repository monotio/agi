<script setup lang="ts">
/**
 * Create mode's World panel: the world map docked beside the live game. A
 * small graph with real thumbnails over either the rooms, with their status
 * and the picture each one draws, or the selected room's card: its plan
 * actions and the Studio entry points, Room Studio on its picture (each of
 * them, when the room overlays one on another) and Sprite Studio on each VIEW
 * its logic uses. Picking a room drills into its card; "All rooms" returns.
 * Unlike the window it never pauses the game; the room → picture facts come
 * from the static scan (roomPictureUse), never from the room number.
 */
import { computed, onMounted, onUnmounted, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiChip from "../ui/UiChip.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { useEngineApi } from "../engine/engineContext.ts";
import { useCreateWorkspace } from "../shell/useCreateWorkspace.ts";
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { roomPictureLabels } from "./roomPictureLabels.ts";
import { roomViews } from "./studioSource.ts";
import { useRoomDrill } from "./useRoomDrill.ts";
import { useRoomStudio } from "./useRoomStudio.ts";
import { useSpriteStudio } from "./useSpriteStudio.ts";
import WorldGraph from "./WorldGraph.vue";
import WorldRoomDetail from "./WorldRoomDetail.vue";
import WorldRoomList from "./WorldRoomList.vue";

const engine = useEngineApi();
const map = engine.roomMap;
const workspace = useCreateWorkspace();
const viewOnly = workspace.viewOnly;
const graphView = useTemplateRef("graphView");
const panelEl = useTemplateRef("panelEl");
const detailView = useTemplateRef("detailView");

// The dock is a creator surface: plan intent and technical status show. The
// window sets its own experience whenever it opens.
onMounted(() => {
  if (!map.open.value) map.experience.value = "create";
});
onUnmounted(() => {
  if (!map.open.value) map.experience.value = "play";
});
// Expand opens the window over the dock; the window can switch to the
// discovered map, so the dock takes its own view back when it closes.
watch(
  () => map.open.value,
  (open) => {
    if (!open) map.experience.value = "create";
  },
);

// While the selection follows the player (entering Create, or picking the
// room marked "you are here"), the card moves with each room they walk into.
watch(
  () => [map.currentRoom.value, map.followsPlayer.value] as const,
  ([room, follows]) => {
    if (follows && room !== null && room > 0 && map.selected.value !== room) map.select(room);
  },
  { immediate: true },
);

const { selectedNode, pickFromList, showAllRooms, onDetailKeydown } = useRoomDrill({
  map,
  root: panelEl,
  detail: detailView,
  pick: pickRoom,
});

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

/** The VIEWs the selected room's logic names (viewUsage.ts), each openable in Sprite Studio. */
const views = computed(() => {
  const node = selectedNode.value;
  return node ? roomViews(map.resources.value, node.room) : [];
});
const sprites = useSpriteStudio();

const studioOpen = computed(() => workspace.studio.value !== null);
const studioFits = workspace.studioFits;
const STUDIO_TOO_SMALL = "Room Studio needs a larger screen";
const STUDIO_OPEN = "A Studio is already open";

function pickRoom(room: number): void {
  graphView.value?.selectRoom(room, true);
}

function addStandaloneRoom(): void {
  const result = map.addPlannedRoom(null, "New room", "", "");
  if (result.room !== undefined) pickFromList(result.room);
}

const rooms = useRoomStudio();

/** Room Studio's entry points for the selected room: one per picture it draws. */
const studioPictures = computed(() => pictures.value?.studioPictures ?? []);

function openInStudio(picture: number): void {
  const node = selectedNode.value;
  if (!node) return;
  const request = rooms.request(node.room, node.title ?? "", picture);
  if (request) workspace.openStudio(request);
}
</script>

<template>
  <div ref="panelEl" class="world-panel" data-testid="world-panel">
    <p v-if="map.storageError.value" class="world-alert" role="alert" data-testid="map-error">
      {{ map.storageError.value }}
    </p>
    <p v-if="map.unsaved.value" class="world-alert" data-testid="map-unsaved">
      Map data is not saved yet. Retrying in the background.
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
    <div v-show="!selectedNode" class="world-rooms">
      <WorldRoomList compact @pick="pickFromList" />
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
    </div>
    <UiButton
      v-if="selectedNode"
      icon="chevron-left"
      size="sm"
      variant="ghost"
      class="world-back"
      data-testid="world-all-rooms"
      @click="showAllRooms"
    >
      All rooms
    </UiButton>
    <WorldRoomDetail
      v-if="selectedNode"
      ref="detailView"
      :node="selectedNode"
      compact
      :view-only="viewOnly"
      @keydown="onDetailKeydown"
    >
      <template #chips>
        <UiChip v-if="pictures" class="world-chip" :tone="pictures.tone">{{
          pictures.chip
        }}</UiChip>
        <UiChip v-for="entry in views" :key="entry.view" class="world-chip"
          >VIEW {{ entry.view }}</UiChip
        >
      </template>
      <template #lead>
        <p
          v-if="pictures && pictures.detail !== pictures.chip"
          class="world-pictures"
          data-testid="world-room-pictures"
        >
          {{ pictures.detail }}
        </p>
        <div class="world-actions">
          <span class="world-actions__primary" :title="studioFits ? undefined : STUDIO_TOO_SMALL">
            <UiButton
              variant="primary"
              size="sm"
              icon="pencil"
              block
              data-testid="world-open-studio"
              :data-picture="studioPictures[0]"
              :disabled="studioPictures.length === 0 || studioOpen || !studioFits"
              :aria-describedby="
                !studioFits
                  ? 'world-studio-small'
                  : pictures?.studioBlocked
                    ? 'world-studio-blocked'
                    : undefined
              "
              @click="openInStudio(studioPictures[0]!)"
            >
              {{ studioPictures.length > 1 ? `Open PIC ${studioPictures[0]}` : "Open in Studio" }}
            </UiButton>
          </span>
          <span
            v-if="studioPictures.length > 1"
            class="world-actions__more"
            role="group"
            aria-label="Open another picture in Room Studio"
          >
            <UiButton
              v-for="picture in studioPictures.slice(1)"
              :key="picture"
              size="sm"
              icon="pencil"
              :data-testid="`world-open-studio-${picture}`"
              :data-picture="picture"
              :disabled="studioOpen || !studioFits"
              :title="studioOpen ? STUDIO_OPEN : undefined"
              :aria-describedby="studioFits ? undefined : 'world-studio-small'"
              @click="openInStudio(picture)"
            >
              Open PIC {{ picture }}
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
        <section v-if="views.length" class="world-views" aria-label="Sprites this room uses">
          <h4>Sprites</h4>
          <ul>
            <li v-for="entry in views" :key="entry.view" :data-view="entry.view">
              <span class="world-views__name">
                <b>VIEW {{ entry.view }}</b>
                <span v-if="entry.description">{{ entry.description }}</span>
              </span>
              <UiIconButton
                icon="pencil"
                size="sm"
                :label="`Open VIEW ${entry.view} in Sprite Studio`"
                :data-testid="`world-open-sprite-${entry.view}`"
                :disabled="studioOpen || !studioFits"
                :aria-describedby="studioFits ? undefined : 'world-sprites-small'"
                @click="sprites.open(entry.view)"
              />
            </li>
          </ul>
          <p v-if="!studioFits" id="world-sprites-small" class="world-blocked">
            Sprite Studio needs a larger screen
          </p>
        </section>
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
.world-rooms {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.world-add-room,
.world-back {
  align-self: flex-start;
}
.world-chip {
  font-family: var(--font-mono);
}
.world-pictures {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
.world-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
}
.world-actions__primary {
  display: block;
}
.world-actions__more {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.world-views {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-1);
}
.world-views h4 {
  margin: var(--space-2) 0 0;
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.world-views ul {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin: 0;
  padding: 0;
  list-style: none;
}
.world-views li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--text-xs);
}
.world-views__name {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
  color: var(--ink-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.world-views__name b {
  color: var(--ink);
  font-family: var(--font-mono);
}
.world-blocked {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-xs);
}
</style>
