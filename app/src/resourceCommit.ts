/**
 * The durable resource transaction behind every Keep — a staged reference
 * view, a Room Studio picture: the edited bytes, the source that describes
 * them, the stored project and the live worker move together or not at all.
 * The authoring controller owns the session and wires this in; the edit
 * descriptors below say what each Keep writes.
 */
import { AgentSession } from "./agent/agentSession.ts";
import { gameRevision, type LibraryMetadata } from "./gameMetadata.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import { resourceCacheHint } from "../../src/agent/authoringState.ts";
import type { AgentSourceStore } from "../../src/agent/tools.ts";
import { sourceCompilesTo } from "../../src/picture/source.ts";
import { roomDrawsPicture } from "../../src/agent/roomPictures.ts";
import type { AgiProfile } from "../../src/runtime/profile.ts";
import {
  loadAuthoredGameWithHistoryLifetime,
  loadGameConversation,
  saveAuthoredGameWithLifetime,
  saveGameConversation,
  type CachedGameData,
} from "./gameStorage.ts";
import { stagedRefusal, type StoredReference } from "./referenceArt.ts";
import { gameStorageKey, type BootedGame } from "./gameTypes.ts";
import {
  projectId,
  requireProjectId,
  type ProjectId,
  type ResourceRevision,
} from "../../src/gameIdentity.ts";
import type { PatchKind, WorkerInbound, WorkerQueryFn } from "./workerProtocol.ts";
import type { AwaitPatchedFn } from "./workerQueries.ts";
import { base64ToBytes } from "./bytes.ts";

/** Why a resource commit refused or failed; `code` picks the UI's wording. */
export type ResourceCommitErrorCode =
  /** An agent turn, a history adoption or another commit owns the session. */
  | "busy"
  /** The booted, stored or running game is not at the edit's base revision. */
  | "stale"
  /** The edit itself is unusable (its source does not compile to its bytes). */
  | "invalid"
  /** Browser storage refused the conditional write; nothing changed. */
  | "storage"
  /** The edit is saved, but the running game did not install it. */
  | "install";

export class ResourceCommitError extends Error {
  readonly code: ResourceCommitErrorCode;
  /** The project the edit was saved to — set on `install` failures. */
  readonly projectId: ProjectId | undefined;
  constructor(code: ResourceCommitErrorCode, message: string, savedTo?: ProjectId) {
    super(message);
    this.name = "ResourceCommitError";
    this.code = code;
    this.projectId = savedTo;
  }
}

export interface ResourceCommitResult {
  /** "unchanged": the bytes and source already matched — nothing was written. */
  status: "committed" | "unchanged";
  /** The project now holding the edit — a new remix after a fork. */
  projectId: ProjectId | null;
  /** The resource revision of the committed files. */
  revision: ResourceRevision;
}

/** Room Studio's Keep request: new PIC bytes and the source that compiles to them. */
export interface PictureEdit {
  pictureNumber: number;
  bytes: Uint8Array;
  /** Annotated PIC source; must compile to exactly `bytes`. */
  source: string;
  /** The booted resource revision Studio opened on. */
  baseRevision: ResourceRevision;
  /** A short description for the agent log. */
  reason?: string | undefined;
}

/** One resource edit as a resource commit applies it. */
export interface ResourceEdit {
  /** Names the edit in refusals: "a staged view", "the picture edit". */
  readonly what: string;
  /** Pause owner for the transaction. */
  readonly owner: string;
  /** The revision the edit was made against; defaults to the booted one. */
  readonly baseRevision?: ResourceRevision | undefined;
  /**
   * Re-enter the room the game stands in after the install when this says
   * the room shows the edit, judged on the edited files.
   */
  readonly reenter?:
    | ((room: number, files: ReadonlyMap<string, Uint8Array>, profile: AgiProfile) => boolean)
    | undefined;
  /** Read the edit against the freshly loaded project record; throw to refuse. */
  resolve(stored: CachedGameData | null): {
    kind: PatchKind;
    num: number;
    payload: Uint8Array;
    /** Record the edit's source; true when it differs from the stored one. */
    stage: (sources: AgentSourceStore) => boolean;
    /** The project's reference list after the edit (a spent staged offer). */
    references?: StoredReference[] | undefined;
  };
  /** Refuse before anything is written, given the session describing the bytes. */
  validate?(author: AgentSession): void;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** What a resource commit reads and drives; the authoring controller supplies it. */
export interface ResourceCommitContext {
  readonly state: { readonly powerUp: { busy: boolean; readonly mode: string } };
  readonly getWorker: () => Worker | null;
  readonly query: WorkerQueryFn;
  readonly awaitPatched: AwaitPatchedFn;
  readonly pauseEngine: (owner: string) => void;
  readonly resumeEngine: (owner: string) => void;
  readonly getBootedGame: () => BootedGame | null;
  readonly setBootedGame: (game: BootedGame | null) => void;
  readonly getAutosaveWrite: () => Promise<boolean>;
  readonly flushAutosave: (timeoutMs?: number) => Promise<unknown>;
  readonly clearAutosave: (targetKey: string) => void;
  readonly onRemixCreated?: ((remixProjectId: ProjectId) => void) | undefined;
  /** The live authoring session, when one is attached. */
  readonly getSession: () => AgentSession | null;
  /** Post a session's authoring state as the tape's checkpoint. */
  readonly postSessionSnapshot: (author: AgentSession) => void;
  /** The commit landed everywhere; `author` is the live session, if any. */
  readonly onCommitted: (author: AgentSession | null) => void;
}

export function createResourceCommit(
  ctx: ResourceCommitContext,
): (edit: ResourceEdit) => Promise<ResourceCommitResult> {
  const {
    state,
    getWorker,
    query,
    awaitPatched,
    pauseEngine,
    resumeEngine,
    getBootedGame,
    setBootedGame,
    getAutosaveWrite,
    flushAutosave,
    clearAutosave,
    onRemixCreated,
    getSession,
    postSessionSnapshot,
    onCommitted,
  } = ctx;

  /**
   * The one durable resource transaction behind every Keep — a staged view,
   * a Room Studio picture — in this order:
   *
   * 1. refuse while an agent turn runs; reserve the session; pause the game;
   * 2. refuse unless the booted game, the stored project (same lifetime) and
   *    the live worker's export all sit at `baseRevision`;
   * 3. build the edited files and the session state recording the edit's
   *    source, and validate both — nothing is written yet;
   * 4. write bytes, source and project fields in one conditional save
   *    (catalog entries and installed editions fork into a new remix);
   * 5. install the bytes in the worker and wait for its ack naming them;
   * 6. adopt the session and booted identity, re-enter the room when the
   *    edit shows there, post the tape's authoring checkpoint, and take a
   *    fresh autosave under the new revision.
   *
   * Steps 1–3 refuse with nothing changed; a refused save (step 4) leaves
   * storage as it was. After step 4 the stored project is the source of
   * truth, and nothing is half-applied:
   * - A reload between the save and the install boots the stored project,
   *   which already holds bytes and source together. The tape never saw the
   *   patch, so it still matches what ran; the autosave taken before the
   *   edit names the old revision, so the resume offer refuses it instead of
   *   restoring state onto new bytes. A fork's remix sits in the library
   *   while the reload reopens the untouched catalog entry or edition.
   * - A failed install (step 5) throws `install` and leaves the live game,
   *   session and booted identity on the old revision, so the next commit
   *   refuses as stale; the worker's refusal also raises its session error.
   *   Reloading the game from storage picks the saved edit up.
   */
  async function commitResourceEdit(edit: ResourceEdit): Promise<ResourceCommitResult> {
    const game = getBootedGame();
    if (!game) throw new ResourceCommitError("stale", "No game is running.");
    const { what } = edit;
    if (state.powerUp.busy || state.powerUp.mode === "room")
      throw new ResourceCommitError(
        "busy",
        `Wait for the current agent turn before keeping ${what}.`,
      );
    const author = getSession();
    let release: (() => void) | undefined;
    try {
      release = author?.reserveMutation(
        `Finish keeping ${what} before starting another operation.`,
      );
    } catch (error) {
      throw new ResourceCommitError("busy", error instanceof Error ? error.message : String(error));
    }
    const powerUp = state.powerUp;
    powerUp.busy = true;
    pauseEngine(edit.owner);
    try {
      const baseRevision = edit.baseRevision ?? game.revision;
      if (game.revision !== baseRevision)
        throw new ResourceCommitError(
          "stale",
          `The game changed since ${what} was made — reopen it before keeping ${what}.`,
        );
      await getAutosaveWrite();
      let stored: CachedGameData | null = null;
      let lifetime: string | null = null;
      if (!game.installed) {
        const captured = await loadAuthoredGameWithHistoryLifetime(game.projectId!);
        if (!captured)
          throw new ResourceCommitError(
            "stale",
            "The project is no longer stored in this browser.",
          );
        ({ data: stored, lifetime } = captured);
        if (
          lifetime === null ||
          (game.historyLifetime !== undefined && game.historyLifetime !== lifetime)
        )
          throw new ResourceCommitError(
            "stale",
            `The project was removed or changed elsewhere — reload it before keeping ${what}.`,
          );
        if ((await gameRevision(stored.files)) !== baseRevision)
          throw new ResourceCommitError(
            "stale",
            `The project changed elsewhere since this game booted — reload it before keeping ${what}.`,
          );
      }
      const resolved = edit.resolve(stored);
      const worker = getWorker();
      if (!worker)
        throw new ResourceCommitError("stale", "The running game is no longer available.");
      const moved = () =>
        getBootedGame() !== game || getSession() !== author || getWorker() !== worker;
      const exported = await query("exportFiles");
      const room = edit.reenter === undefined ? undefined : (await query("state"))?.room;
      if (!exported || moved())
        throw new ResourceCommitError("stale", `The game changed while ${what} was being kept.`);
      if ((await gameRevision(exported)) !== baseRevision)
        throw new ResourceCommitError(
          "stale",
          `The running game changed before ${what} could be kept.`,
        );

      const { kind, num, payload } = resolved;
      const container = openContainer(new Map(Object.entries(exported)));
      const current = container.getResource(kind, num);
      const bytesChanged = !current || !sameBytes(current, payload);
      if (bytesChanged) container.putResource(kind, num, payload);
      const files = Object.fromEntries(container.files);
      const words = files["WORDS.TOK"]
        ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [word, id] as [string, number])
        : game.words;
      const revision = bytesChanged ? await gameRevision(files) : baseRevision;
      const conversationKey = game.hash ?? game.alias ?? "installed";
      const conversation =
        game.installed && !author ? await loadGameConversation(conversationKey) : undefined;
      const sourceSession =
        author ??
        AgentSession.fromAuthoredData(
          { provider: "stub", model: "offline-stub", apiKey: "" },
          () => {},
          exported,
          words,
          stored?.transcript ?? conversation?.transcript,
          stored?.sessionId ?? conversation?.sessionId,
          stored?.authoringState ?? conversation?.authoringState,
          stored?.library?.profile,
        );
      edit.validate?.(sourceSession);
      const candidate = sourceSession.prepareSourcePatch(files, resolved.stage);
      if (!bytesChanged && !candidate.changed && resolved.references === undefined)
        return { status: "unchanged", projectId: game.projectId ?? null, revision };

      // The conversation a new record carries: the live session's, else
      // an installed edition's stored discussion as it stands.
      const context = conversation
        ? {
            provider: conversation.provider,
            model: conversation.model,
            transcript: conversation.transcript,
            sessionId: conversation.sessionId,
          }
        : {
            ...sourceSession.getProviderContext(),
            transcript: sourceSession.getTranscript(),
            sessionId: sourceSession.getSessionId(),
          };
      const forkCatalog =
        stored?.library?.source === "catalog" && stored.library.revision !== revision;
      const forkInstalled = game.installed && bytesChanged;
      const targetId =
        forkCatalog || forkInstalled
          ? requireProjectId(`remix-${crypto.randomUUID()}`)
          : (game.projectId ?? null);
      const parentProject = game.projectId ?? projectId(gameStorageKey(game)) ?? undefined;
      const remixLibrary = (library: LibraryMetadata | undefined): LibraryMetadata => ({
        ...library,
        version: 1,
        source: "remix",
        catalog: undefined,
        preview: undefined,
        parent: parentProject ? { project: parentProject, revision: baseRevision } : undefined,
        revision,
        validation: {
          status: "unverified",
          message: "Remixed resources. Check the opening to create a new preview.",
        },
      });
      let data: CachedGameData | null = null;
      if (stored) {
        const references = resolved.references ?? stored.references;
        data = {
          ...stored,
          files,
          words,
          references,
          authoringState: candidate.authoringState,
          ...(forkCatalog
            ? {
                projectId: targetId!,
                title: `${stored.title} Remix`,
                imported: true,
                roomGeneration: false,
                library: remixLibrary(stored.library),
                references: references?.map((r) => ({
                  ...r,
                  origin: r.origin ?? r.attachedAt,
                  attachedAt: { ...r.attachedAt, project: targetId! },
                })),
              }
            : {}),
          ...(author ? context : {}),
        };
      } else if (forkInstalled) {
        data = {
          projectId: targetId!,
          authoredAt: new Date().toISOString(),
          title: `${game.title} Remix`,
          library: remixLibrary(undefined),
          files,
          words,
          ...context,
          authoringState: candidate.authoringState,
          imported: true,
          roomGeneration: false,
        };
      }
      if (moved())
        throw new ResourceCommitError("stale", `The game changed while ${what} was being kept.`);

      // One conditional write: a fork must be new, an in-place edit must
      // find the generation and lifetime it read. An installed edition's
      // source-only edit lands in its conversation record.
      let historyLifetime = game.historyLifetime;
      if (data) {
        historyLifetime = await saveAuthoredGameWithLifetime(
          targetId!,
          data,
          targetId !== game.projectId
            ? { requireNew: true }
            : { expectedGeneration: stored!.generation ?? 0, expectedLifetime: lifetime },
        );
        if (historyLifetime === null)
          throw new ResourceCommitError(
            "storage",
            `Browser storage could not save ${what}. The project may have changed elsewhere; reload it before trying again.`,
          );
      } else {
        try {
          await saveGameConversation(conversationKey, {
            ...context,
            authoringState: candidate.authoringState,
          });
        } catch {
          throw new ResourceCommitError("storage", `Browser storage could not save ${what}.`);
        }
      }

      // Navigating away during the write keeps the durable result for the
      // next boot; it must never patch a replacement worker or its game.
      const result: ResourceCommitResult = { status: "committed", projectId: targetId, revision };
      if (moved()) return result;
      if (bytesChanged) {
        const transfer = new Uint8Array(payload);
        const acked = awaitPatched(kind, num, resourceCacheHint(payload));
        worker.postMessage(
          { type: "patch", kind, num, payload: transfer } satisfies WorkerInbound,
          [transfer.buffer],
        );
        try {
          await acked;
        } catch (error) {
          throw new ResourceCommitError(
            "install",
            `${what[0]!.toUpperCase()}${what.slice(1)} was saved, but the running game could not load it (${error instanceof Error ? error.message : String(error)}). Reload the game to continue from the saved project.`,
            targetId ?? undefined,
          );
        }
        if (moved()) return result;
      }

      // The worker holds the saved bytes: the session, the booted identity
      // and the tape follow with no await between them.
      candidate.adopt();
      // A fork runs on as its remix: same worker and tape, new identity.
      const adoptedGame: BootedGame =
        targetId === game.projectId
          ? game
          : game.installed
            ? {
                installed: false,
                projectId: targetId!,
                historyLifetime: historyLifetime ?? null,
                alias: game.alias,
                title: data!.title,
                revision,
                files,
                words,
              }
            : {
                ...game,
                projectId: targetId!,
                title: data!.title,
                historyLifetime: historyLifetime ?? null,
              };
      adoptedGame.files = files;
      adoptedGame.words = words;
      adoptedGame.revision = revision;
      if (data) adoptedGame.authoredGame = data;
      if (adoptedGame !== game) {
        clearAutosave(gameStorageKey(game));
        setBootedGame(adoptedGame);
        onRemixCreated?.(targetId!);
      }
      if (
        bytesChanged &&
        room !== undefined &&
        edit.reenter?.(room, container.files, sourceSession.state.profile)
      )
        worker.postMessage({ type: "reenter", room } satisfies WorkerInbound);
      postSessionSnapshot(sourceSession);
      onCommitted(author);
      // The checkpoint follows the new revision now: a resume offer never
      // pairs the edited bytes with a snapshot taken before them.
      if (bytesChanged) await flushAutosave(2000);
      return result;
    } finally {
      release?.();
      powerUp.busy = false;
      resumeEngine(edit.owner);
    }
  }

  return commitResourceEdit;
}

/** Keep a staged reference VIEW: its bytes, its build input and the spent offer. */
export function stagedViewEdit(game: BootedGame, id: string): ResourceEdit {
  return {
    what: "a staged view",
    owner: "keepView",
    resolve: (stored) => {
      const reference = stored?.references?.find((r) => r.id === id);
      if (!reference)
        throw new ResourceCommitError(
          "stale",
          "That reference is no longer attached to this project.",
        );
      const refusal = stagedRefusal(reference, {
        project: game.projectId!,
        revision: game.revision,
      });
      if (refusal) throw new ResourceCommitError("stale", refusal);
      const staged = reference.staged!;
      return {
        kind: "view",
        num: staged.num,
        payload: new Uint8Array(base64ToBytes(staged.payload)),
        stage: (sources) => {
          sources.views.set(staged.num, structuredClone(staged.input));
          return true;
        },
        references: stored!.references!.map((r) => (r.id === id ? { ...r, staged: undefined } : r)),
      };
    },
  };
}

/**
 * Keep a Room Studio picture: the edited PIC bytes and the annotated source
 * that compiles to exactly them. The live room re-enters when its own logic
 * provably draws the picture (its static scan), whatever its number.
 */
export function pictureEdit(edit: PictureEdit): ResourceEdit {
  const { pictureNumber: num, source, baseRevision } = edit;
  const payload = new Uint8Array(edit.bytes);
  return {
    what: "the picture edit",
    owner: "studioCommit",
    baseRevision,
    reenter: (room, files, profile) => roomDrawsPicture(files, room, num, profile),
    resolve: () => {
      if (!Number.isInteger(num) || num < 0 || num > 255)
        throw new ResourceCommitError("invalid", `Picture ${num} is not a resource number.`);
      return {
        kind: "picture",
        num,
        payload,
        stage: (sources) => {
          const before = sources.pictures.get(num);
          sources.pictures.set(num, source);
          return before !== source;
        },
      };
    },
    validate: (author) => {
      if (!sourceCompilesTo(source, payload, author.state.profile))
        throw new ResourceCommitError(
          "invalid",
          "The picture text does not compile to the edited picture.",
        );
    },
  };
}
