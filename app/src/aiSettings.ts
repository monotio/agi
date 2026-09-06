import {
  defaultModelEffort,
  modelEffortOptions,
  type ModelEffort,
} from "../../src/agent/modelEffort.ts";

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

export const AI_SETTINGS_KEY = "monotio_agi.aiSettings";

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

export function loadAiSettings(
  storage: SettingsStorage,
  models: DefaultModels,
  allowStub: boolean,
): AiSettings {
  const fallback = defaults(models);
  let raw: string | null;
  try {
    raw = storage.getItem(AI_SETTINGS_KEY);
  } catch {
    return fallback;
  }
  if (raw !== null) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value["version"] !== 1) return fallback;
      const selected = provider(value["provider"], allowStub) ?? "openai";
      const profiles = value["profiles"] as Record<string, unknown> | undefined;
      for (const name of ["openai", "anthropic", "stub"] as const) {
        const profile = profiles?.[name] as Record<string, unknown> | undefined;
        if (typeof profile?.["model"] === "string" && profile["model"].trim())
          fallback.profiles[name].model = profile["model"].trim();
        if (typeof profile?.["apiKey"] === "string")
          fallback.profiles[name].apiKey = profile["apiKey"];
        const effort = profile?.["effort"] as ModelEffort | undefined;
        fallback.profiles[name].effort = modelEffortOptions(fallback.profiles[name].model).includes(
          effort ?? defaultModelEffort(fallback.profiles[name].model),
        )
          ? (effort ?? defaultModelEffort(fallback.profiles[name].model))
          : defaultModelEffort(fallback.profiles[name].model);
      }
      fallback.provider = selected;
      return fallback;
    } catch {
      return fallback;
    }
  }

  return fallback;
}

export function saveAiSettings(storage: SettingsStorage, settings: AiSettings): void {
  const stored = storage.getItem(AI_SETTINGS_KEY);
  if (stored !== null) {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1)
      throw new Error(
        "These AI settings use an unsupported format. Update the app before changing them.",
      );
  }
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
