/**
 * The durable resource transaction behind every Keep — a staged reference
 * view, a Room Studio picture, a Sprite Studio view: the edited bytes, the source that describes
 * them, the stored project and the live worker move together or not at all.
 * The authoring controller owns the session and wires this in; the edit
 * descriptors below say what each Keep writes.
 */
import type { AgentSession } from "./agent/agentSession.ts";
import type { AuthoringLoader } from "./agent/authoringLoader.ts";
import { gameRevision, type LibraryMetadata } from "./gameMetadata.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { openContainer } from "../../src/container/container.ts";
import {
  resourceCacheHint,
  type AuthoringState,
  type BindingKind,
} from "../../src/agent/authoringState.ts";
import { assembleAuthoredLogic, type AgentSourceStore } from "../../src/agent/agentState.ts";
import { sourceCompilesTo } from "../../src/picture/source.ts";
import { roomDrawsPicture } from "../../src/agent/roomPictures.ts";
import { roomBakesView, scanViewUsage } from "../../src/studio/sprite/spriteUsage.ts";
import { viewSpec } from "../../src/view/celEdit.ts";
import type { BuildViewInput } from "../../src/view/view.ts";
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
  /**
   * The stored project moved past the running game (another tab kept an
   * edit): reopening on the running game would edit bytes storage no longer
   * holds, so only reloading the game from storage continues.
   */
  readonly behindStorage: boolean;
  constructor(
    code: ResourceCommitErrorCode,
    message: string,
    detail: { savedTo?: ProjectId | undefined; behindStorage?: boolean } = {},
  ) {
    super(message);
    this.name = "ResourceCommitError";
    this.code = code;
    this.projectId = detail.savedTo;
    this.behindStorage = detail.behindStorage === true;
  }
}

/**
 * How long a Keep waits for the running game to acknowledge the installed
 * bytes. The edit is already saved by then; a missing ack becomes the
 * `install` failure and its reload, never an endless "Keeping…".
 */
const PATCH_ACK_TIMEOUT_MS = 10_000;

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

/** Sprite Studio's Keep request: new VIEW bytes, decoded and re-encoded by the sprite kernel. */
export interface ViewEdit {
  viewNumber: number;
  bytes: Uint8Array;
  /** The booted resource revision Sprite Studio opened on. */
  baseRevision: ResourceRevision;
  /** A short description for the agent log. */
  reason?: string | undefined;
}

/**
 * Room Studio's combined Keep: the picture and the room's LOGIC in one
 * transaction — a door box that follows the doorway art moves with it, or
 * neither lands. Either part may be absent (a door edit alone, a picture
 * edit alone); the logic source must assemble to exactly its bytes with the
 * game's bindings plus the ones the rule edits reserved.
 */
export interface RoomEdit {
  /** The room whose logic is edited (logic N is room N). */
  room: number;
  picture?: { pictureNumber: number; bytes: Uint8Array; source: string } | undefined;
  logic?:
    | {
        bytes: Uint8Array;
        /** Annotated logic source (`// @rule` fragments); must assemble to `bytes`. */
        source: string;
        /** Flag names the rule edits reserved; added to the authoring bindings. */
        newBindings: Readonly<Record<string, { kind: BindingKind; num: number }>>;
      }
    | undefined;
  baseRevision: ResourceRevision;
  reason?: string | undefined;
}

/** One resource a commit writes and installs. */
interface ResourcePatch {
  readonly kind: PatchKind;
  readonly num: number;
  readonly payload: Uint8Array;
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
   * the room shows the edit, judged on the edited files and the resources
   * whose bytes actually changed.
   */
  readonly reenter?:
    | ((
        room: number,
        files: ReadonlyMap<string, Uint8Array>,
        profile: AgiProfile,
        changed: readonly ResourcePatch[],
      ) => boolean)
    | undefined;
  /** Read the edit against the freshly loaded project record; throw to refuse. */
  resolve(stored: CachedGameData | null): {
    /** The resources the edit writes, installed by the worker as one set under one ack. */
    patches: readonly ResourcePatch[];
    /**
     * Record the edit's source (and any bindings it reserved) on the
     * candidate session state; true when that differs from what it held.
     */
    stage: (sources: AgentSourceStore, authoring: AuthoringState) => boolean;
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
  /** Loads the authoring stack, whose session records a Keep made without a live one. */
  readonly loadAuthoring: AuthoringLoader;
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
    loadAuthoring,
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
   * 5. install the changed resources in the worker as one all-or-nothing
   *    patch and wait for its ack naming each resource's bytes (a Room
   *    Studio Keep installs a picture and a logic together);
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
   * - A refused install (step 5) leaves every resource of the set on its
   *   old bytes in the worker; a missing ack within PATCH_ACK_TIMEOUT_MS
   *   may still land the whole set later. Either way the commit throws
   *   `install` and leaves the session and booted identity on the old
   *   revision, so the next commit refuses as stale, and marks the booted
   *   game `behindStorage`: no autosave or download writes its files over
   *   the saved edit until the game reloads from storage, which picks the
   *   edit up. The worker's refusal also raises its session error.
   * - A game, session or worker replaced after the save (step 4) never
   *   takes the edit: that is an `install` failure too, never "committed".
   * - A stored project that moved past the running game (step 2: another
   *   tab kept an edit) refuses as `stale` with `behindStorage`: the only
   *   way on is the same reload from storage.
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
        // Storage moved past the running game: its files must not be
        // written back over the newer record until the game reloads.
        const behind = (message: string) => {
          game.behindStorage = true;
          return new ResourceCommitError("stale", message, { behindStorage: true });
        };
        if (
          lifetime === null ||
          (game.historyLifetime !== undefined && game.historyLifetime !== lifetime)
        )
          throw behind(
            `The project was removed or changed elsewhere — reload it before keeping ${what}.`,
          );
        if ((await gameRevision(stored.files)) !== baseRevision)
          throw behind(
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

      const container = openContainer(new Map(Object.entries(exported)));
      // Only the resources whose bytes differ are written and installed.
      const changed = resolved.patches.filter(({ kind, num, payload }) => {
        const current = container.getResource(kind, num);
        return !current || !sameBytes(current, payload);
      });
      const bytesChanged = changed.length > 0;
      for (const { kind, num, payload } of changed) container.putResource(kind, num, payload);
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
        (await loadAuthoring()).AgentSession.fromAuthoredData(
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
      // A catalog entry stays as shipped: its first edit of any kind — bytes,
      // or only the source text and bindings that describe them — forks.
      const forkCatalog = stored?.library?.source === "catalog";
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
      // The running game did not take the edit, so it is not reported kept.
      const notInstalled = () => {
        game.behindStorage = true;
        return new ResourceCommitError(
          "install",
          `${what[0]!.toUpperCase()}${what.slice(1)} was saved, but the game changed before it could load it. Reload the game to continue from the saved project.`,
          { savedTo: targetId ?? undefined },
        );
      };
      const result: ResourceCommitResult = { status: "committed", projectId: targetId, revision };
      if (moved()) throw notInstalled();
      if (bytesChanged) {
        // One patch carries every changed resource: the worker installs the
        // set or none of it, and its one ack names each resource's bytes.
        // The waiter is armed before the patch is posted.
        const acked = awaitPatched(
          changed.map(({ kind, num, payload }) => ({
            kind,
            num,
            hint: resourceCacheHint(payload),
          })),
          PATCH_ACK_TIMEOUT_MS,
        );
        const resources = changed.map(({ kind, num, payload }) => ({
          kind,
          num,
          payload: new Uint8Array(payload),
        }));
        worker.postMessage(
          { type: "patch", resources } satisfies WorkerInbound,
          resources.map(({ payload }) => payload.buffer),
        );
        try {
          await acked;
        } catch (error) {
          // A refusal left the worker on the old bytes, but an ack that timed
          // out may still land: until the game reloads from storage, nothing
          // may write the running game's files back over the saved edit.
          game.behindStorage = true;
          throw new ResourceCommitError(
            "install",
            `${what[0]!.toUpperCase()}${what.slice(1)} was saved, but the running game could not load it (${error instanceof Error ? error.message : String(error)}). Reload the game to continue from the saved project.`,
            { savedTo: targetId ?? undefined },
          );
        }
        if (moved()) throw notInstalled();
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
        edit.reenter?.(room, container.files, sourceSession.state.profile, changed)
      )
        worker.postMessage({ type: "reenter", room } satisfies WorkerInbound);
      postSessionSnapshot(sourceSession);
      onCommitted(author);
      // The checkpoint follows the new revision now: a resume offer never
      // pairs the edited bytes with a snapshot taken before them. A fork
      // takes its first checkpoint under the remix's own key at once.
      if (bytesChanged || adoptedGame !== game) await flushAutosave(2000);
      return result;
    } finally {
      release?.();
      powerUp.busy = false;
      resumeEngine(edit.owner);
    }
  }

  return commitResourceEdit;
}

/**
 * Keep a staged reference VIEW: its bytes, its build input and the spent
 * offer. `repaired` is the candidate as Sprite Studio left it: those bytes
 * are kept instead, with the spec read back from them.
 */
export function stagedViewEdit(
  game: BootedGame,
  id: string,
  repaired?: { bytes: Uint8Array; baseRevision: ResourceRevision },
): ResourceEdit {
  const payload = repaired && new Uint8Array(repaired.bytes);
  /** The repaired bytes' spec, read back once `validate` has the game's profile. */
  let spec: BuildViewInput | undefined;
  return {
    what: "a staged view",
    owner: "keepView",
    baseRevision: repaired?.baseRevision,
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
        patches: [
          {
            kind: "view",
            num: staged.num,
            payload: payload ?? new Uint8Array(base64ToBytes(staged.payload)),
          },
        ],
        stage: (sources) => {
          sources.views.set(staged.num, spec ?? structuredClone(staged.input));
          return true;
        },
        references: stored!.references!.map((r) => (r.id === id ? { ...r, staged: undefined } : r)),
      };
    },
    ...(payload && {
      validate: (author: AgentSession) => {
        spec = editedViewSpec(payload, author.state.profile);
      },
    }),
  };
}

/** The spec of edited VIEW bytes; refused when the game's interpreter cannot decode them. */
function editedViewSpec(payload: Uint8Array, profile: AgiProfile): BuildViewInput {
  try {
    return viewSpec(payload, profile);
  } catch (error) {
    throw new ResourceCommitError(
      "invalid",
      `The edited view does not decode (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
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
        patches: [{ kind: "picture", num, payload }],
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

/**
 * Keep Room Studio's picture and room logic together: the edited PIC with
 * the annotated text that compiles to it, and the room's LOGIC with the
 * annotated source that assembles to it (door and edge exit rules), plus the
 * flag bindings the rule edits reserved. Both install in one all-or-nothing
 * patch, or neither does. The room re-enters when the picture changed and its
 * logic draws it; rule changes are per-cycle, so a logic change alone runs
 * from the next cycle.
 */
export function roomEdit(edit: RoomEdit): ResourceEdit {
  const { room, picture, logic, baseRevision } = edit;
  const pictureBytes = picture && new Uint8Array(picture.bytes);
  const logicBytes = logic && new Uint8Array(logic.bytes);
  return {
    what: "the room edit",
    owner: "studioCommit",
    baseRevision,
    reenter: (current, files, profile, changed) =>
      picture !== undefined &&
      changed.some((patch) => patch.kind === "picture") &&
      roomDrawsPicture(files, current, picture.pictureNumber, profile),
    resolve: () => {
      if (!Number.isInteger(room) || room < 1 || room > 255)
        throw new ResourceCommitError("invalid", `Room ${room} is not a room number.`);
      if (!picture && !logic) throw new ResourceCommitError("invalid", "The room edit is empty.");
      const num = picture?.pictureNumber ?? 0;
      if (picture && (!Number.isInteger(num) || num < 0 || num > 255))
        throw new ResourceCommitError("invalid", `Picture ${num} is not a resource number.`);
      return {
        patches: [
          ...(pictureBytes ? [{ kind: "picture" as const, num, payload: pictureBytes }] : []),
          ...(logicBytes ? [{ kind: "logic" as const, num: room, payload: logicBytes }] : []),
        ],
        stage: (sources, authoring) => {
          let changed = false;
          if (picture) {
            changed ||= sources.pictures.get(num) !== picture.source;
            sources.pictures.set(num, picture.source);
          }
          if (logic) {
            changed ||= sources.logics.get(room) !== logic.source;
            sources.logics.set(room, logic.source);
            for (const [name, binding] of Object.entries(logic.newBindings)) {
              if (authoring.bindings[name]) continue;
              authoring.bindings[name] = { ...binding };
              changed = true;
            }
          }
          return changed;
        },
      };
    },
    validate: (author) => {
      const { profile } = author.state;
      if (picture && !sourceCompilesTo(picture.source, pictureBytes!, profile))
        throw new ResourceCommitError(
          "invalid",
          "The picture text does not compile to the edited picture.",
        );
      if (!logic) return;
      const bindings = { ...author.state.authoring.bindings };
      for (const [name, binding] of Object.entries(logic.newBindings)) {
        const held = bindings[name];
        if (held && (held.kind !== binding.kind || held.num !== binding.num))
          throw new ResourceCommitError(
            "invalid",
            `The name '${name}' now means ${held.kind} ${held.num}; reopen Studio and edit the door again.`,
          );
        bindings[name] = binding;
      }
      let assembled: Uint8Array;
      try {
        assembled = assembleAuthoredLogic(
          { profile, authoring: { bindings }, sources: { words: author.state.sources.words } },
          logic.source,
        ).payload;
      } catch (error) {
        throw new ResourceCommitError(
          "invalid",
          `The room's logic does not assemble (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
      if (!sameBytes(assembled, logicBytes!))
        throw new ResourceCommitError(
          "invalid",
          "The room's logic text does not assemble to the edited logic.",
        );
    },
  };
}

/**
 * Keep a Sprite Studio view: the edited VIEW bytes, with `sources.views`
 * following them as the spec read back from the bytes. Animated objects pick
 * the new cels up from the install itself (Engine.patchResource re-parses a
 * loaded view in place); the live room re-enters only when entering it bakes
 * the view into its picture with add.to.pic (spriteUsage.ts `roomBakesView`).
 */
export function viewEdit(edit: ViewEdit): ResourceEdit {
  const { viewNumber: num, baseRevision } = edit;
  const payload = new Uint8Array(edit.bytes);
  /** The bytes' spec, read back once `validate` has the game's profile. */
  let spec: BuildViewInput | undefined;
  return {
    what: "the view edit",
    owner: "studioCommit",
    baseRevision,
    reenter: (room, files, profile) => {
      const logics = new Map<number, Uint8Array>();
      try {
        const container = openContainer(new Map(files));
        for (let n = 0; n < 256; n++) {
          const logic = container.getResource("logic", n);
          if (logic) logics.set(n, logic);
        }
      } catch {
        return false;
      }
      return roomBakesView(scanViewUsage(logics, profile), room, num);
    },
    resolve: () => {
      if (!Number.isInteger(num) || num < 0 || num > 255)
        throw new ResourceCommitError("invalid", `View ${num} is not a resource number.`);
      return {
        patches: [{ kind: "view", num, payload }],
        stage: (sources) => {
          if (!spec) return false;
          const before = sources.views.get(num);
          sources.views.set(num, spec);
          return JSON.stringify(before) !== JSON.stringify(spec);
        },
      };
    },
    validate: (author) => {
      spec = editedViewSpec(payload, author.state.profile);
    },
  };
}
