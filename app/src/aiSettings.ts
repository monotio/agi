import {
  defaultModelEffort,
  modelEffortOptions,
  type ModelEffort,
} from "../../src/agent/modelEffort.ts";
import { MODEL_OPTIONS } from "./agent/llmClient.ts";

export type AiSettingsProvider = "openai" | "anthropic" | "stub";

export interface AiProviderSettings {
  model: string;
  apiKey: string;
  effort: ModelEffort;
}

export interface AiSettings {
  version: 1;
  provider: AiSettingsProvider;
  profiles: Record<AiSettingsProvider, AiProviderSettings>;
}

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;
type DefaultModels = Record<AiSettingsProvider, string>;
type AllowedModels = Record<AiSettingsProvider, readonly string[]>;

export const AI_SETTINGS_KEY = "monotio_agi.aiSettings";

/** Ids the settings dialog offers; any other stored id would render a blank model select. */
const KNOWN_MODEL_IDS: AllowedModels = {
  openai: MODEL_OPTIONS.openai.map((option) => option.id),
  anthropic: MODEL_OPTIONS.anthropic.map((option) => option.id),
  stub: MODEL_OPTIONS.stub.map((option) => option.id),
};

function provider(value: unknown, allowStub: boolean): AiSettingsProvider | null {
  if (value === "openai" || value === "anthropic") return value;
  return allowStub && value === "stub" ? value : null;
}

function defaults(models: DefaultModels): AiSettings {
  return {
    version: 1,
    provider: "openai",
    profiles: {
      openai: { model: models.openai, apiKey: "", effort: defaultModelEffort(models.openai) },
      anthropic: {
        model: models.anthropic,
        apiKey: "",
        effort: defaultModelEffort(models.anthropic),
      },
      stub: { model: models.stub, apiKey: "", effort: defaultModelEffort(models.stub) },
    },
  };
}

/** The stored record as an object; null when absent, unreadable or not an object. */
function storedRecord(storage: SettingsStorage): Record<string, unknown> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(AI_SETTINGS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function loadAiSettings(
  storage: SettingsStorage,
  models: DefaultModels,
  allowStub: boolean,
  allowedModels: AllowedModels = KNOWN_MODEL_IDS,
): AiSettings {
  const settings = defaults(models);
  const value = storedRecord(storage);
  if (!value || value["version"] !== 1) return settings;
  const profiles = value["profiles"] as Record<string, unknown> | undefined;
  for (const name of ["openai", "anthropic", "stub"] as const) {
    const profile = profiles?.[name] as Record<string, unknown> | undefined;
    const target = settings.profiles[name];
    const model = typeof profile?.["model"] === "string" ? profile["model"].trim() : "";
    if (model && (model === models[name] || allowedModels[name].includes(model))) {
      const effort = profile?.["effort"] as ModelEffort | undefined;
      target.model = model;
      target.effort =
        effort !== undefined && modelEffortOptions(model).includes(effort)
          ? effort
          : defaultModelEffort(model);
    }
    if (typeof profile?.["apiKey"] === "string") target.apiKey = profile["apiKey"];
  }
  settings.provider = provider(value["provider"], allowStub) ?? "openai";
  return settings;
}

export function saveAiSettings(storage: SettingsStorage, settings: AiSettings): void {
  const stored = storedRecord(storage);
  if (stored && stored["version"] !== 1)
    throw new Error(
      "These AI settings use an unsupported format. Update the app before changing them.",
    );
  if (settings.version !== 1) throw new Error("Unsupported AI settings version.");
  const selected = provider(settings.provider, true);
  if (!selected) throw new Error("Choose an AI provider.");
  for (const name of ["openai", "anthropic", "stub"] as const) {
    if (!settings.profiles[name].model.trim()) throw new Error(`Choose a model for ${name}.`);
    if (!modelEffortOptions(settings.profiles[name].model).includes(settings.profiles[name].effort))
      throw new Error(`Choose a supported reasoning effort for ${name}.`);
  }
  storage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
}

export function copyAiSettings(settings: AiSettings): AiSettings {
  return {
    version: 1,
    provider: settings.provider,
    profiles: {
      openai: { ...settings.profiles.openai },
      anthropic: { ...settings.profiles.anthropic },
      stub: { ...settings.profiles.stub },
    },
  };
}
