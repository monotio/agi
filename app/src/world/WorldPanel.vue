<script setup lang="ts">
/**
 * Create mode's World panel: the world map docked beside the live game. A
 * small graph with real thumbnails, the rooms with their status and the
 * picture each one draws, and a card for the selected room with its plan
 * actions and the Studio entry points: Room Studio on its picture (each of
 * them, when the room overlays one on another), Sprite Studio on each VIEW
 * its logic uses. Unlike the window it never pauses the game; the room →
 * picture facts come from the static scan (roomPictureUse), never from the
 * room number.
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
import { useRoomStudio } from "./useRoomStudio.ts";
import { useSpriteStudio } from "./useSpriteStudio.ts";
import WorldGraph from "./WorldGraph.vue";
import WorldRoomDetail from "./WorldRoomDetail.vue";
import WorldRoomList from "./WorldRoomList.vue";

defineProps<{ readOnly: boolean }>();

const engine = useEngineApi();
const map = engine.roomMap;
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

/** The VIEWs the selected room's logic names (viewUsage.ts), each openable in Sprite Studio. */
const views = computed(() => {
  const node = selectedNode.value;
  return node ? roomViews(map.resources.value, node.room) : [];
});
const sprites = useSpriteStudio();

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
          <ul data-testid="world-room-views">
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
                @click="sprites.open(entry.view)"
              />
            </li>
          </ul>
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
.world-add-room {
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
