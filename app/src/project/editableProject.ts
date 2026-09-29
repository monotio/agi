/**
 * Provider-independent editable workspace service. openEditableProject reads a
 * stored project body and its history lifetime in one storage snapshot,
 * verifies its claimed authored source through inspectEditableProject, and
 * hands out one owned ProjectDraft. buildSelected freezes an immutable
 * candidate over the complete current draft; keepCandidate admits it through
 * the durable commitProject receipt, then acknowledges exactly the admitted
 * selection so newer typing stays dirty.
 *
 * Candidate authority is the issued object identity held in a WeakMap: no
 * caller-supplied field can forge a candidate or borrow another workspace's.
 * This service writes durable project state only — no AgentSession, provider,
 * model or worker is created, and a savedOnly result makes no claim about a
 * running game.
 *
 * Bounded first slice: a project whose source claims need review refuses
 * build/Keep until an explicit resolution step exists; a candidate that
 * removes resources or changes the `tests`/`references` metadata documents is
 * refused at admission; a pending portable recoveryDraft is carried through
 * every body unchanged.
 */
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "../../../src/authoring/authoringState.ts";
import { captureProjectBuild } from "../../../src/authoring/projectBuild.ts";
import { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { readBindingsDocument } from "../../../src/authoring/projectDocuments.ts";
import {
  restoreProjectRecovery,
  type RecoveryBase,
} from "../../../src/authoring/projectRecovery.ts";
import { compileProjectSelection } from "../../../src/authoring/projectSelection.ts";
import { writeProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import type { ProjectId, ResourceRevision } from "../../../src/gameIdentity.ts";
import { detectProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import {
  authoringFingerprint,
  commitProject,
  generationOf,
  loadAuthoredGameWithHistoryLifetime,
  type AuthoringFingerprint,
  type ProjectCommitRequest,
  type ProjectCommitReceipt,
} from "./gameStorage.ts";
import type { CachedGameData } from "./gameTypes.ts";
import { listProjectDrafts, type DraftReceipt } from "./projectDrafts.ts";
import {
  inspectEditableProject,
  type EditableProjectInspection,
} from "./projectWorkspaceSource.ts";

/** One kept or refused document: authored text or retained native bytes. */
type EditableDocumentContent = EditableProjectInspection["documents"][string];

/** The durable identity a committed Keep advanced storage to. */
export interface EditableSavedIdentity {
  readonly projectId: ProjectId;
  readonly generation: number;
  readonly lifetime: string;
  readonly revision: ResourceRevision;
  readonly authoring: AuthoringFingerprint;
  readonly buildId: string;
}

/**
 * An immutable compiled selection, issued by one workspace's buildSelected.
 * The service holds its admission state privately; the fields here describe
 * it for review.
 */
export interface EditableCandidate {
  /** Stable commit identity: retrying this candidate resolves the same receipt. */
  readonly commitId: string;
  /** The exact document closure this candidate admits. */
  readonly keys: readonly string[];
  readonly buildId: string;
  readonly revision: ResourceRevision;
  readonly profileId: ProfileId;
  /** Reference findings on the built image; errors block Keep, warnings stay visible. */
  readonly diagnostics: ReferenceDiagnostics;
  /** Kept resources this candidate deletes; this service refuses to keep them. */
  readonly removedResources: readonly string[];
  /** The complete compiled document set, detached on every call. */
  documents(): Readonly<Record<string, EditableDocumentContent>>;
  /** The complete compiled file image, detached on every call. */
  files(): Readonly<Record<string, Uint8Array>>;
}

export interface EditableKeepResult {
  /** Durable save only: a receipt acknowledges storage, never a running game. */
  readonly kind: "savedOnly";
  readonly commitId: string;
  readonly saved: EditableSavedIdentity;
  readonly warnings: readonly "indexRepairPending"[];
}

/**
 * One open editable workspace. The draft is the only mutable authority;
 * everything the service returns is a detached or frozen copy.
 */
export interface EditableProject {
  readonly projectId: ProjectId;
  /** Fresh per open: candidates and recoveries from other incarnations hold no authority. */
  readonly workspaceId: string;
  readonly profileId: ProfileId;
  /** The owned draft; edit() applies single-document typing, propose/apply transactions. */
  readonly draft: ProjectDraft;
  /** Source-review diagnostics and refused claims found when the project was opened. */
  readonly inspection: EditableProjectInspection;
  /**
   * When the open restored a stored draft, the reviewed identity it came
   * from — so the caller can keep writing under that workspace and discard
   * exactly that receipt. Undefined for a plain or portable-recovery open.
   */
  readonly restoredRecovery:
    { readonly workspaceId: string; readonly receipt: DraftReceipt } | undefined;
  /** The saved storage identity this workspace opened on or last committed. */
  savedIdentity(): EditableSavedIdentity;
  /** The stored body this workspace opened on, detached for recovery/export reads. */
  storedData(): CachedGameData;
  /** Compile the selected closure over the complete current draft into a candidate. */
  buildSelected(
    keys: readonly string[],
    dependencies?: Readonly<Record<string, readonly string[]>>,
  ): EditableCandidate;
  /**
   * Admit one issued candidate through the durable commit. Synchronously
   * refuses foreign candidates and selections the draft has moved past; the
   * receipt acknowledges only the admitted selection.
   */
  keepCandidate(candidate: EditableCandidate): Promise<EditableKeepResult>;
}

type Selection = ReturnType<ProjectDraft["select"]>;
type SelectionCompile = ReturnType<typeof compileProjectSelection>;
type ReferenceDiagnostics = SelectionCompile["references"]["diagnostics"];

interface CandidateState {
  readonly selection: Selection;
  readonly commitId: string;
  readonly expected: EditableSavedIdentity;
  readonly buildId: string;
  readonly revision: ResourceRevision;
  readonly diagnostics: ReferenceDiagnostics;
  readonly removedResources: readonly string[];
  readonly documents: Readonly<Record<string, EditableDocumentContent>>;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly versions: readonly { readonly key: string; readonly version: number }[];
  request: ProjectCommitRequest | undefined;
  pending: Promise<EditableKeepResult> | undefined;
  receipt: ProjectCommitReceipt | undefined;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyContent(
  content: EditableDocumentContent | undefined,
): EditableDocumentContent | undefined {
  return content instanceof Uint8Array ? new Uint8Array(content) : content;
}

function copyDocuments(
  documents: Readonly<Record<string, EditableDocumentContent>>,
): Record<string, EditableDocumentContent> {
  const out: Record<string, EditableDocumentContent> = Object.create(null);
  for (const [key, content] of Object.entries(documents)) {
    out[key] = copyContent(content)!;
  }
  return out;
}

function copyFiles(files: Readonly<Record<string, Uint8Array>>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = Object.create(null);
  for (const [name, bytes] of Object.entries(files)) out[name] = new Uint8Array(bytes);
  return out;
}

function sameContent(
  left: EditableDocumentContent | undefined,
  right: EditableDocumentContent | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The base image's build identity, when it can be captured. `expected` never
 * compares this field — the durable CAS uses generation, lifetime, revision
 * and authoring — so a base too damaged to recompile leaves it empty and a
 * later build fails on the same damage instead.
 */
function baseBuildId(
  inspection: EditableProjectInspection,
  files: Readonly<Record<string, Uint8Array>>,
): string {
  try {
    const sources: Record<string, string> = Object.create(null);
    for (const [key, content] of Object.entries(inspection.documents)) {
      if (key.startsWith("logic:") && typeof content === "string") sources[key.slice(6)] = content;
    }
    const bindingsDocument = inspection.documents["bindings"];
    const bindings = readBindingsDocument(
      typeof bindingsDocument === "string" ? bindingsDocument : "{}",
    );
    return captureProjectBuild({
      files,
      profileId: inspection.profileId,
      sources,
      bindings: Object.fromEntries(
        Object.entries(bindings).map(([name, binding]) => [name, { num: binding.num }]),
      ),
    }).identity.buildId;
  } catch {
    return "";
  }
}

class EditableProjectService implements EditableProject {
  readonly projectId: ProjectId;
  readonly draft: ProjectDraft;
  readonly inspection: EditableProjectInspection;
  readonly workspaceId: string;
  readonly profileId: ProfileId;
  readonly restoredRecovery:
    { readonly workspaceId: string; readonly receipt: DraftReceipt } | undefined;
  private saved: EditableSavedIdentity;
  /** The kept file image the next build compiles over. */
  private files: Readonly<Record<string, Uint8Array>>;
  private readonly allowMissingRooms: boolean;
  private readonly candidates = new WeakMap<EditableCandidate, CandidateState>();
  /** Serializes this workspace's commit admissions without blocking typing. */
  private tail: Promise<unknown> = Promise.resolve();
  private readonly metadataBase: Record<
    "tests" | "references",
    EditableDocumentContent | undefined
  >;
  private readonly stored: CachedGameData;

  constructor(
    projectId: ProjectId,
    stored: CachedGameData,
    lifetime: string,
    inspection: EditableProjectInspection,
    restored?:
      | {
          readonly draft: ProjectDraft;
          readonly recovery?: { readonly workspaceId: string; readonly receipt: DraftReceipt };
        }
      | undefined,
  ) {
    this.projectId = projectId;
    this.stored = stored;
    this.inspection = inspection;
    this.profileId = inspection.profileId;
    this.workspaceId = crypto.randomUUID();
    this.draft = restored?.draft ?? new ProjectDraft(inspection.documents);
    this.restoredRecovery = restored?.recovery;
    this.files = stored.files;
    this.allowMissingRooms = stored.roomGeneration === true;
    this.metadataBase = {
      tests: copyContent(inspection.documents["tests"]),
      references: copyContent(inspection.documents["references"]),
    };
    const revision = stored.library?.revision;
    if (revision === undefined) throw new Error("The saved project has invalid library metadata.");
    this.saved = Object.freeze({
      projectId,
      generation: generationOf(stored),
      lifetime,
      revision,
      authoring: authoringFingerprint(stored.authoringState, stored.workspace),
      buildId: baseBuildId(inspection, stored.files),
    });
  }

  savedIdentity(): EditableSavedIdentity {
    return this.saved;
  }

  storedData(): CachedGameData {
    return structuredClone(this.stored);
  }

  buildSelected(
    keys: readonly string[],
    dependencies?: Readonly<Record<string, readonly string[]>>,
  ): EditableCandidate {
    if (this.inspection.requiresSourceReview) {
      const refused = Object.keys(this.inspection.rejectedSources).join(", ");
      throw new Error(
        `This project holds refused source claims (${refused}); the source review must be resolved before building.`,
      );
    }
    const result = compileProjectSelection({
      draft: this.draft,
      files: this.files,
      profileId: this.profileId,
      keys,
      ...(dependencies === undefined ? {} : { dependencies }),
      allowMissingRooms: this.allowMissingRooms,
    });
    const state: CandidateState = {
      selection: result.selection,
      commitId: crypto.randomUUID(),
      expected: this.saved,
      buildId: result.compiled.build.identity.buildId,
      revision: result.compiled.build.identity.revision,
      diagnostics: result.references.diagnostics,
      removedResources: result.removedResources,
      documents: result.compiled.documents(),
      files: Object.fromEntries(result.compiled.files()),
      versions: result.selection.keys.map((key) => ({
        key,
        version: result.selection.snapshot.version(key),
      })),
      request: undefined,
      pending: undefined,
      receipt: undefined,
    };
    const candidate: EditableCandidate = Object.freeze({
      commitId: state.commitId,
      keys: Object.freeze([...result.selection.keys]),
      buildId: state.buildId,
      revision: state.revision,
      profileId: this.profileId,
      diagnostics: Object.freeze(state.diagnostics.map((entry) => Object.freeze({ ...entry }))),
      removedResources: Object.freeze([...state.removedResources]),
      documents: () => Object.freeze(copyDocuments(state.documents)),
      files: () => Object.freeze(copyFiles(state.files)),
    });
    this.candidates.set(candidate, state);
    return candidate;
  }

  async keepCandidate(candidate: EditableCandidate): Promise<EditableKeepResult> {
    const state = this.candidates.get(candidate);
    if (state === undefined)
      throw new Error("This candidate was created by another workspace or service.");
    if (state.receipt !== undefined) return this.replayKeep(state);
    if (state.pending !== undefined) return state.pending;
    // Admission checks run while the caller is synchronous with the draft:
    // typing during the storage wait stays a valid newer draft instead of
    // invalidating this already-admitted write.
    this.draft.assertCurrent(state.selection);
    state.request = this.admissionRequest(state);
    const pending = this.tail.then(() => this.commitAdmitted(state));
    state.pending = pending;
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    void pending.catch(() => {
      if (state.pending === pending && state.receipt === undefined) state.pending = undefined;
    });
    return pending;
  }

  /**
   * The policy gate before storage: resource removals, `tests`/`references`
   * changes and reference errors are refused, then the committed body is
   * derived. Throws before anything is written.
   */
  private admissionRequest(state: CandidateState): ProjectCommitRequest {
    if (state.removedResources.length > 0)
      throw new Error(
        `This candidate removes ${state.removedResources.join(", ")}; resource removal review is a separate step this service does not perform yet.`,
      );
    for (const key of ["tests", "references"] as const) {
      if (!sameContent(state.documents[key], this.metadataBase[key]))
        throw new Error(
          `The '${key}' document is preserved metadata; this service keeps only its stored value.`,
        );
    }
    const errors = state.diagnostics.filter((entry) => entry.severity === "error");
    if (errors.length > 0)
      throw new Error(
        `Reference errors block this Keep: ${errors
          .map((entry) => `${entry.document}: ${entry.message}`)
          .join("; ")}`,
      );

    const documents = copyDocuments(state.documents);
    const files = copyFiles(state.files);
    const words = files["WORDS.TOK"]
      ? parseWordsTok(files["WORDS.TOK"]).map(({ word, id }): [string, number] => [word, id])
      : [];
    const {
      projectId: _projectId,
      authoredAt: _authoredAt,
      generation: _generation,
      ...rest
    } = this.stored;
    return {
      projectId: this.projectId,
      commitId: state.commitId,
      workspaceId: this.workspaceId,
      buildId: state.buildId,
      expected: state.expected,
      documents: state.versions,
      data: {
        ...rest,
        files,
        words,
        authoringState: this.syncedAuthoringState(documents),
        workspace: writeProjectWorkspace(documents),
      },
    };
  }

  /**
   * Rebuild the legacy authoring record from the candidate's exact documents:
   * validated bindings and world, music and every unrelated field preserved,
   * and claimed source only where the kept document is real authored text —
   * byte-only or deleted resources lose their claim.
   */
  private syncedAuthoringState(
    documents: Readonly<Record<string, EditableDocumentContent>>,
  ): Record<string, unknown> {
    const base = this.stored.authoringState ?? {};
    const priorSources = base["sources"];
    if (priorSources !== undefined && !isRecord(priorSources))
      throw new Error("The stored source claims are malformed; keeping would discard them.");
    let prior: AuthoringState | undefined;
    if (base["authoring"] !== undefined) {
      try {
        prior = validateAuthoringState(base["authoring"]);
      } catch (error) {
        throw new Error(`The stored authoring state is invalid: ${reason(error)}`, {
          cause: error,
        });
      }
    }
    const bindingsDocument = documents["bindings"];
    if (bindingsDocument !== undefined && typeof bindingsDocument !== "string")
      throw new Error("The 'bindings' document must be text.");
    const bindings = readBindingsDocument(
      typeof bindingsDocument === "string" ? bindingsDocument : "{}",
    );
    const worldDocument = documents["world"];
    let world: unknown = prior?.world ?? createAuthoringState().world;
    if (worldDocument !== undefined) {
      if (typeof worldDocument !== "string") throw new Error("The 'world' document must be text.");
      try {
        world = JSON.parse(worldDocument);
      } catch (error) {
        throw new Error(`The 'world' document is not valid JSON: ${reason(error)}`, {
          cause: error,
        });
      }
    }
    let authoring: AuthoringState;
    try {
      authoring = validateAuthoringState({
        version: 1,
        ...(prior?.music !== undefined ? { music: prior.music } : {}),
        bindings,
        world,
      });
    } catch (error) {
      throw new Error(`The edited bindings or world are invalid: ${reason(error)}`, {
        cause: error,
      });
    }
    const logics: [number, string][] = [];
    const pictures: [number, string][] = [];
    const views: [number, unknown][] = [];
    const sounds: [number, unknown][] = [];
    const documentResource = /^(logic|picture|view|sound):(\d+)$/;
    for (const [key, content] of Object.entries(documents)) {
      const resource = documentResource.exec(key);
      if (resource === null || typeof content !== "string") continue;
      const num = Number(resource[2]);
      if (resource[1] === "logic") logics.push([num, content]);
      else if (resource[1] === "picture") pictures.push([num, content]);
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (error) {
          throw new Error(`The '${key}' document is not valid JSON: ${reason(error)}`, {
            cause: error,
          });
        }
        (resource[1] === "view" ? views : sounds).push([num, parsed]);
      }
    }
    const byNumber = (left: [number, unknown], right: [number, unknown]) => left[0] - right[0];
    const sources = {
      ...(isRecord(priorSources) ? priorSources : {}),
      logics: logics.sort(byNumber),
      pictures: pictures.sort(byNumber),
      views: views.sort(byNumber),
      sounds: sounds.sort(byNumber),
    };
    return { ...base, authoring, sources };
  }

  /**
   * The durable write and the local acknowledgement. The draft moves to the
   * committed baseline only when acknowledgeKept accepts this selection; a
   * superseded selection leaves the newer baseline alone.
   */
  private async commitAdmitted(state: CandidateState): Promise<EditableKeepResult> {
    const result = await commitProject(state.request!);
    state.receipt = result.receipt;
    const saved: EditableSavedIdentity = Object.freeze({ ...result.receipt.saved });
    if (this.draft.acknowledgeKept(state.selection)) {
      this.saved = saved;
      this.files = state.files;
    }
    return Object.freeze({
      kind: "savedOnly",
      commitId: state.commitId,
      saved,
      warnings: Object.freeze([...result.warnings]),
    });
  }

  /**
   * An already admitted candidate resolves the same durable receipt through
   * the commit record, without rechecking the draft or moving the baseline
   * back to an older save.
   */
  private replayKeep(state: CandidateState): Promise<EditableKeepResult> {
    const pending = this.tail.then(async () => {
      const result = await commitProject(state.request!);
      return Object.freeze({
        kind: "savedOnly" as const,
        commitId: state.commitId,
        saved: Object.freeze({ ...result.receipt.saved }),
        warnings: Object.freeze([...result.warnings]),
      });
    });
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

/**
 * The identity a recovery draft must have been captured against to restore
 * into a workspace opened on exactly this stored body: resource revision,
 * the editable-content fingerprint and the detected interpreter profile —
 * the same triple projectDrafts matches.
 */
export function recoveryBaseOf(data: CachedGameData): RecoveryBase {
  const revision = data.library?.revision;
  if (revision === undefined) throw new Error("The saved project has invalid library metadata.");
  return Object.freeze({
    revision,
    authoring: authoringFingerprint(data.authoringState, data.workspace),
    profileId: detectProfile(new Map(Object.entries(data.files)), data.library?.profile).id,
  });
}

/**
 * An explicit, reviewed restore the caller chose for this open: a stored
 * draft under the exact receipt the user reviewed, or a portable recovery
 * envelope. The service — never the UI — installs the recovered draft, so
 * stale bases and moved receipts fail the open instead of leaking a draft
 * the caller assembled.
 */
export interface EditableOpenOptions {
  readonly restore?:
    | { readonly workspaceId: string; readonly receipt: DraftReceipt }
    | { readonly portable: unknown };
}

/**
 * Open a stored project for editing. The body and its history lifetime come
 * from one storage snapshot; reopening creates a fresh workspace authority.
 * Throws when the project is absent, removed or unreadable — the stored data
 * is never rewritten by a failed open.
 *
 * With `restore`, the captured body and the draft records are re-read and
 * every identity is verified against this exact capture — the reviewed
 * receipt, the saved generation/lifetime, and the recovery base triple —
 * so a concurrent write fails the open rather than rebasing onto moved
 * bytes. The restored draft is built by restoreProjectRecovery: a new
 * ProjectDraft whose versions restart under this workspace's authority.
 */
export async function openEditableProject(
  id: ProjectId,
  options?: EditableOpenOptions,
): Promise<EditableProject> {
  const captured = await loadAuthoredGameWithHistoryLifetime(id);
  if (captured === null) throw new Error(`Project "${id}" has no saved data to open for editing.`);
  if (captured.lifetime === null)
    throw new Error(`Project "${id}" was removed; reopen the library entry.`);
  const inspection = inspectEditableProject(captured.data);
  const restore = options?.restore;
  if (restore === undefined)
    return new EditableProjectService(id, captured.data, captured.lifetime, inspection);

  const base = recoveryBaseOf(captured.data);
  if ("portable" in restore) {
    const draft = restoreProjectRecovery({
      documents: inspection.documents,
      base,
      recovery: restore.portable,
    });
    return new EditableProjectService(id, captured.data, captured.lifetime, inspection, {
      draft,
    });
  }
  // Re-read the draft records beside the current body; the receipt the user
  // reviewed must still be the stored one, and the stored draft's base must
  // match this capture — restoreProjectRecovery rechecks the triple itself.
  const entries = await listProjectDrafts(id);
  const entry = entries.find((candidate) => candidate.workspaceId === restore.workspaceId);
  if (entry === undefined) throw new Error("That saved draft is gone; reopen the library entry.");
  if (
    entry.status === "stale" ||
    entry.expected.lifetime !== captured.lifetime ||
    entry.expected.generation !== generationOf(captured.data)
  )
    throw new Error(
      "This draft is stale: the saved project changed since it was written. It can be reviewed, downloaded or discarded, but not restored.",
    );
  if (
    entry.receipt.incarnation !== restore.receipt.incarnation ||
    entry.receipt.sequence !== restore.receipt.sequence
  )
    throw new Error("This recovery changed; review the latest draft before restoring it.");
  const draft = restoreProjectRecovery({
    documents: inspection.documents,
    base,
    recovery: entry.recovery,
  });
  return new EditableProjectService(id, captured.data, captured.lifetime, inspection, {
    draft,
    recovery: { workspaceId: entry.workspaceId, receipt: entry.receipt },
  });
}
