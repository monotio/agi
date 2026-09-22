<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProfileId, ProfileDetectionKind } from "../../src/runtime/profile.ts";
import { PROFILE_OPTIONS, formatProfileResolution } from "./profileChoice.ts";

const props = defineProps<{
  open: boolean;
  mode: "import" | "library";
  title: string;
  defaultProfile: ProfileId;
  currentProfile: ProfileId;
  currentKind: ProfileDetectionKind | "override";
  hasOverride: boolean;
}>();

const emit = defineEmits<{
  (e: "confirm", profile: ProfileId): void;
  (e: "decideLater"): void;
  (e: "returnToAuto"): void;
  (e: "close"): void;
}>();

const selectedProfile = ref<string>(props.currentProfile);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedProfile.value = props.currentProfile;
    }
  },
  { immediate: true },
);

watch(
  () => props.currentProfile,
  (val) => {
    selectedProfile.value = val;
  },
);

const currentResolutionText = computed(() => {
  return formatProfileResolution(props.currentProfile, props.currentKind);
});

function onConfirm(): void {
  if (props.mode === "library" && selectedProfile.value === "") {
    emit("returnToAuto");
  } else {
    emit("confirm", selectedProfile.value as ProfileId);
  }
}

function onDecideLater(): void {
  emit("decideLater");
}

function onReturnToAuto(): void {
  emit("returnToAuto");
}

function onClose(): void {
  emit("close");
}
</script>

<template>
  <dialog
    v-if="open"
    open
    class="profile-picker-dialog"
    data-testid="profile-picker-dialog"
    aria-labelledby="profile-picker-title"
    @keydown.esc="onClose"
  >
    <form method="dialog" @submit.prevent="onConfirm">
      <header>
        <h2 id="profile-picker-title">
          {{ mode === "import" ? "Choose interpreter profile" : "Interpreter profile" }}
        </h2>
        <button
          type="button"
          class="ui-button ui-button--secondary ui-button--icon dialog-close"
          aria-label="Close"
          @click="onClose"
        >
          ×
        </button>
      </header>
      <div class="profile-picker-body">
        <p class="profile-picker-intro">
          <template v-if="mode === 'import'">
            This game does not include interpreter files and is not in the known-game catalog.
            Select an interpreter profile to run it under, or keep the default.
          </template>
          <template v-else>
            Current profile: <strong>{{ currentResolutionText }}</strong>
          </template>
        </p>

        <div class="profile-picker-field">
          <label for="profile-select">Interpreter profile</label>
          <select id="profile-select" v-model="selectedProfile" data-testid="profile-picker-select">
            <option v-if="mode === 'library'" value="">Automatic ({{ defaultProfile }})</option>
            <option v-for="opt in PROFILE_OPTIONS" :key="opt.id" :value="opt.id">
              {{ opt.label }}
            </option>
          </select>
        </div>

        <div class="profile-picker-actions">
          <template v-if="mode === 'import'">
            <button
              type="submit"
              class="ui-button ui-button--primary"
              data-testid="profile-picker-confirm"
            >
              Save profile
            </button>
            <button
              type="button"
              class="ui-button ui-button--secondary"
              data-testid="profile-picker-decide-later"
              @click="onDecideLater"
            >
              Decide later
            </button>
          </template>
          <template v-else>
            <button
              type="submit"
              class="ui-button ui-button--primary"
              data-testid="profile-picker-confirm"
            >
              Save profile
            </button>
            <button
              v-if="hasOverride"
              type="button"
              class="ui-button ui-button--secondary"
              data-testid="profile-picker-auto"
              @click="onReturnToAuto"
            >
              Return to automatic
            </button>
            <button
              type="button"
              class="ui-button ui-button--secondary"
              data-testid="profile-picker-cancel"
              @click="onClose"
            >
              Cancel
            </button>
          </template>
        </div>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.profile-picker-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1000;
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid #5e9b9e;
  border-radius: 10px;
  color: #e9f4f4;
  background: #0b1416;
  box-shadow: 0 24px 80px #000c;
  font-family: system-ui, sans-serif;
}
form {
  display: grid;
  gap: 12px;
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
}
.profile-picker-body {
  display: grid;
  gap: 16px;
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
.profile-picker-field {
  display: grid;
  gap: 6px;
}
label {
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
.profile-picker-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
.dialog-close {
  font-size: 20px;
}
</style>
