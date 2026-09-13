/**
 * The AI settings dialog state and actions: provider profiles, the persisted
 * model/key/effort, the task budget, and the open/apply/close flow. App.vue
 * mounts the dialog and provides this controller; components that offer an
 * "AI provider" entry point inject it instead of receiving props.
 */
import { computed, inject, nextTick, provide, ref, watch } from "vue";
import type { InjectionKey, Ref } from "vue";
import type { EngineApi } from "./engineContext.ts";
import {
  DEFAULT_MODELS,
  MODEL_OPTIONS,
  type LlmConfig,
  type ProviderType,
} from "./agent/llmClient.ts";
import { copyAiSettings, loadAiSettings, saveAiSettings, type AiSettings } from "./aiSettings.ts";

export type AiSettingsContext = "header" | "create" | "assistant";

export interface AiSettingsDeps {
  /** The mounted AiSettings dialog (App.vue owns its template ref). */
  dialog: Readonly<Ref<{ show(): void; close(): void } | null>>;
  /** Drop held movement keys before the dialog grabs the keyboard. */
  releaseMovement(): void;
  /** The create pane's launch button: return focus lands here by default. */
  createButtonEl(): HTMLElement | null | undefined;
  /** The assistant bubble's input: return focus lands here for that context. */
  assistantInputEl(): HTMLElement | null | undefined;
}

export function createAiSettings(engine: EngineApi, deps: AiSettingsDeps) {
  const { state, pauseEngine, resumeEngine, updateAiConfig, openPowerUp } = engine;
  const testMode = import.meta.env.MODE === "test";

  const savedBudget = Number(localStorage.getItem("monotio_agi.taskBudget") ?? 5);
  const taskBudget = ref(Number.isFinite(savedBudget) && savedBudget > 0 ? savedBudget : 5);
  watch(taskBudget, (value) => {
    if (Number.isFinite(value) && value > 0)
      localStorage.setItem("monotio_agi.taskBudget", String(value));
  });
  const initialAiSettings = loadAiSettings(localStorage, DEFAULT_MODELS, testMode);
  const initialProfile = initialAiSettings.profiles[initialAiSettings.provider];
  const aiSettings = ref(initialAiSettings);
  const aiModelLabel = computed(() => {
    const { provider: current, profiles } = aiSettings.value;
    const model = profiles[current].model;
    return MODEL_OPTIONS[current].find((option) => option.id === model)?.label ?? model;
  });
  const provider = ref<ProviderType>(initialAiSettings.provider);
  const apiKey = ref(initialProfile.apiKey);
  const model = ref(initialProfile.model);
  const effort = ref(initialProfile.effort);
  const aiConfigured = computed(() => provider.value === "stub" || apiKey.value.trim().length > 0);

  const aiSettingsDialog = deps.dialog;
  const aiSettingsSaving = ref(false);
  const aiSettingsError = ref("");
  const aiSettingsContext = ref<AiSettingsContext>("header");
  const aiSettingsUnavailable = computed(
    () =>
      state.powerUp.busy ||
      state.agentTask?.status === "running" ||
      state.agentTask?.status === "paused",
  );
  let aiSettingsReturnFocus: HTMLElement | null = null;
  let aiSettingsOwnedPause = false;

  function openAiSettings(event: Event | null, context: AiSettingsContext): void {
    if (aiSettingsUnavailable.value) return;
    aiSettingsContext.value = context;
    aiSettingsError.value = "";
    aiSettingsReturnFocus =
      event?.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : (deps.createButtonEl() ?? null);
    deps.releaseMovement();
    if (state.phase === "running" && !state.paused) {
      pauseEngine();
      aiSettingsOwnedPause = true;
    }
    aiSettingsDialog.value?.show();
  }

  function llmConfig(): LlmConfig {
    return {
      provider: provider.value,
      apiKey: apiKey.value.trim(),
      model: model.value.trim(),
      effort: effort.value,
      budgetUsd: taskBudget.value,
    };
  }

  async function applyAiSettings(settings: AiSettings, budgetUsd: number): Promise<void> {
    aiSettingsSaving.value = true;
    aiSettingsError.value = "";
    try {
      saveAiSettings(localStorage, settings);
      aiSettings.value = copyAiSettings(settings);
      taskBudget.value = budgetUsd;
      provider.value = settings.provider;
      model.value = settings.profiles[settings.provider].model;
      apiKey.value = settings.profiles[settings.provider].apiKey;
      effort.value = settings.profiles[settings.provider].effort;
      await updateAiConfig(llmConfig());
      if (state.powerUp.open) await openPowerUp(llmConfig());
      aiSettingsDialog.value?.close();
    } catch (error) {
      aiSettingsError.value = `Could not apply AI settings: ${String(error).replace(/^Error: /, "")}`;
    } finally {
      aiSettingsSaving.value = false;
    }
  }

  function onAiSettingsClosed(): void {
    if (aiSettingsOwnedPause) {
      aiSettingsOwnedPause = false;
      resumeEngine();
    }
    const returnFocus = aiSettingsReturnFocus;
    aiSettingsReturnFocus = null;
    nextTick(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else if (aiSettingsContext.value === "create") deps.createButtonEl()?.focus();
      else if (aiSettingsContext.value === "assistant") deps.assistantInputEl()?.focus();
      else document.querySelector<HTMLElement>('[data-testid="settings-menu"]')?.focus();
    });
  }

  return {
    testMode,
    taskBudget,
    aiSettings,
    aiModelLabel,
    provider,
    apiKey,
    model,
    effort,
    aiConfigured,
    aiSettingsSaving,
    aiSettingsError,
    aiSettingsContext,
    aiSettingsUnavailable,
    openAiSettings,
    applyAiSettings,
    onAiSettingsClosed,
    llmConfig,
  };
}

export type AiSettingsApi = ReturnType<typeof createAiSettings>;

export const aiSettingsKey: InjectionKey<AiSettingsApi> = Symbol("agi-ai-settings");

export function provideAiSettings(api: AiSettingsApi): void {
  provide(aiSettingsKey, api);
}

export function useAiSettings(): AiSettingsApi {
  const api = inject(aiSettingsKey);
  if (!api) throw new Error("useAiSettings: App.vue did not provide the AI settings controller");
  return api;
}
