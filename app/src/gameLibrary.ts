import {
  detectKnownGame,
  gameRevision,
  isLocalGamePreview,
  type LibraryMetadata,
} from "./gameMetadata.ts";
import { storeImportedProgress, type ImportStorageReport } from "./gameProgress.ts";
import { writeMapSidecar } from "./roomMapStore.ts";
import { importGameHistory } from "./historyStorage.ts";
import {
  loadAuthoredGame,
  saveAuthoredGame,
  listCachedGames,
  type ProjectId,
} from "./gameStorage.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { rebindStagedReferences } from "./referenceArt.ts";
import type { OpenedGame } from "./gameZip.ts";
import type { ProfileDetectionKind } from "../../src/runtime/profile.ts";

export interface CheckedOpening {
  preview: string;
  status: "ready" | "needs-input";
  message: string;
  profile: string;
  kind?: ProfileDetectionKind | undefined;
  build?: string | undefined;
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
  const preferredId = requireProjectId(catalog ? `${basePrefix}-${catalog.version}` : basePrefix);
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
    do targetProjectId = requireProjectId(`${preferredId}-${crypto.randomUUID()}`);
    while (await loadAuthoredGame(targetProjectId));
  }
  const library: LibraryMetadata = {
    ...game.metadata,
    version: 1,
    revision,
    source,
    ...(catalog ? { catalog } : {}),
    ...(known?.author && !game.metadata?.author ? { author: known.author } : {}),
    ...(game.profile ? { profile: game.profile } : {}),
    // A growing world published without its authoring context cannot grow
    // here: exits to unbuilt rooms stop the game.
    ...(game.roomGeneration === true && !roomGeneration ? { workInProgress: true as const } : {}),
    preview: opening.preview,
    validation: {
      status: opening.status,
      message: opening.message,
      profile: opening.profile || known?.profile,
      ...(opening.kind ? { kind: opening.kind } : {}),
      ...(opening.build ? { build: opening.build } : {}),
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
      // A staged candidate verified against these exact bytes rebinds to the
      // imported project — an already-stale one keeps its refusal.
      references: rebindStagedReferences(game.project?.references, {
        project: targetProjectId,
        revision,
      }),
      roomGeneration,
      files: game.files,
      words: game.words,
      imported: true,
    }))
  )
    throw new Error(
      "Your browser could not save this game. Free some storage space and try again.",
    );
  let report: ImportStorageReport | undefined;
  if (game.progress) {
    report = storeImportedProgress(localStorage, targetProjectId, revision, game.progress);
  }
  // The map travels with the project it was made under; storage refusal is
  // reported like progress, never silently dropped.
  if (game.map) {
    report ??= { slots: [], failedSlots: [], autosave: null };
    report.map = writeMapSidecar(localStorage, targetProjectId, game.map);
  }
  // The recorded tape too — the transport replays it under the imported
  // project id, and a refused write lands in the same report.
  if (game.history) {
    report ??= { slots: [], failedSlots: [], autosave: null };
    report.history = await importGameHistory(targetProjectId, game.history, {
      project: targetProjectId,
      revision,
    });
  }
  if (report) onProgressStored?.(report);
  return targetProjectId;
}

/** Copies keep provenance but have independent resources, history and save slots. */
export async function copyLibraryGame(projectId: ProjectId): Promise<ProjectId> {
  const original = await loadAuthoredGame(projectId);
  if (!original) throw new Error("This game is no longer in your library. Import it again.");
  let id: ProjectId;
  do id = requireProjectId(`remix-${crypto.randomUUID()}`);
  while (await loadAuthoredGame(id));
  const revision = await gameRevision(original.files);
  if (
    !(await saveAuthoredGame(id, {
      ...original,
      // The copy's bytes are identical, so every still-current staged
      // candidate verifies and rebinds; stale ones keep their refusal.
      references: rebindStagedReferences(
        original.references,
        { project: id, revision },
        { project: original.projectId, revision },
      ),
      title: `${original.title} Remix`,
      library: {
        ...original.library,
        version: 1,
        revision,
        source: "remix",
        catalog: undefined,
        parent: { project: original.projectId, revision },
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
