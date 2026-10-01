/**
 * Development convenience: with `AGI_DEV_KEYS=1 npm run dev`, the Vite dev
 * server answers DEV_KEYS_PATH from this machine with the OpenAI and
 * Anthropic keys in its environment, and the app fills the AI settings it
 * has no key for. The server half runs only in `vite serve` development
 * mode; the client half loads only when `import.meta.env.MODE` is
 * "development", so builds and the Playwright test server never contain or
 * call it (`npm run check:bundle` fails a build that names the path).
 */
import { DEV_KEYS_PATH } from "../../devKeys.config.ts";
import { copyAiSettings, type AiSettings, type AiSettingsProvider } from "./aiSettings.ts";

export { DEV_KEYS_PATH };

type DevKeys = Partial<Record<Exclude<AiSettingsProvider, "stub">, string>>;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only this machine, addressed as localhost: other devices and rebound DNS names are refused. */
export function isLoopbackRequest(
  remoteAddress: string | undefined,
  host: string | undefined,
): boolean {
  if (remoteAddress === undefined || !LOOPBACK_ADDRESSES.has(remoteAddress)) return false;
  const hostname = host?.replace(/:\d+$/, "").toLowerCase();
  return hostname !== undefined && LOOPBACK_HOSTS.has(hostname);
}

/** The keys the dev server hands out: present, non-empty provider keys only. */
export function devKeysFromEnv(env: Readonly<Record<string, string | undefined>>): DevKeys {
  const keys: DevKeys = {};
  const openai = env["OPENAI_API_KEY"]?.trim();
  const anthropic = env["ANTHROPIC_API_KEY"]?.trim();
  if (openai) keys.openai = openai;
  if (anthropic) keys.anthropic = anthropic;
  return keys;
}

/**
 * Settings with the dev server's keys filled in where a provider has none,
 * switching to a keyed provider when the current one has no key. Keys the
 * player entered are kept. Null when nothing changes or the server offers none.
 */
export async function settingsWithDevKeys(
  settings: AiSettings,
  fetchKeys: (path: string) => Promise<Response> = (path) => fetch(path),
): Promise<AiSettings | null> {
  let keys: DevKeys;
  try {
    const response = await fetchKeys(DEV_KEYS_PATH);
    if (!response.ok) return null;
    keys = (await response.json()) as DevKeys;
  } catch {
    return null;
  }
  const next = copyAiSettings(settings);
  let changed = false;
  for (const provider of ["openai", "anthropic"] as const) {
    const key = keys[provider];
    if (typeof key === "string" && key && !next.profiles[provider].apiKey) {
      next.profiles[provider].apiKey = key;
      changed = true;
    }
  }
  if (!next.profiles[next.provider].apiKey) {
    const keyed = (["openai", "anthropic"] as const).find((p) => next.profiles[p].apiKey);
    if (keyed) {
      next.provider = keyed;
      changed = true;
    }
  }
  return changed ? next : null;
}
