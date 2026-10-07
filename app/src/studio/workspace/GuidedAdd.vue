<script setup lang="ts">
import { roomHeroView } from "../logic/guided/guidedPreview.ts";
import { computed, onBeforeUnmount, onWatcherCleanup, ref, useTemplateRef, watch } from "vue";
import { prepareWorkspaceAction, type WorkspaceAction } from "./workspaceGuided.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { PROFILES, type ProfileId } from "../../../../src/runtime/profile.ts";
import { parseWordsTok } from "../../../../src/logic/words.ts";
import { openSprite } from "../../../../src/view/spriteDocument.ts";
import { openContainer } from "../../../../src/container/container.ts";
import { createPictureSurface } from "../../../../src/types.ts";
import { renderPicture } from "../../../../src/picture/renderer.ts";
import { EGA_RGB } from "../../../../src/picture/png.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { guidedPlacement, type GuidedPlacement } from "../../play/guidedPlacement.ts";
import type { WorkspacePartGroup } from "../host/workspaceParts.ts";
import ViewThumbnail from "./ViewThumbnail.vue";
import SoundPicker, { type SoundChoice, type NamedSound } from "./SoundPicker.vue";
import SentenceFields from "./SentenceFields.vue";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{
  room: number;
  busy: boolean;
  initialCommand?: string;
  snapshot: ProjectSnapshot;
  profileId: ProfileId;
  groups: readonly WorkspacePartGroup[];
  thumbnails: Readonly<Record<string, string>>;
  views: Readonly<Record<string, Uint8Array>>;
  sounds: readonly NamedSound[];
}>();
const emit = defineEmits<{ add: [action: WorkspaceAction] }>();
const kind = defineModel<WorkspaceAction["kind"] | undefined>("action");
const form = useTemplateRef("form");
const formHeight = ref<string>();
watch(
  form,
  (element) => {
    if (!element) return;
    const target = element;
    function fit(): void {
      if (!target.offsetParent) return;
      const top = target.getBoundingClientRect().top;
      formHeight.value = `${Math.max(0, window.innerHeight - top - 8)}px`;
    }
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    const frame = element.closest(".workspace-editor");
    if (frame) observer.observe(frame);
    if (element.offsetParent) observer.observe(element.offsetParent);
    window.addEventListener("resize", fit);
    fit();
    onWatcherCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    });
  },
  { flush: "post" },
);
const command = ref(props.initialCommand ?? "");
watch(
  () => props.initialCommand,
  (value) => {
    command.value = value ?? "";
  },
);
const response = ref("");
const alsoCommands = ref<readonly string[]>([]);
const engine = useEngineApi();
const editor = useWorkspaceEditor();
const placing = ref(false);
const positionPicked = ref(false);
const boxPicked = ref(false);
const arrival = ref<{ x: number; y: number }>();
const notice = ref("");
const soundChoice = ref<SoundChoice>({ sound: 1 });
const view = ref(0);
const sound = ref(1);
const destination = ref<number>();
const x = ref(80);
const y = ref(140);
const doorX = ref(80);
const doorY = ref(140);
const x2 = ref(100);
const y2 = ref(150);
type RoomActionKind = "place-hero" | "response" | "door" | "play-sound";
const labels: Record<RoomActionKind, string> = {
  "place-hero": "Place hero",
  response: "Answer a sentence",
  door: "Door",
  "play-sound": "Sound when…",
};
const roomActionKind = computed<RoomActionKind | undefined>(() =>
  kind.value !== undefined && kind.value in labels ? (kind.value as RoomActionKind) : undefined,
);
watch(kind, (next) => {
  if (next !== undefined && next in labels) open(next as RoomActionKind);
});
const rooms = computed(
  () =>
    props.groups
      .find((group) => group.label === "ROOMS")
      ?.entries.filter((row) => !row.child && row.room !== props.room) ?? [],
);
const roomImages = computed(() => {
  const images = { ...props.thumbnails };
  const container = props.snapshot.lastAdmissibleBuild
    ? openContainer(props.snapshot.lastAdmissibleBuild.files(), {
        profile: PROFILES[props.profileId],
      })
    : undefined;
  const rows = props.groups.find((group) => group.label === "ROOMS")?.entries ?? [];
  for (const row of rows.filter((row) => !row.child)) {
    if (images[row.id]) continue;
    const picture = rows.find(
      (child) => child.room === row.room && child.key.startsWith("picture:"),
    );
    const payload = picture
      ? container?.getResource("picture", Number(picture.key.split(":")[1]))
      : undefined;
    const surface = createPictureSurface();
    if (payload) renderPicture(payload, surface, { profile: PROFILES[props.profileId] });
    else surface.visual.fill(0);
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 168;
    const image = new ImageData(160, 168);
    for (let index = 0; index < surface.visual.length; index++) {
      const rgb = EGA_RGB[surface.visual[index]! & 15]!;
      image.data.set([...rgb, 255], index * 4);
    }
    canvas.getContext("2d")!.putImageData(image, 0, 0);
    images[row.id] = canvas.toDataURL("image/png");
  }
  return images;
});
const viewChoices = computed(
  () => props.groups.find((group) => group.label === "VIEWS")?.entries ?? [],
);
const action = computed<WorkspaceAction | undefined>(() => {
  const room = props.room;
  switch (kind.value) {
    case "place-hero":
      return { kind: kind.value, room, view: view.value, x: x.value, y: y.value };
    case "response":
      return {
        kind: kind.value,
        room,
        command: command.value,
        response: response.value || "Your answer.",
        alsoCommands: alsoCommands.value,
      };
    case "door":
      return {
        kind: kind.value,
        room,
        destination: destination.value ?? 0,
        x1: doorX.value,
        y1: doorY.value,
        x2: x2.value,
        y2: y2.value,
        ...(arrival.value ? { arrival: arrival.value } : {}),
      };
    case "play-sound":
      return {
        kind: kind.value,
        room,
        sound: soundChoice.value.sound ?? sound.value,
        command: command.value,
        ...(soundChoice.value.preset ? { preset: soundChoice.value.preset } : {}),
      };
    default:
      return undefined;
  }
});
const prepared = computed(() => {
  if (!action.value) return undefined;
  try {
    return prepareWorkspaceAction(props.snapshot, props.profileId, action.value);
  } catch {
    return { ok: false as const, message: "Check Problems before adding this action." };
  }
});
const words = computed(() => {
  const value = prepared.value;
  const content =
    (value?.ok ? value.changes.find((change) => change.key === "words")?.content : undefined) ??
    props.snapshot.read("words")?.content;
  return typeof content === "string"
    ? (JSON.parse(content) as [string, number][])
    : content instanceof Uint8Array
      ? parseWordsTok(content).map(({ word, id }) => [word, id] as [string, number])
      : [];
});
const showPreview = computed(() =>
  kind.value === "place-hero" || kind.value === "door" || kind.value === "add-room"
    ? true
    : !!command.value && (kind.value === "play-sound" || !!response.value),
);
watch(soundChoice, (choice) => {
  if (choice.sound !== undefined) sound.value = choice.sound;
});
function open(next: WorkspaceAction["kind"]): void {
  x.value = doorX.value = 80;
  y.value = doorY.value = 140;
  x2.value = 100;
  y2.value = 150;
  destination.value = undefined;
  const source = props.snapshot.read(`logic:${props.room}`)?.content;
  const bindings = props.snapshot.read("bindings")?.content;
  view.value =
    typeof source === "string"
      ? (roomHeroView(source, typeof bindings === "string" ? bindings : undefined) ?? 0)
      : 0;
  guidedPlacement.value?.cancel();
  guidedPlacement.value = undefined;
  kind.value = next;
  notice.value = "";
  positionPicked.value = false;
  boxPicked.value = false;
  arrival.value = undefined;
  alsoCommands.value = [];
  // A door starts on the game: drag the box where the hero leaves.
  if (next === "door") place("box");
}
async function startHere(): Promise<void> {
  const state = await engine.readEngineState();
  if (!state || state.room !== props.room) {
    notice.value = "Visit this room in the game, then press Start here.";
    return;
  }
  x.value = state.egoX;
  y.value = state.egoY;
  positionPicked.value = true;
  notice.value = "Start position selected.";
}
function place(target: "hero" | "box" | "arrival"): void {
  const wasFocused = editor.focus.value;
  const wasPlaytesting = editor.phonePlaytest.value;
  editor.focus.value = false;
  editor.phonePlaytest.value = true;
  editor.partsOpen.value = false;
  placing.value = true;
  let cel;
  try {
    const sprite = openSprite(props.views[`view:${view.value}`]!, PROFILES[props.profileId]);
    cel = (sprite.loops[2] ?? sprite.loops[0])?.cels[0];
  } catch {
    /* A position marker works before the first VIEW is drawn. */
  }
  function close(): void {
    placing.value = false;
    editor.focus.value = wasFocused;
    editor.phonePlaytest.value = wasPlaytesting;
  }
  guidedPlacement.value = {
    kind: target === "box" ? "box" : "hero",
    x: arrival.value?.x ?? x.value,
    y: arrival.value?.y ?? y.value,
    box: { x1: doorX.value, y1: doorY.value, x2: x2.value, y2: y2.value },
    cel,
    background:
      roomImages.value[target === "arrival" ? `room:${destination.value}` : `room:${props.room}`],
    label:
      target === "box"
        ? "Drag a box where the hero leaves"
        : target === "arrival"
          ? "Place the hero in the destination"
          : "Drag the hero to the start",
    done(value: GuidedPlacement) {
      if (target === "arrival") arrival.value = { x: value.x, y: value.y };
      else if (target === "hero") {
        x.value = value.x;
        y.value = value.y;
        positionPicked.value = true;
      } else {
        doorX.value = value.box.x1;
        doorY.value = value.box.y1;
        x2.value = value.box.x2;
        y2.value = value.box.y2;
        boxPicked.value = true;
      }
      close();
    },
    cancel: close,
  };
}
onBeforeUnmount(() => {
  if (placing.value) {
    guidedPlacement.value?.cancel();
    guidedPlacement.value = undefined;
  }
});
const doorReady = computed(
  () =>
    kind.value !== "door" ||
    (boxPicked.value &&
      typeof destination.value === "number" &&
      Number.isInteger(destination.value) &&
      destination.value >= 1 &&
      destination.value <= 254 &&
      destination.value !== props.room),
);
/** Validation answers after input: a door checks only once box and room are chosen. */
const inputComplete = computed(() =>
  kind.value === "door" ? boxPicked.value && destination.value !== undefined : showPreview.value,
);
function add(): void {
  if (action.value && !props.busy && doorReady.value) emit("add", action.value);
}
const narrowQuery = window.matchMedia("(max-width: 600px)");
const narrow = ref(narrowQuery.matches);
narrowQuery.addEventListener("change", (event) => (narrow.value = event.matches));
</script>
<template>
  <div class="workspace-guided">
    <ActionMenu v-if="narrow" label="Room actions" size="sm" test-id="room-actions-menu">
      <button
        v-for="(label, actionKind) in labels"
        :key="actionKind"
        type="button"
        role="menuitem"
        :data-testid="`room-action-${actionKind}`"
        @click="kind = actionKind as RoomActionKind"
      >
        {{ label }}
      </button>
    </ActionMenu>
    <div v-else class="workspace-guided__actions" role="group" aria-label="Room actions">
      <UiButton
        v-for="(label, actionKind) in labels"
        :key="actionKind"
        size="sm"
        variant="ghost"
        :disabled="busy"
        :data-testid="`room-action-${actionKind}`"
        @click="kind = actionKind as RoomActionKind"
        >{{ label }}</UiButton
      >
    </div>
    <form
      v-if="roomActionKind"
      v-show="!placing"
      ref="form"
      class="workspace-guided__form"
      :style="{ maxHeight: formHeight }"
      data-testid="workspace-guided-form"
      @submit.prevent="add"
      @keydown.esc.stop="kind = undefined"
    >
      <strong>{{ labels[roomActionKind] }}</strong>
      <SentenceFields
        v-if="kind === 'response' || kind === 'play-sound'"
        v-model:command="command"
        v-model:response="response"
        v-model:also="alsoCommands"
        :words
        :reply="kind === 'response'"
        :disabled="busy"
      />
      <template v-if="kind === 'place-hero'">
        <p>Walk the hero to a spot in the game.</p>
        <UiButton size="sm" :disabled="busy" @click="startHere">Start here</UiButton>
        <UiButton size="sm" variant="ghost" :disabled="busy" @click="place('hero')"
          >Drag to place</UiButton
        >
        <p v-if="positionPicked">Start position selected.</p>
        <div class="guided-choices" role="group" aria-label="Pick a VIEW">
          <button
            v-for="entry in viewChoices"
            :key="entry.key"
            type="button"
            :aria-pressed="view === Number(entry.key.split(':')[1])"
            :disabled="busy"
            @click="view = Number(entry.key.split(':')[1])"
          >
            <ViewThumbnail
              v-if="views[entry.key]"
              :bytes="views[entry.key]!"
              :profile="PROFILES[profileId]"
            />{{ entry.label }}
          </button>
        </div>
      </template>
      <SoundPicker
        v-if="kind === 'play-sound'"
        v-model="soundChoice"
        :sounds
        :profile-id
        :disabled="busy"
      />
      <template v-if="kind === 'door'">
        <p>When the hero walks into this box, go to…</p>
        <UiButton size="sm" :disabled="busy" @click="place('box')">{{
          boxPicked ? "Draw the box again" : "Drag the box on the game"
        }}</UiButton>
        <div class="guided-choices" role="group" aria-label="Destination room">
          <button
            v-for="entry in rooms"
            :key="entry.id"
            type="button"
            :aria-pressed="destination === entry.room"
            :disabled="busy"
            @click="
              destination = entry.room!;
              arrival = undefined;
            "
          >
            <img v-if="roomImages[entry.id]" :src="roomImages[entry.id]" alt="" />{{ entry.label }}
          </button>
        </div>
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="busy || !rooms.some((row) => row.room === destination)"
          @click="place('arrival')"
          >and arrive here</UiButton
        >
        <p v-if="arrival">
          The hero arrives at your chosen spot.
          <UiButton size="sm" variant="ghost" @click="arrival = undefined"
            >Use the room’s start</UiButton
          >
        </p>
      </template>
      <details v-if="kind === 'door' || kind === 'place-hero' || kind === 'play-sound'">
        <summary>Exact numbers</summary>
        <label v-if="kind === 'place-hero'"
          >VIEW<input v-model.number="view" type="number" min="0" max="255"
        /></label>
        <label v-if="kind === 'play-sound'"
          >SOUND<input
            v-model.number="sound"
            type="number"
            min="0"
            max="255"
            @input="soundChoice = { sound }"
        /></label>
        <label v-if="kind === 'door'"
          >Destination ROOM<input v-model.number="destination" type="number" min="1" max="254"
        /></label>
        <template v-if="kind === 'place-hero'">
          <label>X<input v-model.number="x" type="number" min="0" max="159" /></label>
          <label>Y<input v-model.number="y" type="number" min="0" max="167" /></label>
        </template>
        <template v-if="kind === 'door'">
          <label
            >X<input
              v-model.number="doorX"
              type="number"
              min="0"
              max="159"
              @input="boxPicked = true"
          /></label>
          <label
            >Y<input
              v-model.number="doorY"
              type="number"
              min="0"
              max="167"
              @input="boxPicked = true"
          /></label>
        </template>
        <template v-if="kind === 'door'">
          <label
            >Right<input
              v-model.number="x2"
              type="number"
              min="0"
              max="159"
              @input="boxPicked = true"
          /></label>
          <label
            >Bottom<input
              v-model.number="y2"
              type="number"
              min="0"
              max="167"
              @input="boxPicked = true"
          /></label>
        </template>
        <label v-if="arrival"
          >Arrival X<input v-model.number="arrival.x" type="number" min="0" max="159"
        /></label>
        <label v-if="arrival"
          >Arrival Y<input v-model.number="arrival.y" type="number" min="0" max="167"
        /></label>
      </details>
      <p v-if="notice" role="status">{{ notice }}</p>
      <template v-if="prepared">
        <details v-if="prepared.ok && showPreview" class="guided-code">
          <summary>Show code</summary>
          <pre data-testid="guided-code-preview">{{
            prepared.showCode.map((preview) => preview.text).join("\n")
          }}</pre>
        </details>
        <p v-else-if="!prepared.ok && inputComplete" role="status">{{ prepared.message }}</p>
      </template>
      <p v-if="kind === 'door' && destination === room" role="status">
        Choose another room for this door.
      </p>
      <UiButton size="sm" type="submit" :disabled="busy || !doorReady">Add</UiButton>
      <UiButton size="sm" variant="ghost" @click="kind = undefined">Cancel</UiButton>
    </form>
  </div>
</template>

<style scoped>
select {
  width: 100%;
  padding: var(--space-2);
  color: var(--ink);
  background: var(--surface-0);
  border: 1px solid var(--hairline);
  font: inherit;
}
.workspace-guided__form {
  width: min(340px, calc(100vw - var(--space-8)));
  max-height: calc(100dvh - 160px);
  box-sizing: border-box;
  overflow: auto;
  border-radius: var(--radius-lg);
}
.workspace-guided__form p {
  font-size: var(--text-sm);
  color: var(--ink-2);
}
.guided-choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: var(--space-3) 0;
}
.guided-choices button {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface-1);
  color: var(--ink);
  font: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}
.guided-choices button[aria-pressed="true"] {
  border-color: var(--action);
  background: var(--action-soft);
}
.guided-choices img {
  width: 100%;
  aspect-ratio: 40 / 21;
  image-rendering: pixelated;
}
.guided-code {
  margin: var(--space-3) 0;
}
pre {
  overflow: auto;
  max-height: 160px;
  font: var(--text-xs) var(--font-mono);
  color: var(--ink);
}
summary {
  cursor: pointer;
  font-size: var(--text-sm);
  color: var(--ink-2);
}
</style>
