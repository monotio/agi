import { gameRevision, isLocalGamePreview, type LibraryMetadata } from "./gameMetadata.ts";
import { storeImportedProgress, type ImportStorageReport } from "./gameProgress.ts";
import {
  loadAuthoredCartridge,
  saveAuthoredCartridge,
  listCachedCartridges,
} from "./cartridgeStorage.ts";
import type { OpenedGame } from "./gameZip.ts";

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
): Promise<string> {
  if (!isLocalGamePreview(opening.preview))
    throw new Error("The checked opening did not produce a local PNG preview.");
  if ((source === "catalog") !== Boolean(catalog))
    throw new Error("Catalog games require a catalog release identifier.");
  if (
    catalog &&
    (!/^[A-Za-z0-9._-]{1,80}$/.test(catalog.id) || !/^[A-Za-z0-9._+-]{1,80}$/.test(catalog.version))
  )
    throw new Error("The catalog release identifier is invalid.");
  const revision = await gameRevision(game.files);
  // Room authoring belongs to games created in the app. A public GAME.JSON can
  // claim the flag, so it counts only when the authoring context travels with it.
  const roomGeneration =
    source !== "catalog" && game.project !== undefined && game.roomGeneration === true;
  const gameId = catalog ? `catalog-${catalog.id}` : `imported-${revision}`;
  const preferredSlug = catalog ? `${gameId}-${catalog.version}` : gameId;
  // Imported projects carry independent histories. Trusted catalog sources are repeatable fixtures.
  if (!game.project || source === "catalog") {
    const existing = listCachedCartridges().find((entry) => {
      const library = entry.library;
      return (
        library?.gameId === gameId &&
        library.revision === revision &&
        entry.roomGeneration === roomGeneration &&
        (!catalog || library.catalog?.version === catalog.version)
      );
    });
    if (existing) return existing.slug;
  }
  let slug = preferredSlug;
  if ((game.project && source !== "catalog") || (await loadAuthoredCartridge(slug))) {
    do slug = `${preferredSlug}-${crypto.randomUUID()}`;
    while (await loadAuthoredCartridge(slug));
  }
  const library: LibraryMetadata = {
    ...game.metadata,
    version: 1,
    gameId,
    revision,
    source,
    ...(catalog ? { catalog } : {}),
    preview: opening.preview,
    validation: { status: opening.status, message: opening.message, profile: opening.profile },
  };
  if (
    !(await saveAuthoredCartridge(slug, {
      title: game.title ?? title,
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
    const report = storeImportedProgress(localStorage, slug, revision, game.progress);
    onProgressStored?.(report);
  }
  return slug;
}

/** Copies keep provenance but have independent resources, history and save slots. */
export async function copyLibraryGame(slug: string): Promise<string> {
  const original = await loadAuthoredCartridge(slug);
  if (!original) throw new Error("This game is no longer in your library. Import it again.");
  let id: string;
  do id = `remix-${crypto.randomUUID()}`;
  while (await loadAuthoredCartridge(id));
  const revision = await gameRevision(original.files);
  if (
    !(await saveAuthoredCartridge(id, {
      ...original,
      title: `${original.title} Remix`,
      library: {
        ...original.library,
        version: 1,
        gameId: id,
        revision,
        source: "remix",
        catalog: undefined,
        parent: { gameId: original.library?.gameId ?? original.slug, revision },
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
