<script setup lang="ts">
import { ref } from "vue";
import { defaultModelEffort, modelEffortOptions } from "../../src/agent/modelEffort.ts";
import { copyAiSettings, type AiSettings, type AiSettingsProvider } from "./aiSettings.ts";

const props = defineProps<{
  settings: AiSettings;
  models: Record<AiSettingsProvider, readonly { id: string; label: string }[]>;
  allowStub: boolean;
  saving: boolean;
  error: string;
}>();
const emit = defineEmits<{
  save: [settings: AiSettings];
  closed: [];
}>();

const dialog = ref<HTMLDialogElement | null>(null);
const draft = ref(copyAiSettings(props.settings));

function show(): void {
  draft.value = copyAiSettings(props.settings);
  dialog.value?.showModal();
}

function close(): void {
  dialog.value?.close();
}

function applyModelDefault(): void {
  const profile = draft.value.profiles[draft.value.provider];
  profile.effort = defaultModelEffort(profile.model);
}

defineExpose({ show, close });
</script>

<template>
  <dialog
    ref="dialog"
    class="ai-settings-dialog"
    aria-labelledby="ai-settings-title"
    data-testid="ai-settings-dialog"
    @close="emit('closed')"
  >
    <form method="dialog" @submit.prevent="emit('save', copyAiSettings(draft))">
      <header>
        <div>
          <p class="dialog-kicker">AI connection</p>
          <h2 id="ai-settings-title">AI settings</h2>
        </div>
        <button
          type="button"
          class="dialog-close"
          aria-label="Cancel AI settings"
          :disabled="saving"
          @click="close"
        >
          ×
        </button>
      </header>
      <p class="dialog-intro">Used to create, ask about and remix games.</p>
      <label for="ai-provider">Provider</label>
      <select id="ai-provider" v-model="draft.provider" data-testid="provider-select">
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option v-if="allowStub" value="stub">Offline test provider</option>
      </select>
      <label for="ai-model">Model</label>
      <select
        id="ai-model"
        v-model="draft.profiles[draft.provider].model"
        data-testid="model-select"
        @change="applyModelDefault"
      >
        <option v-for="option in models[draft.provider]" :key="option.id" :value="option.id">
          {{ option.label }}
        </option>
      </select>
      <template v-if="draft.provider !== 'stub'">
        <label for="ai-effort">Reasoning effort</label>
        <select
          id="ai-effort"
          v-model="draft.profiles[draft.provider].effort"
          data-testid="effort-select"
        >
          <option
            v-for="effort in modelEffortOptions(draft.profiles[draft.provider].model)"
            :key="effort"
            :value="effort"
          >
            {{ effort }}
            {{
              effort === defaultModelEffort(draft.profiles[draft.provider].model) ? "(default)" : ""
            }}
          </option>
        </select>
      </template>
      <template v-if="draft.provider !== 'stub'">
        <div class="field-label-row">
          <label for="ai-api-key">API key</label>
          <a
            :href="
              draft.provider === 'anthropic'
                ? 'https://platform.claude.com/settings/keys'
                : 'https://platform.openai.com/api-keys'
            "
            target="_blank"
            rel="noopener noreferrer"
          >
            Get an API key
          </a>
        </div>
        <input
          id="ai-api-key"
          v-model="draft.profiles[draft.provider].apiKey"
          type="password"
          autocomplete="off"
          placeholder="Paste your provider API key"
          data-testid="api-key-input"
        />
      </template>
      <p class="privacy-note">Your key stays in this browser.</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <footer>
        <button
          type="button"
          class="dialog-secondary"
          data-testid="ai-settings-cancel"
          :disabled="saving"
          @click="close"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="dialog-primary"
          data-testid="ai-settings-save"
          :disabled="saving"
        >
          {{ saving ? "Saving…" : "Save settings" }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.ai-settings-dialog {
  width: min(520px, calc(100vw - 32px));
  padding: 0;
  border: 1px solid #5e9b9e;
  border-radius: 10px;
  color: #e9f4f4;
  background: #0b1416;
  box-shadow: 0 24px 80px #000c;
  font-family: system-ui, sans-serif;
}
.ai-settings-dialog::backdrop {
  background: #000b;
}
form {
  display: grid;
  gap: 8px;
  padding: 22px;
}
header,
footer,
.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2,
.dialog-kicker,
.dialog-intro,
.privacy-note,
.dialog-error {
  margin: 0;
}
h2 {
  color: #fff;
  font-size: 24px;
}
.dialog-kicker {
  color: #79cfd1;
  font: 700 11px/1.4 monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.dialog-intro,
.privacy-note {
  color: #9db0b2;
  line-height: 1.5;
}
.dialog-intro {
  margin-bottom: 8px;
}
label {
  margin-top: 8px;
  color: #c7d9da;
  font-size: 13px;
}
select,
input {
  width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  padding: 9px 11px;
  border: 1px solid #496568;
  border-radius: 4px;
  color: #fff;
  background: #030809;
  font:
    14px/1.4 ui-monospace,
    monospace;
}
a {
  color: #88e8ea;
  font-size: 12px;
}
.dialog-close {
  width: 40px;
  min-height: 40px;
  border: 0;
  color: #b8cccc;
  background: transparent;
  cursor: pointer;
  font-size: 25px;
}
.dialog-error {
  color: #ffaaa4;
}
footer {
  justify-content: flex-end;
  margin-top: 12px;
}
.dialog-primary,
.dialog-secondary {
  min-height: 44px;
  padding: 9px 15px;
  border: 1px solid #527679;
  border-radius: 4px;
  color: #d9eeee;
  background: #132426;
  cursor: pointer;
  font:
    700 14px/1.4 system-ui,
    sans-serif;
}
.dialog-primary {
  color: #071112;
  border-color: #79e5e6;
  background: #79e5e6;
}
button:disabled {
  cursor: wait;
  opacity: 0.6;
}
</style>
