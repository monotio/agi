<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from "vue";
import type { ProfileId } from "../../src/runtime/profile.ts";
import {
  PROFILE_GROUPS,
  formatProfileResolution,
  type ProfileChoiceState,
} from "./profileChoice.ts";

/**
 * A native modal dialog: focus moves inside, Escape closes it, and the page
 * behind stays inert until the player saves or keeps the current profile.
 */
const { choice } = defineProps<{ choice: ProfileChoiceState }>();
const emit = defineEmits<{
  save: [profile: ProfileId | undefined];
  close: [];
}>();

const dialog = useTemplateRef("dialog");
// "" is Automatic. Import preselects the detected profile, which automatic also runs.
const selected = ref<string>(
  choice.override ?? (choice.mode === "import" ? (choice.detected ?? "") : ""),
);
let settled = false;

const current = computed(() =>
  choice.override
    ? formatProfileResolution(choice.override, "override")
    : choice.detected && choice.kind
      ? formatProfileResolution(choice.detected, choice.kind, choice.build)
      : "Automatic (opening not checked)",
);

onMounted(() => dialog.value?.showModal());

function save(): void {
  settled = true;
  emit("save", selected.value === "" ? undefined : (selected.value as ProfileId));
}

function dismiss(): void {
  dialog.value?.close();
}

function onDialogClose(): void {
  if (settled) return;
  settled = true;
  emit("close");
}
</script>

<template>
  <dialog
    ref="dialog"
    class="profile-picker-dialog"
    data-testid="profile-picker-dialog"
    aria-labelledby="profile-picker-title"
    @close="onDialogClose"
  >
    <form method="dialog" @submit.prevent="save">
      <header>
        <h2 id="profile-picker-title">
          {{ choice.mode === "import" ? "Choose an interpreter for" : "Interpreter for" }}
          <q>{{ choice.title }}</q>
        </h2>
        <button
          type="button"
          class="ui-button ui-button--secondary ui-button--icon dialog-close"
          aria-label="Close"
          @click="dismiss"
        >
          ×
        </button>
      </header>
      <p v-if="choice.mode === 'import'" class="profile-picker-intro">
        This game has no interpreter files and is not in the game catalog, so we could not tell
        which version of Sierra's AGI interpreter it was made for. Games built with AGI Studio or
        WinAGI usually target 2.917 or 2.936. If you are unsure, keep the default.
      </p>
      <p v-else class="profile-picker-intro">
        Current profile: <strong>{{ current }}</strong
        >. A running game restarts from its latest autosave under the new profile.
      </p>
      <p class="profile-picker-intro">You can change this later from the game's ⋯ menu.</p>

      <label for="profile-select">Interpreter profile</label>
      <select id="profile-select" v-model="selected" data-testid="profile-picker-select">
        <option v-if="choice.mode === 'library'" value="">
          Automatic{{ choice.detected ? ` (${choice.detected})` : "" }}
        </option>
        <optgroup v-for="group in PROFILE_GROUPS" :key="group.label" :label="group.label">
          <option v-for="opt in group.options" :key="opt.id" :value="opt.id">
            {{ opt.id }}{{ opt.id === choice.detected ? " (default)" : ""
            }}{{ opt.releases ? ` — ${opt.releases}` : "" }}
          </option>
        </optgroup>
      </select>

      <footer>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="profile-picker-keep"
          @click="dismiss"
        >
          {{ choice.mode === "import" && choice.detected ? `Keep ${choice.detected}` : "Cancel" }}
        </button>
        <button
          type="submit"
          class="ui-button ui-button--primary"
          data-testid="profile-picker-confirm"
        >
          Save profile
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.profile-picker-dialog {
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid #5e9b9e;
  border-radius: 10px;
  color: #e9f4f4;
  background: #0b1416;
  box-shadow: 0 24px 80px #000c;
  font-family: system-ui, sans-serif;
}
.profile-picker-dialog::backdrop {
  background: #000b;
}
form {
  display: grid;
  gap: 10px;
  padding: 22px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
  color: #fff;
  font-size: 20px;
  overflow-wrap: anywhere;
}
.profile-picker-intro {
  margin: 0;
  color: #9db0b2;
  font-size: 14px;
  line-height: 1.5;
}
.profile-picker-intro strong {
  color: #e9f4f4;
}
label {
  margin-top: 6px;
  color: #c7d9da;
  font-size: 13px;
}
select {
  width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid #496568;
  border-radius: 4px;
  color: #fff;
  background: #030809;
  font:
    14px/1.4 system-ui,
    sans-serif;
}
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
.dialog-close {
  font-size: 20px;
}
</style>
