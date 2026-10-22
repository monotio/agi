import {
  effectiveProjectCompatibility,
  projectConventions,
} from "../../../src/authoring/projectConventions.ts";
import { isAuxiliaryFileName } from "../../../src/container/playableFiles.ts";
import {
  detectKnownGame,
  gameRevision,
  isLocalGamePreview,
  type LibraryMetadata,
} from "../project/gameMetadata.ts";
import {
  storeImportedProgress,
  withCheckpointLock,
  type ImportStorageReport,
} from "../saves/gameProgress.ts";
import { writeMapSidecar } from "../world/roomMapStore.ts";
import { importGameHistory } from "../history/historyStorage.ts";
import { bindSavedProgressTarget } from "../project/progressBinding.ts";
import {
  ProjectExistsError,
  loadAuthoredGame,
  saveAuthoredGame,
  listCachedGames,
  type ProjectId,
} from "../project/gameStorage.ts";
import { requireProjectId } from "../../../src/gameIdentity.ts";
import { rebindStagedReferences } from "../references/referenceArt.ts";
import type { OpenedGame } from "../archive/gameZip.ts";
import type { ProfileDetectionKind } from "../../../src/runtime/profile.ts";

/** Publication must use the contract that passed inspection, even if another page changes the library. */
export class OpeningCompatibilityChangedError extends Error {
  constructor() {
    super("The opening settings changed. Import the game again.");
    this.name = "OpeningCompatibilityChangedError";
  }
}

export interface CheckedOpening {
  legacyRoomMemory?: boolean | undefined;
  preview: string;
  status: "ready" | "needs-input";
  message: string;
  profile: string;
  kind?: ProfileDetectionKind | undefined;
  build?: string | undefined;
}

/** Resolve the edition before inspection and again before publication. Raw reimports keep its contract. */
export async function resolveLibraryImport(
  game: OpenedGame,
  source: "zip" | "folder" | "catalog",
  catalog?: { id: string; version: string },
) {
  const known = await detectKnownGame(game.files);
  const revision = await gameRevision(game.files);
  const compatibility = effectiveProjectCompatibility(game, source);
  // Only private authoring context can enable room generation.
  const roomGeneration =
    source !== "catalog" && game.project !== undefined && game.roomGeneration === true;
  const parent = game.metadata?.parent;
  if (!game.project || source === "catalog") {
    const candidates = listCachedGames().filter((entry) => {
      const library = entry.library;
      return (
        library?.revision === revision &&
        (game.profile === undefined || library.profile === game.profile) &&
        entry.roomGeneration === roomGeneration &&
        library.parent?.project === parent?.project &&
        library.parent?.revision === parent?.revision &&
        (!catalog ||
          (library?.catalog?.id === catalog.id && library.catalog?.version === catalog.version))
      );
    });
    // Equal resource revisions can carry different player-owned fonts. Keep
    // those imports independently, without rewriting either edition's bytes.
    for (const existing of candidates) {
      const stored = await loadAuthoredGame(existing.projectId);
      if (!stored) continue;
      if (
        compatibility.specified &&
        compatibility.legacyRoomMemory !== effectiveProjectCompatibility(stored).legacyRoomMemory
      )
        continue;
      const names = new Set(
        [...Object.keys(stored.files), ...Object.keys(game.files)].filter(isAuxiliaryFileName),
      );
      if (
        [...names].every((name) => {
          const a = stored.files[name];
          const b = game.files[name];
          return a && b && a.length === b.length && a.every((byte, i) => byte === b[i]);
        })
      )
        return { known, revision, compatibility, roomGeneration, parent, existing: stored };
    }
  }
  return { known, revision, compatibility, roomGeneration, parent, existing: null };
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
  const { known, revision, compatibility, roomGeneration, parent, existing } =
    await resolveLibraryImport(game, source, catalog);
  const selectedCompatibility = existing ? effectiveProjectCompatibility(existing) : compatibility;
  if (
    opening.legacyRoomMemory !== undefined &&
    opening.legacyRoomMemory !== selectedCompatibility.legacyRoomMemory
  )
    throw new OpeningCompatibilityChangedError();
  if (existing) return existing.projectId;
  const remix = parent !== undefined && source !== "catalog";
  const basePrefix = catalog
    ? `catalog-${catalog.id}`
    : remix
      ? "remix"
      : known
        ? known.alias
        : `imported-${revision}`;
  const preferredId = requireProjectId(catalog ? `${basePrefix}-${catalog.version}` : basePrefix);
  let targetProjectId = preferredId;
  if (
    remix ||
    (game.project && source !== "catalog") ||
    (await loadAuthoredGame(targetProjectId))
  ) {
    do targetProjectId = requireProjectId(`${preferredId}-${crypto.randomUUID()}`);
    while (await loadAuthoredGame(targetProjectId));
  }
  const library: LibraryMetadata = {
    ...game.metadata,
    version: 1,
    revision,
    source: remix ? "remix" : source,
    ...(catalog ? { catalog } : {}),
    ...(known?.author && !game.metadata?.author ? { author: known.author } : {}),
    ...(game.profile ? { profile: game.profile } : {}),
    // An unfinished world stays marked through every import and export,
    // whether or not this copy may go on generating rooms.
    ...(game.workInProgress === true || game.roomGeneration === true
      ? { workInProgress: true as const }
      : {}),
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
  const data = {
    title: effectiveTitle,
    authoringConventions: compatibility.authoringConventions,
    library,
    provider: game.project?.provider,
    model: game.project?.model,
    transcript: game.project?.transcript,
    sessionId: game.project?.sessionId,
    authoringState: game.project?.authoringState,
    conversationHistory: game.project?.conversationHistory,
    recoveryDraft: game.project?.recoveryDraft,
    workspace: game.project?.workspace,
    projectHistory: game.project?.projectHistory,
    // A staged changes verified against these exact bytes rebinds to the
    // imported project — an already-stale one keeps its refusal.
    references: rebindStagedReferences(game.project?.references, {
      project: targetProjectId,
      revision,
    }),
    roomGeneration,
    files: game.files,
    words: game.words,
    imported: true,
  };
  for (;;) {
    try {
      data.references = rebindStagedReferences(game.project?.references, {
        project: targetProjectId,
        revision,
      });
      if (!(await saveAuthoredGame(targetProjectId, data, { requireNew: true })))
        throw new Error(
          "Your browser could not save this game. Free some storage space and try again.",
        );
      break;
    } catch (error) {
      if (!(error instanceof ProjectExistsError)) throw error;
      targetProjectId = requireProjectId(`${preferredId}-${crypto.randomUUID()}`);
    }
  }
  // Bind sidecars to the published body and its live lifetime receipt.
  // Each carried sidecar reports whether it reached this exact revision.
  const bound =
    game.progress !== undefined || game.map !== undefined || game.history !== undefined
      ? await bindSavedProgressTarget(targetProjectId)
      : null;
  const target = bound !== null && bound.identity.revision === revision ? bound : null;
  let report: ImportStorageReport | undefined;
  if (game.progress) {
    if (target !== null) {
      const progress = game.progress;
      report = await withCheckpointLock(target.locator, async () => {
        const live = await bindSavedProgressTarget(targetProjectId);
        return live?.locator === target.locator && live.identity.revision === revision
          ? storeImportedProgress(localStorage, live, progress)
          : undefined;
      });
    }
    if (report === undefined) {
      report = { slots: [], failedSlots: [], autosave: null };
      for (const slot of Object.keys(game.progress.saves)
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => a - b))
        report.failedSlots.push(slot);
    }
  }
  // The map travels with the project it was made under; storage refusal is
  // reported like progress, never silently dropped.
  if (game.map) {
    report ??= { slots: [], failedSlots: [], autosave: null };
    report.map = target !== null && writeMapSidecar(localStorage, target.locator, game.map);
  }
  // The recorded tape too — the transport replays it under the imported
  // project id, and a refused write lands in the same report.
  if (game.history) {
    report ??= { slots: [], failedSlots: [], autosave: null };
    report.history =
      target !== null && (await importGameHistory(target, game.history, target.bodyEpoch));
  }
  if (report) onProgressStored?.(report);
  return targetProjectId;
}

/** Copies keep provenance but have independent resources, history and save slots. */
export async function copyLibraryGame(projectId: ProjectId): Promise<ProjectId> {
  const original = await loadAuthoredGame(projectId);
  if (!original) throw new Error("This game is missing from your library. Import it again.");
  let id: ProjectId;
  do id = requireProjectId(`remix-${crypto.randomUUID()}`);
  while (await loadAuthoredGame(id));
  const revision = await gameRevision(original.files);
  // Storage authority never carries over: the copy's marker, generation and
  // lifetime are assigned at its own publication.
  const {
    projectId: _originalId,
    authoredAt: _authoredAt,
    generation: _generation,
    ...rest
  } = original;
  const data = {
    ...rest,
    authoringConventions: projectConventions(original),
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
      version: 1 as const,
      revision,
      source: "remix" as const,
      catalog: undefined,
      parent: { project: original.projectId, revision },
      validation: original.library?.validation ?? {
        status: "unverified" as const,
        message: "Ready to check.",
      },
    },
  };
  if (!(await saveAuthoredGame(id, data)))
    throw new Error("Your browser could not save the copy. Free some storage space and try again.");
  return id;
}
