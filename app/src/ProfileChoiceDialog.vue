<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from "vue";
import UiButton from "./ui/UiButton.vue";
import UiIconButton from "./ui/UiIconButton.vue";
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
        <UiIconButton icon="x" label="Close" @click="dismiss" />
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
        <UiButton data-testid="profile-picker-keep" @click="dismiss">
          {{ choice.mode === "import" && choice.detected ? `Keep ${choice.detected}` : "Cancel" }}
        </UiButton>
        <UiButton type="submit" variant="primary" data-testid="profile-picker-confirm">
          Save profile
        </UiButton>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.profile-picker-dialog {
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid var(--action-line);
  border-radius: var(--radius-lg);
  color: var(--ink);
  background: var(--surface-1);
  box-shadow: var(--shadow-dialog);
  font-family: var(--font-sans);
}
.profile-picker-dialog::backdrop {
  background: var(--scrim);
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
  color: var(--ink);
  font-size: var(--text-xl);
  overflow-wrap: anywhere;
}
.profile-picker-intro {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-md);
  line-height: 1.5;
}
.profile-picker-intro strong {
  color: var(--ink);
}
label {
  margin-top: 6px;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
select {
  width: 100%;
  min-height: var(--control-h-touch);
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-md) / 1.4 var(--font-sans);
}
footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
</style>
