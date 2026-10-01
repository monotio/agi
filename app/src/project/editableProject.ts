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
 * changes the `tests`/`references` metadata documents is refused at
 * admission; a pending portable recoveryDraft is carried through every body
 * unchanged. Resource removal needs an explicit per-candidate review
 * (reviewedRemovals) and an empty surviving-use inventory before Keep.
 * A workspace's staged creative work publishes through the same candidate:
 * prepareCreativeKeep seals exactly one prepared publication against the
 * candidate, and the Keep carrying it commits body, catalog marker and
 * receipt in the same transaction.
 */
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "../../../src/authoring/authoringState.ts";
import { captureProjectBuild } from "../../../src/authoring/projectBuild.ts";
import { ProjectDraft, type DraftKeepAdmission } from "../../../src/authoring/projectDraft.ts";
import {
  readBindingsDocument,
  readMusicDocument,
} from "../../../src/authoring/projectDocuments.ts";
import {
  restoreProjectRecovery,
  type RecoveryBase,
} from "../../../src/authoring/projectRecovery.ts";
import { inspectProjectRemoval } from "../../../src/authoring/projectRemoval.ts";
import { compileProjectSelection } from "../../../src/authoring/projectSelection.ts";
import { writeProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import type { CreativeKeepRequest } from "../../../src/creative/catalog.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import type { ProjectId, ResourceRevision } from "../../../src/gameIdentity.ts";
import { detectProfile, PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import {
  authoringFingerprint,
  commitProject,
  generationOf,
  loadAuthoredGameWithHistoryLifetime,
  type AuthoringFingerprint,
  type ProjectCommitRequest,
  type ProjectCommitReceipt,
} from "./gameStorage.ts";
import {
  prepareWorkspaceCreativeKeep,
  resolveWorkspaceCreativeKeep,
  type CreativeKeepPreparation,
  type EditableCreativeKeep,
} from "./creativeWorkspaceKeep.ts";
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
  /** Kept native resources this candidate deletes; Keep needs them reviewed. */
  readonly removedResources: readonly string[];
  /** The complete compiled document set, detached on every call. */
  documents(): Readonly<Record<string, EditableDocumentContent>>;
  /** The complete compiled file image, detached on every call. */
  files(): Readonly<Record<string, Uint8Array>>;
}

/**
 * The caller's explicit review of a candidate's removals, supplied at Keep.
 * `reviewedRemovals` must equal the candidate's own removedResources exactly:
 * it records that the listed removals were seen, never which resources to
 * delete — the issued candidate's image remains the only authority.
 */
export interface EditableKeepReview {
  readonly reviewedRemovals?: readonly string[];
  /**
   * The creative publication prepared against this exact candidate through
   * prepareCreativeKeep. A candidate that sealed one must be kept with that
   * handle — omitting it, or passing another candidate's publication or a
   * lookalike, refuses rather than silently changing the admitted intent.
   */
  readonly creative?: EditableCreativeKeep;
}

export interface EditableKeepResult {
  /** Durable save only: a receipt acknowledges storage, never a running game. */
  readonly kind: "savedOnly";
  readonly commitId: string;
  readonly saved: EditableSavedIdentity;
  readonly warnings: readonly "indexRepairPending"[];
  /** The kept/head catalog revisions this Keep published, when it carried creative work. */
  readonly creative?: { readonly kept: number; readonly head: number } | undefined;
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
   * Prepare this workspace's staged creative work for publication through
   * one issued candidate. Reads the creative catalog once and seals the
   * captured intent into the candidate: the Keep that publishes it must
   * carry the returned publication in `review.creative`, and no other. The
   * prepared request freezes the catalog head, the consumed lease and its
   * workspace/owner claim, so a moved catalog or expired lease refuses at
   * the commit transaction. A candidate with no native change still
   * publishes creative records through the same atomic Keep.
   */
  prepareCreativeKeep(
    candidate: EditableCandidate,
    preparation: CreativeKeepPreparation,
  ): Promise<EditableCreativeKeep>;
  /**
   * Admit one issued candidate through the durable commit. Synchronously
   * refuses foreign candidates and selections the draft has moved past; the
   * receipt acknowledges only the admitted selection. A candidate that
   * removes native resources additionally requires review.reviewedRemovals
   * naming exactly those removals, and refuses while any surviving or
   * unprovable use remains. A candidate with a sealed creative publication
   * must be kept with that exact handle: its request commits body, catalog
   * and receipt atomically.
   */
  keepCandidate(
    candidate: EditableCandidate,
    review?: EditableKeepReview,
  ): Promise<EditableKeepResult>;
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
  /** inspectProjectReferences over the compiled candidate image, kept whole for removal review. */
  readonly image: SelectionCompile["references"];
  readonly removedResources: readonly string[];
  /** The kept baseline's named bindings, captured at build for draft review. */
  readonly keptBindings: AuthoringState["bindings"];
  readonly documents: Readonly<Record<string, EditableDocumentContent>>;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly versions: readonly { readonly key: string; readonly version: number }[];
  /** The one creative publication this candidate may keep, sealed by prepareCreativeKeep. */
  creative: EditableCreativeKeep | undefined;
  /** A prepare is in flight: a Keep started meanwhile cannot claim an unsealed intent. */
  creativePreparing: boolean;
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
    const keptBindings = this.draft.select([]).documents()["bindings"];
    const state: CandidateState = {
      selection: result.selection,
      commitId: crypto.randomUUID(),
      expected: this.saved,
      buildId: result.compiled.build.identity.buildId,
      revision: result.compiled.build.identity.revision,
      diagnostics: result.references.diagnostics,
      image: result.references,
      removedResources: result.removedResources,
      keptBindings: readBindingsDocument(typeof keptBindings === "string" ? keptBindings : "{}"),
      documents: result.compiled.documents(),
      files: Object.fromEntries(result.compiled.files()),
      versions: result.selection.keys.map((key) => ({
        key,
        version: result.selection.snapshot.version(key),
      })),
      creative: undefined,
      creativePreparing: false,
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

  async prepareCreativeKeep(
    candidate: EditableCandidate,
    preparation: CreativeKeepPreparation,
  ): Promise<EditableCreativeKeep> {
    const state = this.candidates.get(candidate);
    if (state === undefined)
      throw new Error("This candidate was created by another workspace or service.");
    if (state.creative !== undefined || state.creativePreparing || state.request !== undefined)
      throw new Error("This candidate's creative publication is already sealed.");
    this.draft.assertCurrent(state.selection);
    state.creativePreparing = true;
    try {
      const keep = await prepareWorkspaceCreativeKeep(
        {
          projectId: this.projectId,
          workspaceId: this.workspaceId,
          profileId: this.profileId,
          selectionKeys: state.selection.keys,
          removedResources: state.removedResources,
          files: state.files,
        },
        candidate,
        preparation,
      );
      // The seal is still singular: a Keep or a racing prepare admitted on
      // this candidate during the catalog read cannot gain creative intent.
      if (state.creative !== undefined || state.request !== undefined)
        throw new Error("This candidate's creative publication is already sealed.");
      state.creative = keep;
      return keep;
    } finally {
      state.creativePreparing = false;
    }
  }

  async keepCandidate(
    candidate: EditableCandidate,
    review?: EditableKeepReview,
  ): Promise<EditableKeepResult> {
    const state = this.candidates.get(candidate);
    if (state === undefined)
      throw new Error("This candidate was created by another workspace or service.");
    // Admission checks run while the caller is synchronous with the draft:
    // typing during the storage wait stays a valid newer draft instead of
    // invalidating this already-admitted write. The review arguments are
    // captured and checked here, before the first await and before a receipt
    // replay: a candidate keeps exactly the creative intent it sealed — a
    // different or absent publication refuses rather than replaying one
    // receipt under a different promise.
    const reviewedRemovals =
      review?.reviewedRemovals === undefined
        ? undefined
        : Object.freeze([...review.reviewedRemovals]);
    const creativeReview = review?.creative;
    if (state.creativePreparing)
      throw new Error("This candidate's creative publication is still being prepared.");
    if (creativeReview !== state.creative) {
      if (creativeReview !== undefined) resolveWorkspaceCreativeKeep(candidate, creativeReview);
      throw new Error(
        creativeReview === undefined
          ? "This candidate's Keep must carry the creative publication prepared for it."
          : "This candidate's creative publication is already sealed to a different intent.",
      );
    }
    if (state.receipt !== undefined) return this.replayKeep(state);
    if (state.pending !== undefined) return state.pending;
    this.draft.assertCurrent(state.selection);
    const creative =
      state.creative === undefined
        ? undefined
        : resolveWorkspaceCreativeKeep(candidate, state.creative);
    // The prospective request is built locally before admission: a review or
    // build refusal reserves nothing, and the reservation — taken before the
    // request is registered or the async tail opens — is what lets the draft
    // hold a native history step out of this save's settlement window.
    const request = this.admissionRequest(state, reviewedRemovals, creative);
    const admission = this.draft.admitKeep(state.selection);
    try {
      state.request = request;
      const pending = this.tail.then(() => this.commitAdmitted(state, admission));
      state.pending = pending;
      this.tail = pending.then(
        () => undefined,
        () => undefined,
      );
      void pending.catch(() => {
        if (state.pending === pending && state.receipt === undefined) state.pending = undefined;
      });
      return pending;
    } catch (error) {
      this.draft.finishKeepAdmission(admission);
      throw error;
    }
  }

  /**
   * The policy gate before storage: reviewed removals, `tests`/`references`
   * changes and reference errors are refused, then the committed body is
   * derived. Throws before anything is written. The review argument is the
   * caller's approval copy — it is matched against this candidate's own
   * computed removals and can neither widen nor substitute them.
   */
  private admissionRequest(
    state: CandidateState,
    reviewedRemovals: readonly string[] | undefined,
    creative: CreativeKeepRequest | undefined,
  ): ProjectCommitRequest {
    const removals = state.removedResources;
    if (removals.length > 0 || reviewedRemovals !== undefined) {
      this.checkRemovalApproval(removals, reviewedRemovals);
      const profile = PROFILES[this.profileId];
      if (!profile) throw new Error(`Unknown build profile: ${this.profileId}`);
      const selected = new Set(state.selection.keys);
      const drafts = this.draft
        .dirtyKeys()
        .filter((key) => !selected.has(key))
        .flatMap((key) => {
          const document = state.selection.snapshot.read(key);
          return document === undefined ? [] : [{ key, content: document.content }];
        });
      const findings = inspectProjectRemoval({
        removals,
        image: state.image,
        authoring: this.candidateAuthoring(state.documents),
        tests: state.documents["tests"],
        references: state.documents["references"],
        drafts,
        keptBindings: state.keptBindings,
        profile,
      });
      if (findings.length > 0)
        throw new Error(
          `This candidate removes ${removals.join(", ")}; ${findings
            .map((finding) => finding.message)
            .join("; ")}`,
        );
    }

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
      // The commit transaction rechecks the kept creative catalog against
      // this exact set: a kept recipe destination is a surviving use the
      // synchronous review cannot see from documents alone.
      removals: [...removals],
      // The sealed publication rides this exact request: body, catalog
      // marker and receipt commit as one transaction under one commitId.
      ...(creative === undefined ? {} : { creative }),
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
   * The approval argument is review evidence, not authority: it must name
   * exactly the removals the issued candidate computed from its own document
   * set — every removal listed once, and nothing else. A mismatch refuses
   * before any reference review runs.
   */
  private checkRemovalApproval(
    removals: readonly string[],
    reviewed: readonly string[] | undefined,
  ): void {
    if (reviewed === undefined) {
      if (removals.length > 0)
        throw new Error(
          `This candidate removes ${removals.join(", ")}; removal requires review: pass the exact list in 'reviewedRemovals'.`,
        );
      throw new Error("A removal review was given, but this candidate removes no resources.");
    }
    const seen = new Set<string>();
    for (const key of reviewed) {
      if (!removals.includes(key))
        throw new Error(
          `Removal review '${key}' names no removal in this candidate; reviewedRemovals must list exactly ${removals.join(", ")}.`,
        );
      if (seen.has(key))
        throw new Error(`Removal review lists '${key}' twice; each removal is reviewed once.`);
      seen.add(key);
    }
    const missing = removals.filter((key) => !seen.has(key));
    if (missing.length > 0)
      throw new Error(`Removal review is missing ${missing.join(", ")}; review every removal.`);
  }

  /**
   * The candidate's validated authoring intent — bindings, world plan and
   * music — read from its complete document set over the stored legacy record.
   * Shared by admission's removal review and the committed body's sync.
   */
  private candidateAuthoring(
    documents: Readonly<Record<string, EditableDocumentContent>>,
  ): AuthoringState {
    const base = this.stored.authoringState ?? {};
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
    // The candidate set is complete: an absent music document means absent
    // intent (deleting it must not resurrect the stored value — the workspace
    // envelope carries the same absence). Existing intent reaches here through
    // inspection's own hydration, not a second authority.
    const musicDocument = documents["music"];
    let music: AuthoringState["music"];
    if (musicDocument !== undefined) {
      if (typeof musicDocument !== "string") throw new Error("The 'music' document must be text.");
      try {
        music = readMusicDocument(musicDocument);
      } catch (error) {
        throw new Error(`The 'music' document is invalid: ${reason(error)}`, { cause: error });
      }
    }
    try {
      return validateAuthoringState({
        version: 1,
        ...(music !== undefined ? { music } : {}),
        bindings,
        world,
      });
    } catch (error) {
      throw new Error(`The edited bindings or world are invalid: ${reason(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Rebuild the legacy authoring record from the candidate's exact documents:
   * validated bindings and world, music read from the candidate's music
   * document (absent means removed), and claimed source only where the kept
   * document is real authored text — byte-only or deleted resources lose
   * their claim.
   */
  private syncedAuthoringState(
    documents: Readonly<Record<string, EditableDocumentContent>>,
  ): Record<string, unknown> {
    const base = this.stored.authoringState ?? {};
    const priorSources = base["sources"];
    if (priorSources !== undefined && !isRecord(priorSources))
      throw new Error("The stored source claims are malformed; keeping would discard them.");
    const authoring = this.candidateAuthoring(documents);
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
   * committed baseline only when the admission's own acknowledgement accepts
   * this exact selection; a superseded selection leaves the newer baseline
   * alone. The reservation ends only after the durable result and the baseline
   * bookkeeping have settled — success, refusal and supersession alike.
   */
  private async commitAdmitted(
    state: CandidateState,
    admission: DraftKeepAdmission,
  ): Promise<EditableKeepResult> {
    try {
      const result = await commitProject(state.request!);
      state.receipt = result.receipt;
      const saved: EditableSavedIdentity = Object.freeze({ ...result.receipt.saved });
      if (this.draft.acknowledgeAdmittedKeep(admission)) {
        this.saved = saved;
        this.files = state.files;
      }
      return Object.freeze({
        kind: "savedOnly",
        commitId: state.commitId,
        saved,
        warnings: Object.freeze([...result.warnings]),
        creative:
          result.receipt.creative === undefined
            ? undefined
            : Object.freeze({ ...result.receipt.creative }),
      });
    } finally {
      this.draft.finishKeepAdmission(admission);
    }
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
        creative:
          result.receipt.creative === undefined
            ? undefined
            : Object.freeze({ ...result.receipt.creative }),
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
    throw new Error("This draft belongs to an older saved project. Choose Download or Discard.");
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
