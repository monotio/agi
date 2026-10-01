import {
  detectKnownGame,
  gameRevision,
  isLocalGamePreview,
  type LibraryMetadata,
} from "../project/gameMetadata.ts";
import { storeImportedProgress, type ImportStorageReport } from "../saves/gameProgress.ts";
import { writeMapSidecar } from "../world/roomMapStore.ts";
import { importGameHistory } from "../history/historyStorage.ts";
import { bindSavedProgressTarget } from "../project/progressBinding.ts";
import {
  loadAuthoredGame,
  reconcileGameIndex,
  saveAuthoredGame,
  serializeWriteAction,
  listCachedGames,
  type ProjectId,
} from "../project/gameStorage.ts";
import { requireProjectId } from "../../../src/gameIdentity.ts";
import { rebindStagedReferences } from "../references/referenceArt.ts";
import type { OpenedGame } from "../archive/gameZip.ts";
import type { ProfileDetectionKind } from "../../../src/runtime/profile.ts";

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
  // A remix names its parent in GAME.JSON, and stays its own game wherever it
  // is imported: bytes it shares with its parent (or with the catalog card it
  // came from) never fold it into that entry, nor a plain import into it.
  const parent = game.metadata?.parent;
  const remix = parent !== undefined && source !== "catalog";
  const basePrefix = catalog
    ? `catalog-${catalog.id}`
    : remix
      ? "remix"
      : known
        ? known.alias
        : `imported-${revision}`;
  const preferredId = requireProjectId(catalog ? `${basePrefix}-${catalog.version}` : basePrefix);
  // Imported projects carry independent histories. Trusted catalog sources are repeatable fixtures.
  // The same bytes under another interpreter are another game to play: an
  // archive that declares an interpreter reuses only an entry with that
  // choice, so neither import silently changes the other's setting or saves.
  // An archive that declares none asks for nothing different, and keeps the
  // choice the player made for these bytes.
  if (!game.project || source === "catalog") {
    const existing = listCachedGames().find((entry) => {
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
    if (existing) return existing.projectId;
  }
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
    library,
    provider: game.project?.provider,
    model: game.project?.model,
    transcript: game.project?.transcript,
    sessionId: game.project?.sessionId,
    authoringState: game.project?.authoringState,
    conversationHistory: game.project?.conversationHistory,
    recoveryDraft: game.project?.recoveryDraft,
    workspace: game.project?.workspace,
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
  };
  if (game.project?.creative !== undefined || game.project?.creativeWork !== undefined) {
    // Creative assets are required transactionally with the native body:
    // the portable manifest, the durable-work envelope and their blob bytes
    // publish into a fresh catalog bound to this project — storage markers
    // and hold authority are derived at admission, never transplanted from
    // the archive's context.
    const { publishProjectWithCreative } = await import("../project/creativeProjectPublication.ts");
    const { warnings } = await publishProjectWithCreative({
      projectId: targetProjectId,
      data,
      creative: game.project.creative,
      work: game.project.creativeWork,
    });
    if (warnings.includes("indexRepairPending")) await reconcileGameIndex().catch(() => {});
  } else if (!(await saveAuthoredGame(targetProjectId, data)))
    throw new Error(
      "Your browser could not save this game. Free some storage space and try again.",
    );
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
      report = storeImportedProgress(localStorage, target, game.progress);
    } else {
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
  // A project with kept creative data is copied from one coherent capture:
  // the body and its assets come from the same snapshot, so the copy never
  // mixes a pre-Keep body with post-Keep blobs. A marker whose catalog is
  // missing or corrupt refuses here instead of copying a pin without data.
  // The capture claims this project's queue slot before the module import
  // suspends — a delete launched meanwhile serializes behind it — and the
  // capture's own per-project reads run inside the held turn it is handed,
  // never behind the action that owns it.
  const snapshot = await serializeWriteAction(projectId, async (turn) =>
    (await import("../project/creativeProjectSnapshot.ts")).captureCreativeProjectInTurn(
      turn,
      projectId,
    ),
  );
  const original = snapshot?.data ?? (await loadAuthoredGame(projectId));
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
    creative: _marker,
    ...rest
  } = original;
  const data = {
    ...rest,
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
  if (snapshot === null) {
    if (!(await saveAuthoredGame(id, data)))
      throw new Error(
        "Your browser could not save the copy. Free some storage space and try again.",
      );
  } else {
    const { publishProjectWithCreative } = await import("../project/creativeProjectPublication.ts");
    const { warnings } = await publishProjectWithCreative({
      projectId: id,
      data,
      ...(snapshot.manifest === null
        ? {}
        : { creative: { manifest: snapshot.manifest, blobs: snapshot.blobs } }),
      ...(snapshot.work === null
        ? {}
        : { work: { work: snapshot.work, blobs: snapshot.workBlobs } }),
    });
    if (warnings.includes("indexRepairPending")) await reconcileGameIndex().catch(() => {});
  }
  return id;
}
