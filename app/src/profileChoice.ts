import { ref } from "vue";
import {
  EQUIVALENT_BUILDS,
  PROFILES,
  type ProfileId,
  type ProfileDetectionKind,
} from "../../src/runtime/profile.ts";
import { KNOWN_GAMES } from "../../src/games/knownGames.ts";
import type { CachedGameMeta } from "./gameStorage.ts";
import { getCachedGameMeta } from "./gameStorage.ts";
import { updateLibraryGameProfile } from "./gameLibrary.ts";
import type { ProjectId } from "./gameTypes.ts";

export { type ProfileId, type ProfileDetectionKind };

export interface ProfileOption {
  readonly id: ProfileId;
  readonly label: string;
}

/**
 * Every promoted profile, labelled with the catalogued releases known to ship
 * that build (or a documented equivalent); a profile no catalogued release
 * uses is listed by id alone.
 */
export const PROFILE_OPTIONS: readonly ProfileOption[] = (Object.keys(PROFILES) as ProfileId[]).map(
  (id) => {
    const titles = KNOWN_GAMES.filter(
      (game) =>
        game.alias !== "synthetic" &&
        (game.profile === id || EQUIVALENT_BUILDS[game.profile] === id),
    ).map((game) => game.title.split(":")[0]!);
    return { id, label: titles.length > 0 ? `${id} — ${titles.join(", ")}` : id };
  },
);

export interface ProfileChoiceState {
  projectId: ProjectId;
  title: string;
  defaultProfile: ProfileId;
  currentProfile: ProfileId;
  currentKind: ProfileDetectionKind | "override";
  hasOverride: boolean;
  mode: "import" | "library";
}

export interface ProfileChoiceControllerDeps {
  isGameRunning: (id: ProjectId) => boolean;
  flushAutosave: (timeoutMs?: number) => Promise<unknown>;
  refreshLibrary: (id?: ProjectId) => void;
  onPlayLibraryGame: (game: CachedGameMeta) => Promise<void>;
}

/**
 * An imported game shows the profile picker before its first boot only when
 * the edition could not be identified from interpreter binaries or catalog hashes.
 */
export function shouldShowProfilePicker(kind: ProfileDetectionKind | undefined | null): boolean {
  return kind === "default";
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

/** Short summary of an installed or cached game's current interpreter profile. */
export function describeGameProfile(game: CachedGameMeta): string {
  if (game.library?.profile) {
    return formatProfileResolution(game.library.profile, "override");
  }
  const profile = (game.library?.validation?.profile as ProfileId) ?? "2.936";
  const kind = game.library?.validation?.kind ?? "default";
  return formatProfileResolution(profile, kind, game.library?.validation?.build);
}

export function createProfileChoiceController(deps: ProfileChoiceControllerDeps) {
  const profileChoiceState = ref<ProfileChoiceState>();

  function openImportProfileChoice(
    projectId: ProjectId,
    title: string,
    defaultProfile: ProfileId,
  ): void {
    profileChoiceState.value = {
      projectId,
      title,
      defaultProfile,
      currentProfile: defaultProfile,
      currentKind: "default",
      hasOverride: false,
      mode: "import",
    };
  }

  function openLibraryProfileChoice(game: CachedGameMeta): void {
    const currentOverride = game.library?.profile;
    const detectedProfile = (game.library?.validation?.profile as ProfileId) ?? "2.936";
    const detectedKind = game.library?.validation?.kind ?? "default";
    profileChoiceState.value = {
      projectId: game.projectId,
      title: game.title,
      defaultProfile: detectedProfile,
      currentProfile: currentOverride ?? detectedProfile,
      currentKind: currentOverride ? "override" : detectedKind,
      hasOverride: Boolean(currentOverride),
      mode: "library",
    };
  }

  function closeProfileChoice(): void {
    profileChoiceState.value = undefined;
  }

  async function applyProfileChoice(newProfile: ProfileId | undefined): Promise<void> {
    const current = profileChoiceState.value;
    if (!current) return;
    const id = current.projectId;
    closeProfileChoice();

    const isRunning = deps.isGameRunning(id);
    if (isRunning) {
      try {
        await deps.flushAutosave(1000);
      } catch {
        // checkpoint failure ignored
      }
    }

    await updateLibraryGameProfile(id, newProfile);
    deps.refreshLibrary(id);

    if (isRunning) {
      const updatedMeta = getCachedGameMeta(id);
      if (updatedMeta) {
        await deps.onPlayLibraryGame(updatedMeta);
      }
    }
  }

  function decideLaterProfileChoice(): void {
    closeProfileChoice();
  }

  return {
    profileChoiceState,
    openImportProfileChoice,
    openLibraryProfileChoice,
    closeProfileChoice,
    applyProfileChoice,
    decideLaterProfileChoice,
  };
}
