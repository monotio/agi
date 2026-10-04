<script setup lang="ts">
import { VOCABULARY_ACTIONS } from "../../../../src/vocabulary.ts";
import { SOUND_PRESETS } from "../../../../src/sound/presets.ts";
import { ref, watch } from "vue";
import type { WorkspaceAction } from "./workspaceGuided.ts";
import ActionMenu from "../../ui/ActionMenu.vue";
import UiButton from "../../ui/UiButton.vue";
const props = defineProps<{ room: number; busy: boolean; initialCommand?: string }>();
const emit = defineEmits<{ add: [action: WorkspaceAction] }>();
const kind = defineModel<WorkspaceAction["kind"] | undefined>("action");
const title = ref("");
const command = ref(props.initialCommand ?? "");
watch(
  () => props.initialCommand,
  (value) => {
    command.value = value ?? "";
  },
);
const response = ref("");
const view = ref(0);
const sound = ref(1);
const soundPreset = ref("");
const destination = ref(2);
const x = ref(80);
const y = ref(140);
const x2 = ref(100);
const y2 = ref(150);
const labels: Record<WorkspaceAction["kind"], string> = {
  "add-room": "Add a room",
  "place-hero": "Place hero",
  response: "Response",
  door: "Door",
  "play-sound": VOCABULARY_ACTIONS.play_sound.label,
};
function open(next: WorkspaceAction["kind"]): void {
  kind.value = next;
}
function add(): void {
  const room = props.room;
  switch (kind.value) {
    case "add-room":
      emit("add", { kind: kind.value, title: title.value });
      break;
    case "place-hero":
      emit("add", { kind: kind.value, room, view: view.value, x: x.value, y: y.value });
      break;
    case "response":
      emit("add", { kind: kind.value, room, command: command.value, response: response.value });
      break;
    case "door":
      emit("add", {
        kind: kind.value,
        room,
        destination: destination.value,
        x1: x.value,
        y1: y.value,
        x2: x2.value,
        y2: y2.value,
      });
      break;
    case "play-sound":
      emit("add", {
        kind: kind.value,
        room,
        sound: sound.value,
        command: command.value,
        ...(soundPreset.value ? { preset: soundPreset.value } : {}),
      });
      break;
  }
}
</script>
<template>
  <div class="workspace-guided">
    <ActionMenu label="+ Add" size="sm" test-id="workspace-add">
      <button
        v-for="(label, action) in labels"
        :key="action"
        type="button"
        role="menuitem"
        @click="open(action)"
      >
        {{ label }}
      </button>
    </ActionMenu>
    <form
      v-if="kind"
      class="workspace-guided__form"
      data-testid="workspace-guided-form"
      @submit.prevent="add"
      @keydown.esc.stop="kind = undefined"
    >
      <strong>{{ labels[kind] }}</strong>
      <label v-if="kind === 'add-room'">Room name<input v-model="title" autofocus /></label>
      <template v-if="kind === 'response' || kind === 'play-sound'">
        <label>Command<input v-model="command" required /></label>
        <label v-if="kind === 'response'">Response<input v-model="response" required /></label>
      </template>
      <label v-if="kind === 'place-hero'"
        >VIEW<input v-model.number="view" type="number" min="0" max="255"
      /></label>
      <label v-if="kind === 'play-sound'"
        >Start from<select v-model="soundPreset" aria-label="Sound preset">
          <option value="">Existing SOUND</option>
          <option v-for="preset in SOUND_PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.name }}
          </option>
        </select></label
      >
      <label v-if="kind === 'play-sound' && !soundPreset"
        >SOUND<input v-model.number="sound" type="number" min="0" max="255"
      /></label>
      <label v-if="kind === 'door'"
        >Destination ROOM<input v-model.number="destination" type="number" min="1" max="254"
      /></label>
      <template v-if="kind === 'door' || kind === 'place-hero'">
        <label>X<input v-model.number="x" type="number" min="0" max="159" /></label>
        <label>Y<input v-model.number="y" type="number" min="0" max="167" /></label>
      </template>
      <template v-if="kind === 'door'">
        <label>Right<input v-model.number="x2" type="number" min="0" max="159" /></label>
        <label>Bottom<input v-model.number="y2" type="number" min="0" max="167" /></label>
      </template>
      <UiButton size="sm" type="submit" :disabled="busy">Add</UiButton>
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
</style>
