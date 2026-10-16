/** Immutable content-addressed edit commits and session Undo/Redo navigation. */
import {
  copyProjectDocuments,
  diffProjectDocuments,
  projectContentHash,
  sameProjectContent,
  type ProjectContent,
  type ProjectDigest,
} from "./projectContent.ts";
import {
  changedProjectManifest,
  projectCommitId,
  sealPortableProjectHistory,
  type ProjectCommitMetadata,
  type ProjectHistoryCommit,
  type ProjectHistoryState,
} from "./projectHistoryData.ts";
import {
  checkProjectHistoryState,
  PROJECT_HISTORY_FORMAT,
  PROJECT_HISTORY_LIMITS,
  type PortableProjectHistory,
} from "./projectHistoryCodec.ts";
import { pruneProjectHistory } from "./projectHistoryPruning.ts";
import type { ProjectModel, ProjectProposal } from "./projectModel.ts";

interface HistoryTotals {
  readonly entries: number;
  readonly bytes: number;
  readonly images: boolean;
}

// Seals are process-local capabilities: cloning or decoding never confers trust.
const snapshots = new WeakMap<
  ProjectHistoryState,
  { state: ProjectHistoryState; digest: ProjectDigest; totals: HistoryTotals }
>();
const portableBytes = new WeakMap<
  Uint8Array,
  { readonly type: "bytes"; readonly bytes: readonly number[] }
>();

export interface ProjectHistoryAction {
  readonly proposal: ProjectProposal;
  readonly target: string;
  readonly direction: "undo" | "redo" | "restore";
}
interface ActionState {
  readonly model: ProjectModel;
  readonly cursor: string | null;
  readonly future: readonly string[];
  readonly documents: Readonly<Record<string, ProjectContent>>;
  readonly metadata: ProjectCommitMetadata | undefined;
  consumed: boolean;
}

export class ProjectHistory {
  private readonly digest: ProjectDigest;
  private state: ProjectHistoryState;
  private totals: HistoryTotals;
  private readonly forkBase: ProjectHistoryState | undefined;
  private readonly actions = new WeakMap<ProjectHistoryAction, ActionState>();

  constructor(digest: ProjectDigest, state?: ProjectHistoryState) {
    this.digest = digest;
    const offered = state === undefined ? undefined : snapshots.get(state);
    const sealed = offered?.digest === digest ? offered : undefined;
    this.state =
      state === undefined
        ? Object.freeze({
            blobs: Object.freeze({}),
            commits: Object.freeze([]),
            cursor: null,
            future: Object.freeze([]),
            tags: Object.freeze({}),
          })
        : sealed !== undefined
          ? sealed.state
          : checkProjectHistoryState(state, digest);
    if (state !== undefined && sealed === undefined) {
      // An imported history may carry unused blobs. Reclaim them once at admission,
      // so sealed captures can be saved without scanning every retained manifest.
      const reachable = new Set(
        this.state.commits.flatMap((commit) => Object.values(commit.documents)),
      );
      this.state = Object.freeze({
        ...this.state,
        blobs: Object.freeze(
          Object.fromEntries(
            Object.entries(this.state.blobs).filter(([hash]) => reachable.has(hash)),
          ),
        ),
      });
    }
    this.forkBase = sealed?.state;
    for (const commit of this.state.commits) Object.freeze(commit.changed);
    this.totals = sealed?.totals ?? this.measureTotals();
  }

  private measureTotals(state: ProjectHistoryState = this.state): HistoryTotals {
    return {
      entries: state.commits.reduce((sum, commit) => sum + Object.keys(commit.documents).length, 0),
      bytes: Object.values(state.blobs).reduce<number>(
        (sum, content) => sum + (typeof content === "string" ? content.length * 2 : content.length),
        0,
      ),
      images: state.commits.some((commit) =>
        Object.keys(commit.documents).some((key) => key.startsWith("attachment:")),
      ),
    };
  }

  capture(): ProjectHistoryState {
    const blobs = Object.create(null) as Record<string, ProjectContent>;
    for (const [key, value] of Object.entries(this.state.blobs))
      Object.defineProperty(blobs, key, {
        enumerable: true,
        get: () => (value instanceof Uint8Array ? value.slice() : value),
      });
    const snapshot = Object.freeze({ ...this.state, blobs: Object.freeze(blobs) });
    snapshots.set(snapshot, { state: this.state, digest: this.digest, totals: this.totals });
    return snapshot;
  }

  /** Immutable portable envelope; only newly encountered byte blobs need number arrays. */
  capturePortable(): PortableProjectHistory {
    const blobs = Object.fromEntries(
      Object.entries(this.state.blobs).map(([hash, content]) => {
        if (typeof content === "string")
          return [hash, Object.freeze({ type: "text" as const, text: content })];
        let blob = portableBytes.get(content);
        if (blob === undefined) {
          let bytes: readonly number[] | undefined;
          blob = Object.freeze({
            type: "bytes" as const,
            get bytes() {
              return (bytes ??= Object.freeze(Array.from(content)));
            },
          });
          portableBytes.set(content, blob);
        }
        return [hash, blob];
      }),
    );
    const portable = Object.freeze({
      format: PROJECT_HISTORY_FORMAT,
      version: 1 as const,
      ...this.state,
      blobs: Object.freeze(blobs),
    });
    sealPortableProjectHistory(portable, this.capture(), this.digest);
    return portable;
  }

  /** Install the checked preflight fork once, while its original base is still current. */
  acceptRecorded(prospective: ProjectHistory): void {
    if (prospective.digest !== this.digest || prospective.forkBase !== this.state)
      throw new Error("Project History preflight is stale or belongs to another history.");
    this.state = prospective.state;
    this.totals = prospective.totals;
  }

  record(
    documents: Readonly<Record<string, ProjectContent>>,
    metadata: ProjectCommitMetadata,
  ): ProjectHistoryCommit | null {
    const entries = Object.entries(documents);
    if (entries.length > PROJECT_HISTORY_LIMITS.maxDocuments)
      throw new Error("Project History document count exceeds its limit.");
    for (const [key, content] of entries) {
      const size = typeof content === "string" ? content.length * 2 : content.length;
      if (
        size >
        (key.startsWith("attachment:")
          ? PROJECT_HISTORY_LIMITS.maxImageBlobBytes
          : PROJECT_HISTORY_LIMITS.maxBlobBytes)
      )
        throw new Error("Project History blob exceeds its limit.");
    }
    const owned = copyProjectDocuments(documents);
    const parent = this.state.cursor;
    const previous = parent === null ? {} : this.commit(parent).documents;
    const blobs = { ...this.state.blobs };
    const manifest: Record<string, string | null> = Object.fromEntries(
      Object.keys(previous).map((key) => [key, null]),
    );
    let newBytes = 0;
    for (const [key, content] of Object.entries(owned)) {
      const previousHash = previous[key];
      const hash =
        previousHash != null && sameProjectContent(this.state.blobs[previousHash], content)
          ? previousHash
          : projectContentHash(content, this.digest);
      if (Object.hasOwn(blobs, hash) && !sameProjectContent(blobs[hash], content))
        throw new Error("Project blob hash collision between distinct content or content types.");
      if (!Object.hasOwn(blobs, hash))
        newBytes += typeof content === "string" ? content.length * 2 : content.length;
      blobs[hash] ??= content;
      manifest[key] = hash;
    }
    const changed = changedProjectManifest(previous, manifest);
    if (parent !== null && changed.length === 0) return null;
    return this.append(manifest, blobs, metadata, false, newBytes);
  }

  private append(
    manifest: Readonly<Record<string, string | null>>,
    blobs: Readonly<Record<string, ProjectContent>>,
    metadata: ProjectCommitMetadata,
    force: boolean,
    newBytes = 0,
  ): ProjectHistoryCommit | null {
    const parent = this.state.cursor;
    const previous = parent === null ? {} : this.commit(parent).documents;
    const changed = changedProjectManifest(previous, manifest);
    if (!force && parent !== null && changed.length === 0) return null;
    const body = {
      ...metadata,
      parent,
      documents: Object.freeze(
        Object.fromEntries(
          Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      ),
      changed,
    };
    const commit = Object.freeze({ ...body, id: projectCommitId(body, this.digest) });
    const next = this.checkCandidate(commit, blobs, newBytes);
    this.state = next.state;
    this.totals = next.totals;
    return commit;
  }

  private checkCandidate(
    commit: ProjectHistoryCommit,
    blobs: Readonly<Record<string, ProjectContent>>,
    newBytes = 0,
  ): { state: ProjectHistoryState; totals: HistoryTotals } {
    const keys = Object.keys(commit.documents);
    const totals = {
      entries: this.totals.entries + keys.length,
      bytes: this.totals.bytes + newBytes,
      images: this.totals.images || keys.some((key) => key.startsWith("attachment:")),
    };
    const limits = PROJECT_HISTORY_LIMITS;
    const candidate = {
      ...this.state,
      blobs,
      commits: [...this.state.commits, commit],
      cursor: commit.id,
      future: [],
    };
    if (
      candidate.commits.length > limits.maxCommits ||
      Object.keys(blobs).length > limits.maxBlobs ||
      totals.bytes > (totals.images ? limits.maxImageTotalBytes : limits.maxTotalBytes)
    ) {
      const state = pruneProjectHistory(candidate, this.digest).state;
      return {
        state,
        totals: this.measureTotals(state),
      };
    }
    // Retained data is checked and privately owned. Only the new metadata is validated.
    this.checkAppend(commit, totals);
    return {
      state: Object.freeze({
        ...candidate,
        blobs: Object.freeze(blobs),
        commits: Object.freeze(candidate.commits),
        future: Object.freeze(candidate.future),
      }),
      totals,
    };
  }

  private checkAppend(commit: ProjectHistoryCommit, totals: HistoryTotals): void {
    const limits = PROJECT_HISTORY_LIMITS;
    const keys = Object.keys(commit.documents);
    if (keys.length > limits.maxDocuments || totals.entries > limits.maxManifestEntries)
      throw new Error("Invalid project history: manifest exceeds the limit.");
    if (totals.bytes > (totals.images ? limits.maxImageTotalBytes : limits.maxTotalBytes))
      throw new Error("Invalid project history: blob payloads exceed the total limit.");
    // Reuse the codec's metadata contract on a single empty root. Retained commits and
    // blobs never enter this check; the real parent, manifest and diff are built here.
    const body = { ...commit, parent: null, documents: {}, changed: [] };
    const checked = { ...body, id: projectCommitId(body, this.digest) };
    checkProjectHistoryState(
      { blobs: {}, commits: [checked], cursor: checked.id, future: [], tags: {} },
      this.digest,
    );
    if (this.state.commits.some((entry) => entry.id === commit.id))
      throw new Error("Invalid project history: duplicate commit identity.");
  }

  tag(name: string, id: string): void {
    this.commit(id);
    if (Object.hasOwn(this.state.tags, name) && this.state.tags[name] !== id)
      throw new Error("Project version name already exists.");
    this.state = checkProjectHistoryState(
      { ...this.state, tags: { ...this.state.tags, [name]: id } },
      this.digest,
    );
    for (const commit of this.state.commits) Object.freeze(commit.changed);
  }

  renameTag(name: string, next: string | null): void {
    if (!Object.hasOwn(this.state.tags, name)) throw new Error("Project version name is missing.");
    if (next !== null && next !== name && Object.hasOwn(this.state.tags, next))
      throw new Error("Project version name already exists.");
    const tags = { ...this.state.tags };
    const id = tags[name]!;
    delete tags[name];
    const renamed = next === null ? tags : { ...tags, [next]: id };
    this.state = checkProjectHistoryState({ ...this.state, tags: renamed }, this.digest);
    for (const commit of this.state.commits) Object.freeze(commit.changed);
  }

  undo(model: ProjectModel): ProjectHistoryAction | undefined {
    const current = this.state.cursor;
    const parent = current === null ? null : this.commit(current).parent;
    return parent === null || !this.state.commits.some((commit) => commit.id === parent)
      ? undefined
      : this.action(model, parent, "undo");
  }

  redo(model: ProjectModel): ProjectHistoryAction | undefined {
    const target = this.state.future[0];
    return target === undefined ? undefined : this.action(model, target, "redo");
  }

  restore(
    model: ProjectModel,
    id: string,
    metadata: Omit<ProjectCommitMetadata, "origin">,
  ): ProjectHistoryAction {
    const origin: ProjectCommitMetadata = { ...metadata, origin: "history" };
    const parent = this.state.cursor;
    const documents = this.commit(id).documents;
    const body = {
      ...origin,
      parent,
      documents,
      changed: changedProjectManifest(
        parent === null ? {} : this.commit(parent).documents,
        documents,
      ),
    };
    const commit = { ...body, id: projectCommitId(body, this.digest) };
    // Validate the Restore and its bounds before issuing an editable proposal.
    this.checkCandidate(commit, this.state.blobs);
    return this.action(model, id, "restore", origin);
  }

  /** Move only after the target documents were applied through the model. */
  accept(action: ProjectHistoryAction): void {
    const state = this.actions.get(action);
    if (!state || state.consumed) throw new Error("History action must be issued and unconsumed.");
    if (
      state.cursor !== this.state.cursor ||
      state.future.length !== this.state.future.length ||
      state.future.some((id, i) => id !== this.state.future[i])
    )
      throw new Error("History action is stale.");
    if (!state.model.hasApplied(action.proposal))
      throw new Error("History proposal must be applied first.");
    const expectedRevision =
      action.proposal.baseRevision + (action.proposal.changes().length > 0 ? 1 : 0);
    if (state.model.capture().revision !== expectedRevision)
      throw new Error("History application is stale.");
    if (diffProjectDocuments(state.model.capture().documents(), state.documents).length > 0)
      throw new Error("History target documents must be applied first.");
    if (action.direction === "restore")
      this.append(this.commit(action.target).documents, this.state.blobs, state.metadata!, true);
    else
      this.state = Object.freeze({
        ...this.state,
        cursor: action.target,
        future: Object.freeze(
          action.direction === "undo"
            ? [state.cursor!, ...this.state.future]
            : this.state.future.slice(1),
        ),
      });
    state.consumed = true;
  }

  private commit(id: string): ProjectHistoryCommit {
    const commit = this.state.commits.find((commit) => commit.id === id);
    if (!commit) throw new Error("Unknown project History commit.");
    return commit;
  }

  private documents(id: string): Readonly<Record<string, ProjectContent>> {
    return copyProjectDocuments(
      Object.fromEntries(
        Object.entries(this.commit(id).documents)
          .filter((entry): entry is [string, string] => entry[1] !== null)
          .map(([key, hash]) => [key, this.state.blobs[hash]!]),
      ),
    );
  }

  private action(
    model: ProjectModel,
    target: string,
    direction: ProjectHistoryAction["direction"],
    metadata?: ProjectCommitMetadata,
  ): ProjectHistoryAction {
    const base = model.capture();
    if (
      this.state.cursor === null ||
      diffProjectDocuments(base.documents(), this.documents(this.state.cursor)).length > 0
    )
      throw new Error("Current documents differ from the History cursor.");
    const documents = this.documents(target);
    const proposal = model.propose(
      base,
      metadata?.label ?? `${direction === "undo" ? "Undo" : "Redo"} ${this.commit(target).label}`,
      diffProjectDocuments(base.documents(), documents),
    );
    const action = Object.freeze({ proposal, target, direction });
    this.actions.set(action, {
      model,
      cursor: this.state.cursor,
      future: this.state.future,
      documents,
      metadata,
      consumed: false,
    });
    return action;
  }
}
