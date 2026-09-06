<script setup lang="ts">
import { ref, useTemplateRef } from "vue";
import { defaultModelEffort, modelEffortOptions } from "../../src/agent/modelEffort.ts";
import { copyAiSettings, type AiSettings, type AiSettingsProvider } from "./aiSettings.ts";

const { settings, budgetUsd } = defineProps<{
  settings: AiSettings;
  models: Record<AiSettingsProvider, readonly { id: string; label: string }[]>;
  allowStub: boolean;
  saving: boolean;
  error: string;
  budgetUsd: number;
}>();
const emit = defineEmits<{
  save: [settings: AiSettings, budgetUsd: number];
  closed: [];
}>();

const dialog = useTemplateRef("dialog");
const draft = ref(copyAiSettings(settings));
const draftBudget = ref(budgetUsd);

function show(): void {
  draft.value = copyAiSettings(settings);
  draftBudget.value = budgetUsd;
  dialog.value?.showModal();
}

function close(): void {
  dialog.value?.close();
}

function applyModelDefault(): void {
  const profile = draft.value.profiles[draft.value.provider];
  profile.effort = defaultModelEffort(profile.model);
}

function save(): void {
  if (!Number.isFinite(draftBudget.value) || draftBudget.value <= 0) return;
  emit("save", copyAiSettings(draft.value), draftBudget.value);
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
    <form method="dialog" @submit.prevent="save">
      <header>
        <h2 id="ai-settings-title">AI settings</h2>
        <button
          type="button"
          class="ui-button ui-button--secondary ui-button--icon dialog-close"
          aria-label="Cancel AI settings"
          :disabled="saving"
          @click="close"
        >
          ×
        </button>
      </header>
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
        <p class="privacy-note">Your key stays in this browser.</p>
      </template>
      <label for="task-budget">Budget per task · USD</label>
      <input
        id="task-budget"
        v-model.number="draftBudget"
        type="number"
        min="0.01"
        step="0.01"
        required
        data-testid="task-budget"
      />
      <p class="budget-note">Maximum estimated spend for each creation or remix.</p>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <footer>
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="ai-settings-cancel"
          :disabled="saving"
          @click="close"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="ui-button ui-button--primary"
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
.privacy-note,
.budget-note,
.dialog-error {
  margin: 0;
}
h2 {
  color: #fff;
  font-size: 24px;
}
.privacy-note,
.budget-note {
  color: #9db0b2;
  line-height: 1.5;
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
    14px/1.4 system-ui,
    sans-serif;
}
a {
  color: #88e8ea;
  font-size: 12px;
}
select {
  height: 44px;
}
.dialog-close {
  font-size: 25px;
}
.dialog-error {
  color: #ffaaa4;
}
footer {
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
