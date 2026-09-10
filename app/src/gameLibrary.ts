import { gameRevision, isLocalGamePreview, type LibraryMetadata } from "./gameMetadata.ts";
import { storeImportedProgress, type ImportStorageReport } from "./gameProgress.ts";
import {
  loadAuthoredGame,
  saveAuthoredGame,
  listCachedGames,
  type ProjectId,
} from "./gameStorage.ts";
import type { OpenedGame } from "./gameZip.ts";
import { detectKnownGame } from "./knownGames.ts";

export interface CheckedOpening {
  preview: string;
  status: "ready" | "needs-input";
  message: string;
  profile: string;
}

/** Import only after inspection. Re-importing bytes never replaces a remix or private project. */
export async function addLibraryGame(
  game: OpenedGame,
  title: string,
  source: "zip" | "folder" | "catalog",
  opening: CheckedOpening,
  catalog?: { id: string; version: string },
  onProgressStored?: (report: ImportStorageReport) => void,
): Promise<ProjectId> {
  if (!isLocalGamePreview(opening.preview))
    throw new Error("The checked opening did not produce a local PNG preview.");
  if ((source === "catalog") !== Boolean(catalog))
    throw new Error("Catalog games require a catalog release identifier.");
  if (
    catalog &&
    (!/^[A-Za-z0-9._-]{1,80}$/.test(catalog.id) || !/^[A-Za-z0-9._+-]{1,80}$/.test(catalog.version))
  )
    throw new Error("The catalog release identifier is invalid.");
  const known = await detectKnownGame(game.files);
  const revision = await gameRevision(game.files);
  // Room authoring belongs to games created in the app. A public GAME.JSON can
  // claim the flag, so it counts only when the authoring context travels with it.
  const roomGeneration =
    source !== "catalog" && game.project !== undefined && game.roomGeneration === true;
  const basePrefix = catalog
    ? `catalog-${catalog.id}`
    : known
      ? known.alias
      : `imported-${revision}`;
  const preferredId = catalog ? `${basePrefix}-${catalog.version}` : basePrefix;
  // Imported projects carry independent histories. Trusted catalog sources are repeatable fixtures.
  if (!game.project || source === "catalog") {
    const existing = listCachedGames().find((entry) => {
      const library = entry.library;
      return (
        library?.revision === revision &&
        entry.roomGeneration === roomGeneration &&
        (!catalog ||
          (library?.catalog?.id === catalog.id && library.catalog?.version === catalog.version))
      );
    });
    if (existing) return existing.projectId;
  }
  let targetProjectId = preferredId;
  if ((game.project && source !== "catalog") || (await loadAuthoredGame(targetProjectId))) {
    do targetProjectId = `${preferredId}-${crypto.randomUUID()}`;
    while (await loadAuthoredGame(targetProjectId));
  }
  const library: LibraryMetadata = {
    ...game.metadata,
    version: 1,
    ...(known?.alias ? { alias: known.alias } : {}),
    revision,
    source,
    ...(catalog ? { catalog } : {}),
    ...(known?.author && !game.metadata?.author ? { author: known.author } : {}),
    preview: opening.preview,
    validation: {
      status: opening.status,
      message: opening.message,
      profile: opening.profile || known?.profile,
    },
  };
  const effectiveTitle = game.title ?? known?.title ?? title;
  if (
    !(await saveAuthoredGame(targetProjectId, {
      title: effectiveTitle,
      library,
      provider: game.project?.provider ?? "stub",
      model: game.project?.model ?? "local-playback",
      transcript: game.project?.transcript,
      sessionId: game.project?.sessionId,
      authoringState: game.project?.authoringState,
      conversationHistory: game.project?.conversationHistory,
      roomGeneration,
      files: game.files,
      words: game.words,
      imported: true,
    }))
  )
    throw new Error(
      "Your browser could not save this game. Free some storage space and try again.",
    );
  if (game.progress) {
    const report = storeImportedProgress(localStorage, targetProjectId, revision, game.progress);
    onProgressStored?.(report);
  }
  return targetProjectId;
}

/** Copies keep provenance but have independent resources, history and save slots. */
export async function copyLibraryGame(projectId: ProjectId): Promise<ProjectId> {
  const original = await loadAuthoredGame(projectId);
  if (!original) throw new Error("This game is no longer in your library. Import it again.");
  let id: ProjectId;
  do id = `remix-${crypto.randomUUID()}`;
  while (await loadAuthoredGame(id));
  const revision = await gameRevision(original.files);
  if (
    !(await saveAuthoredGame(id, {
      ...original,
      title: `${original.title} Remix`,
      library: {
        ...original.library,
        version: 1,
        alias: undefined,
        revision,
        source: "remix",
        catalog: undefined,
        parent: {
          projectId: original.projectId,
          ...(original.library?.alias ? { alias: original.library.alias } : {}),
          revision,
        },
        validation: original.library?.validation ?? {
          status: "unverified",
          message: "Opening not checked yet.",
        },
      },
    }))
  )
    throw new Error("Your browser could not save the copy. Free some storage space and try again.");
  return id;
}
