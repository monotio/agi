/**
 * The Logic Studio resource editors' project seam: opening one draft
 * `picture:N` or `view:N` document in the existing Room/Sprite Studio, and
 * the Keep transaction that lands the reviewed edit back in the shared
 * EditableProject — draft write, frozen candidate, durable admission — with
 * no engine, worker, provider or key. The draft document is the only thing
 * opened (never stale stored bytes): a source document compiles under the
 * project's profile, native bytes validate against the same decoders the
 * build uses. A Keep offers the exact reviewed content as one draft
 * transaction, freezes it with buildSelected over the selected closure and
 * admits it through keepCandidate, so unrelated dirty documents are neither
 * compiled nor saved, and a version or storage race refuses instead of
 * overwriting.
 */

import { openContainer } from "../../../../src/container/container.ts";
import type { ResourceRevision } from "../../../../src/gameIdentity.ts";
import { compilePictureSource } from "../../../../src/picture/source.ts";
import { renderPicture } from "../../../../src/picture/renderer.ts";
import { createPictureSurface } from "../../../../src/types.ts";
import { PROFILES, type AgiProfile } from "../../../../src/runtime/profile.ts";
import { parseView } from "../../../../src/view/view.ts";
import { scanViewUsage, viewUsage, type ViewUsage } from "../../../../src/agent/viewUsage.ts";
import type { EditableCandidate, EditableProject } from "../../project/editableProject.ts";
import type { AuthoringFingerprint } from "../../project/gameStorage.ts";
import type { CreativeKeepPreparation } from "../../project/creativeWorkspaceKeep.ts";
import { ResourceCommitError } from "../../project/projectTransaction.ts";
import type { ResourceCommitResult } from "../../project/resourceCommit.ts";
import type { KeepFn } from "../useStudioKeep.ts";
import type { SpriteKeepFn } from "../sprite/SpriteStudio.vue";

const RESOURCE_KEY = /^(picture|view):(0|[1-9]\d{0,2})$/;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function sameContent(left: string | Uint8Array, right: string | Uint8Array): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return sameBytes(left, right);
}

/** What the host wants to hear: draft writes (model resync) and durable receipts. */
export interface ResourceEditorHost {
  /**
   * Fired synchronously after the draft transaction lands — the same
   * notification accepted assistant proposals send, so models resync and a
   * pending proposal turns stale. Also fires when a later durable failure
   * leaves the write pending: it is a real draft change either way.
   */
  readonly onDraftChanged?: (keys: readonly string[]) => void;
  /** Fired after the durable receipt, with the content the draft document now keeps. */
  readonly onKept?: (key: string, content: string | Uint8Array) => void;
  /**
   * Refuses a Keep when the mount no longer serves this workspace — the host
   * swapped projects or replaced the draft. Logic Studio passes
   * `workspace.value === project`.
   */
  readonly isCurrent?: () => boolean;
}

/**
 * One open visual-edit session: the props the matching child Studio needs
 * (bytes, profile, keep transactions) captured from the draft at open. The
 * Keep functions are bound to this open — closing the session ends their
 * authority even if a late callback still holds a reference.
 */
export interface ProjectResourceEditor {
  readonly key: string;
  readonly kind: "picture" | "view";
  readonly number: number;
  readonly profile: AgiProfile;
  /** Draft-derived, profile-validated bytes the editor opens on. */
  readonly bytes: Uint8Array;
  /** The document's authored PIC source when the draft holds one. */
  readonly authoredSource: string | undefined;
  readonly baseRevision: ResourceRevision;
  readonly baseAuthoring: AuthoringFingerprint;
  /** The stored container image the workspace opened on: the actor probe's views. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Static view usage over the stored logic image, for the sprite chip. */
  readonly usage: ViewUsage;
  readonly keepPicture: KeepFn;
  readonly keepView: SpriteKeepFn;
  /**
   * Attach the creative workspace's pending-publication composer: the next
   * Keep through this session seals its prepared recipes, staged sources and
   * board changes into the same candidate and the same durable transaction.
   * Rebind or pass undefined to detach; nothing leaks across candidates.
   */
  bindCreativeKeep(provider: CreativeKeepProvider | undefined): void;
  /** End the session's authority; a later Keep refuses without writing. Idempotent. */
  close(): void;
}

/**
 * A composer bound to one creative workspace: given this session's frozen
 * candidate it stages what that candidate can admit and returns the sealed
 * publication intent, or undefined when nothing pending belongs to it.
 */
type CreativeKeepProvider = (
  candidate: EditableCandidate,
) => Promise<CreativeKeepPreparation | undefined>;

interface SessionState {
  readonly project: EditableProject;
  readonly draft: EditableProject["draft"];
  readonly host: ResourceEditorHost;
  readonly profile: AgiProfile;
  readonly key: string;
  readonly kind: "picture" | "view";
  readonly number: number;
  /** The document version the Keep may still write over — the open version, or ours. */
  expectedVersion: number;
  inFlight: boolean;
  closed: boolean;
  /** A bound creative workspace's keep composer, used by the next admit. */
  creativeKeep?: CreativeKeepProvider | undefined;
}

/**
 * The document's bytes the way the project build would see them: a source
 * document compiles under the real project compilers, native bytes validate
 * with the profile's decoders. Every failure is the compile/validation error
 * itself — there is no fallback to stored bytes that could contradict the
 * draft.
 */
function openBytes(
  project: EditableProject,
  state: Pick<SessionState, "key" | "kind" | "number">,
  doc: { readonly content: string | Uint8Array },
  profile: AgiProfile,
): Uint8Array {
  const { key, kind, number } = state;
  if (typeof doc.content === "string") {
    if (kind === "picture") return compilePictureSource(doc.content, { profile }).bytes;
    // A view document is JSON of BuildViewInput; the project's own selected
    // compile is the authoritative — and only public — strict reader.
    const candidate = project.buildSelected([key]);
    const files = candidate.files();
    const bytes = openContainer(new Map(Object.entries(files)), { profile }).getResource(
      "view",
      number,
    );
    if (!bytes) throw new Error(`The '${key}' document produced no view resource.`);
    return bytes;
  }
  if (kind === "picture") {
    renderPicture(doc.content, createPictureSurface(), { profile });
  } else {
    parseView(doc.content, profile);
  }
  return doc.content;
}

/** Static usage over the stored logic image — context only, the editor never saves it. */
function storedViewUsage(project: EditableProject, profile: AgiProfile, num: number): ViewUsage {
  const empty: ViewUsage = { rooms: [], logics: [], dynamic: false };
  try {
    const container = openContainer(new Map(Object.entries(project.storedData().files)), {
      profile,
    });
    const logics = new Map<number, Uint8Array>();
    for (let n = 0; n < 256; n++) {
      const payload = container.getResource("logic", n);
      if (payload) logics.set(n, payload);
    }
    return viewUsage(scanViewUsage(logics, profile), num);
  } catch {
    return empty;
  }
}

/** Map a failure off the draft/build/storage path onto the child's Keep vocabulary. */
function asCommitError(error: unknown): ResourceCommitError {
  if (error instanceof ResourceCommitError) return error;
  const message = reason(error);
  if (error instanceof Error) {
    // Storage's durable CAS: another window's commit, or the project removed.
    if (error.name === "ConcurrencyConflictError")
      return new ResourceCommitError("stale", message, { behindStorage: true });
    if (error.name === "ProjectDeletedError")
      return new ResourceCommitError("stale", message, { removed: true });
  }
  if (/^stale (document|selection|proposal)/i.test(message) || /another workspace/i.test(message))
    return new ResourceCommitError("stale", message);
  return new ResourceCommitError("storage", message);
}

/**
 * The session's authority to keep: not closed, and the host still serving the
 * workspace this session opened on. The accessor itself can end authority —
 * a host that unmounts the editor inside the call — so `closed` is rechecked
 * after it answers, and the whole check runs again after each external
 * callback and immediately before candidate admission.
 */
function checkAuthority(state: SessionState): void {
  if (state.closed)
    throw new ResourceCommitError(
      "stale",
      "This editor is closed; reopen the resource to keep drawing.",
    );
  if (state.host.isCurrent !== undefined) {
    // The accessor itself can end authority — a host that unmounts the
    // editor inside the call — or fail outright; either way it has not
    // confirmed this session's workspace.
    let current = false;
    try {
      current = state.host.isCurrent();
    } catch {
      /* accessor fault: no confirmed authority */
    }
    if (!current)
      throw new ResourceCommitError(
        "stale",
        "The workspace moved on while this editor was open; reopen the resource.",
      );
  }
  if (state.closed)
    throw new ResourceCommitError(
      "stale",
      "This editor is closed; reopen the resource to keep drawing.",
    );
}

/** The same authority question as a boolean, for after the commit. */
function hasAuthority(state: SessionState): boolean {
  try {
    checkAuthority(state);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shared write path behind both Keep contracts: CAS the document version,
 * write the reviewed content as one draft transaction, freeze a candidate
 * over just this document's closure, then admit it through the durable keep.
 * A refusal before the first await leaves the draft exactly as it was; a
 * durable failure afterwards leaves the write pending and retryable.
 */
async function admit(
  state: SessionState,
  content: string | Uint8Array,
): Promise<ResourceCommitResult> {
  checkAuthority(state);
  if (state.inFlight)
    throw new ResourceCommitError("busy", "A Save is already in progress for this resource.");
  state.inFlight = true;
  try {
    const snapshot = state.draft.capture();
    const current = snapshot.read(state.key);
    if (current === undefined)
      throw new ResourceCommitError("stale", `The '${state.key}' document was removed.`);
    if (!sameContent(current.content, content)) {
      // Version CAS: a write that landed since this session's last sighting —
      // creator typing, an applied proposal, a retry — refuses rather than
      // overwriting it. A retry after a durable failure finds its own content
      // already in place and skips the write.
      try {
        state.draft.edit(state.key, content, state.expectedVersion);
      } catch (error) {
        throw new ResourceCommitError("stale", reason(error));
      }
      state.expectedVersion = state.draft.capture().version(state.key);
      state.host.onDraftChanged?.([state.key]);
    }
    // A callback may have ended this session's authority (host unmounted the
    // editor, swapped the workspace). A draft write that already landed is
    // honest pending work; a session that lost authority never reaches
    // durable storage.
    checkAuthority(state);
    if (!state.draft.dirtyKeys().includes(state.key)) {
      const saved = state.project.savedIdentity();
      return {
        status: "unchanged",
        projectId: state.project.projectId,
        revision: saved.revision,
        authoring: saved.authoring,
      };
    }
    let result;
    try {
      const candidate = state.project.buildSelected([state.key]);
      // A bound creative workspace seals its pending work into this same
      // candidate: one transaction keeps the drawing and its recipe.
      let creative;
      if (state.creativeKeep !== undefined) {
        const preparation = await state.creativeKeep(candidate);
        checkAuthority(state);
        if (preparation !== undefined)
          creative = await state.project.prepareCreativeKeep(candidate, preparation);
      }
      result = await state.project.keepCandidate(
        candidate,
        creative === undefined ? {} : { creative },
      );
    } catch (error) {
      throw asCommitError(error);
    }
    // The receipt is already owned: a notification fault cannot turn the
    // completed commit into a failure, and the observer gets detached bytes
    // it cannot use to reach into the draft. The durable write awaited
    // storage — a session that closed or lost its workspace meanwhile must
    // not update a former host, so the receipt stands without delivery.
    if (hasAuthority(state)) {
      try {
        state.host.onKept?.(
          state.key,
          content instanceof Uint8Array ? new Uint8Array(content) : content,
        );
      } catch {
        /* observer fault; the durable commit stands */
      }
    }
    return {
      status: "committed",
      projectId: result.saved.projectId,
      revision: result.saved.revision,
      authoring: result.saved.authoring,
    };
  } finally {
    state.inFlight = false;
  }
}

/**
 * Open one draft `picture:N`/`view:N` document for the matching Studio.
 * Throws with the source/build error when the document cannot produce a
 * resource under the project's profile.
 */
export function openProjectResourceEditor(
  project: EditableProject,
  key: string,
  host: ResourceEditorHost = {},
): ProjectResourceEditor {
  const match = RESOURCE_KEY.exec(key);
  if (!match)
    throw new Error(`Only 'picture:N' and 'view:N' documents open in a visual editor: '${key}'.`);
  const kind = match[1] as "picture" | "view";
  const number = Number(match[2]);
  const profile = PROFILES[project.profileId];
  if (!profile) throw new Error(`Unknown build profile: ${project.profileId}.`);

  const snapshot = project.draft.capture();
  const doc = snapshot.read(key);
  if (!doc) throw new Error(`There is no '${key}' document in this draft.`);
  const identity = project.savedIdentity();
  const state: SessionState = {
    project,
    draft: project.draft,
    host,
    profile,
    key,
    kind,
    number,
    expectedVersion: doc.version,
    inFlight: false,
    closed: false,
  };
  const bytes = openBytes(project, state, doc, profile);

  const keepPicture: KeepFn = async (edit) => {
    if (edit.pictureNumber !== number)
      throw new ResourceCommitError(
        "invalid",
        `This edit is for PIC ${edit.pictureNumber}; the editor holds PIC ${number}.`,
      );
    // The source the child reviewed must compile to the exact bytes it
    // reviewed — the Keep never stores a claim the bytes contradict.
    let compiled: Uint8Array;
    try {
      compiled = compilePictureSource(edit.source, { profile }).bytes;
    } catch (error) {
      throw new ResourceCommitError(
        "invalid",
        `The edited picture source does not compile: ${reason(error)}`,
      );
    }
    if (!sameBytes(compiled, edit.bytes))
      throw new ResourceCommitError(
        "invalid",
        "The edited picture source does not compile to the reviewed bytes.",
      );
    return admit(state, edit.source);
  };

  const keepView: SpriteKeepFn = async (edit, stagedReference) => {
    if (stagedReference !== undefined)
      throw new ResourceCommitError(
        "invalid",
        "Staged reference keeps are not available in a stored project.",
      );
    if (edit.viewNumber !== number)
      throw new ResourceCommitError(
        "invalid",
        `This edit is for VIEW ${edit.viewNumber}; the editor holds VIEW ${number}.`,
      );
    // Exact native bytes: decoded once here by the profile's real reader, so
    // a payload the interpreter cannot read never enters the draft.
    try {
      parseView(edit.bytes, profile);
    } catch (error) {
      throw new ResourceCommitError("invalid", `The edited view does not decode: ${reason(error)}`);
    }
    return admit(state, new Uint8Array(edit.bytes));
  };

  return Object.freeze({
    key,
    kind,
    number,
    profile,
    bytes,
    authoredSource: typeof doc.content === "string" && kind === "picture" ? doc.content : undefined,
    baseRevision: identity.revision,
    baseAuthoring: identity.authoring,
    files: new Map(Object.entries(project.storedData().files)),
    usage: kind === "view" ? storedViewUsage(project, profile, number) : EMPTY_USAGE,
    keepPicture,
    keepView,
    bindCreativeKeep: (provider: CreativeKeepProvider | undefined) => {
      state.creativeKeep = provider;
    },
    close: () => {
      state.closed = true;
    },
  });
}

const EMPTY_USAGE: ViewUsage = { rooms: [], logics: [], dynamic: false };
