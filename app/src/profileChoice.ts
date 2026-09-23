import { ref } from "vue";
import {
  EQUIVALENT_BUILDS,
  PROFILES,
  type ProfileId,
  type ProfileDetectionKind,
} from "../../src/runtime/profile.ts";
import { KNOWN_GAMES } from "../../src/games/knownGames.ts";
import { getCachedGameMeta, setLibraryGameProfile, type CachedGameMeta } from "./gameStorage.ts";
import type { ProjectId } from "./gameTypes.ts";

export { type ProfileId, type ProfileDetectionKind };

export interface ProfileOption {
  readonly id: ProfileId;
  /** Catalogued releases that ship this build, comma-separated; empty when none do. */
  readonly releases: string;
}

export interface ProfileOptionGroup {
  readonly label: string;
  readonly options: readonly ProfileOption[];
}

function platformLabel(id: ProfileId): string {
  if (id.startsWith("amiga-")) return "Amiga";
  if (id.startsWith("iigs-")) return "Apple IIgs";
  return PROFILES[id].container === "v3-combined" ? "PC v3" : "PC v2";
}

/**
 * Every promoted profile grouped by platform, with the catalogued releases
 * known to ship that build (or a documented equivalent).
 */
export const PROFILE_GROUPS: readonly ProfileOptionGroup[] = (() => {
  const groups = new Map<string, ProfileOption[]>();
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const titles = KNOWN_GAMES.filter(
      (game) =>
        game.alias !== "synthetic" &&
        (game.profile === id || EQUIVALENT_BUILDS[game.profile] === id),
    ).map((game) => game.title.split(":")[0]!);
    const platform = platformLabel(id);
    groups.set(platform, [...(groups.get(platform) ?? []), { id, releases: titles.join(", ") }]);
  }
  return [...groups].map(([label, options]) => ({ label, options }));
})();

function knownProfile(value: string | undefined): ProfileId | undefined {
  return value !== undefined && Object.hasOwn(PROFILES, value) ? (value as ProfileId) : undefined;
}

export interface ProfileChoiceState {
  projectId: ProjectId;
  title: string;
  mode: "import" | "library";
  /** The profile the opening check detected; absent until the opening is checked. */
  detected: ProfileId | undefined;
  kind: ProfileDetectionKind | undefined;
  build: string | undefined;
  /** The stored override, if any. */
  override: ProfileId | undefined;
}

export interface ProfileChoiceControllerDeps {
  /** The project the player is in, if a game is running. */
  runningProjectId: () => ProjectId | undefined;
  flushAutosave: (timeoutMs?: number) => Promise<unknown>;
  refreshLibrary: (id?: ProjectId) => void;
  onPlayLibraryGame: (game: CachedGameMeta) => Promise<void>;
  reportError: (message: string) => void;
}

/**
 * Short summary of the profile and how the edition was identified, for menus
 * and dialogs. An identified build that has no promoted profile runs the
 * container fallback, and the label says so.
 */
export function formatProfileResolution(
  profileId: ProfileId | string,
  kind: ProfileDetectionKind | "override",
  build?: string | null,
): string {
  const named = build && build !== profileId ? `build ${build}, no dedicated profile; ` : "";
  switch (kind) {
    case "binary":
      return `${profileId} (${named}identified from interpreter files)`;
    case "catalog":
      return `${profileId} (${named}identified from the game catalog)`;
    case "default":
      return `${profileId} (container default)`;
    case "override":
      return `${profileId} (your override)`;
  }
}

/** Short summary of a library game's current interpreter profile. */
export function describeGameProfile(game: CachedGameMeta): string {
  if (game.library?.profile) return formatProfileResolution(game.library.profile, "override");
  const validation = game.library?.validation;
  if (!validation?.profile || !validation.kind) return "Automatic (opening not checked)";
  return formatProfileResolution(validation.profile, validation.kind, validation.build);
}

function choiceState(game: CachedGameMeta, mode: ProfileChoiceState["mode"]): ProfileChoiceState {
  const validation = game.library?.validation;
  return {
    projectId: game.projectId,
    title: game.title,
    mode,
    detected: knownProfile(validation?.profile),
    kind: validation?.kind,
    build: validation?.build,
    override: game.library?.profile,
  };
}

export function createProfileChoiceController(deps: ProfileChoiceControllerDeps) {
  const profileChoiceState = ref<ProfileChoiceState>();
  // Imports that arrive while the picker is open wait their turn.
  const waiting: ProfileChoiceState[] = [];

  function show(state: ProfileChoiceState): void {
    if (profileChoiceState.value) waiting.push(state);
    else profileChoiceState.value = state;
  }

  /**
   * Offer the picker after an import when the edition could not be identified.
   * A game made in the app is plain 2.936 by design, and an entry that already
   * holds a choice (the same bytes imported again) keeps it without asking.
   */
  function offerImportProfileChoice(game: CachedGameMeta, createdInApp: boolean): boolean {
    const validation = game.library?.validation;
    if (createdInApp || game.roomGeneration || game.library?.profile) return false;
    if (validation?.kind !== "default" || !knownProfile(validation.profile)) return false;
    show(choiceState(game, "import"));
    return true;
  }

  function openLibraryProfileChoice(game: CachedGameMeta): void {
    show(choiceState(game, "library"));
  }

  function closeProfileChoice(): void {
    profileChoiceState.value = waiting.shift();
  }

  /**
   * Store the chosen override; undefined means automatic. At import the
   * detected profile is what automatic already runs, so choosing it stores
   * nothing. A running game reboots under its new profile.
   */
  async function applyProfileChoice(choice: ProfileId | undefined): Promise<void> {
    const current = profileChoiceState.value;
    if (!current) return;
    closeProfileChoice();
    const stored = current.mode === "import" && choice === current.detected ? undefined : choice;
    if (stored === current.override) return;
    const id = current.projectId;
    const running = deps.runningProjectId() === id;
    try {
      if (running) await deps.flushAutosave(1000);
      const saved = await setLibraryGameProfile(id, stored, getCachedGameMeta(id)?.generation);
      if (!saved)
        throw new Error(
          "The interpreter profile could not be saved. The game may have changed in another window; reopen the menu and try again.",
        );
      deps.refreshLibrary(id);
      const updated = running ? getCachedGameMeta(id) : null;
      if (updated) await deps.onPlayLibraryGame(updated);
    } catch (error) {
      deps.reportError(String(error).replace(/^Error: /, ""));
    }
  }

  return {
    profileChoiceState,
    offerImportProfileChoice,
    openLibraryProfileChoice,
    closeProfileChoice,
    applyProfileChoice,
  };
}
