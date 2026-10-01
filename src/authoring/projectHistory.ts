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
  type ProjectCommitMetadata,
  type ProjectHistoryCommit,
  type ProjectHistoryState,
} from "./projectHistoryData.ts";
import {
  readProjectHistory,
  writeProjectHistory,
  PROJECT_HISTORY_LIMITS,
} from "./projectHistoryCodec.ts";
import type { ProjectModel, ProjectProposal } from "./projectModel.ts";

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
  private readonly actions = new WeakMap<ProjectHistoryAction, ActionState>();

  constructor(digest: ProjectDigest, state?: ProjectHistoryState) {
    this.digest = digest;
    this.state =
      state === undefined
        ? Object.freeze({
            blobs: Object.freeze({}),
            commits: Object.freeze([]),
            cursor: null,
            future: Object.freeze([]),
            tags: Object.freeze({}),
          })
        : readProjectHistory(writeProjectHistory(state, digest), digest);
  }

  capture(): ProjectHistoryState {
    return Object.freeze({
      ...this.state,
      blobs: Object.freeze(
        Object.fromEntries(
          Object.entries(this.state.blobs).map(([key, value]) => [
            key,
            value instanceof Uint8Array ? new Uint8Array(value) : value,
          ]),
        ),
      ),
    });
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
    for (const [key, content] of Object.entries(owned)) {
      const hash = projectContentHash(content, this.digest);
      if (Object.hasOwn(blobs, hash) && !sameProjectContent(blobs[hash], content))
        throw new Error("Project blob hash collision between distinct content or content types.");
      blobs[hash] ??= content;
      manifest[key] = hash;
    }
    const changed = changedProjectManifest(previous, manifest);
    if (parent !== null && changed.length === 0) return null;
    return this.append(manifest, blobs, metadata, false);
  }

  private append(
    manifest: Readonly<Record<string, string | null>>,
    blobs: Readonly<Record<string, ProjectContent>>,
    metadata: ProjectCommitMetadata,
    force: boolean,
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
    // Bounds, parent/diff and hashes are checked before changing live History.
    this.state = readProjectHistory(
      writeProjectHistory(
        {
          ...(this.state.prunedParents !== undefined
            ? { prunedParents: this.state.prunedParents }
            : {}),
          blobs,
          commits: [...this.state.commits, commit],
          cursor: commit.id,
          future: [],
          tags: this.state.tags,
        },
        this.digest,
      ),
      this.digest,
    );
    return this.commit(commit.id);
  }

  tag(name: string, id: string): void {
    this.commit(id);
    if (Object.hasOwn(this.state.tags, name) && this.state.tags[name] !== id)
      throw new Error("Project version name already exists.");
    this.state = readProjectHistory(
      writeProjectHistory({ ...this.state, tags: { ...this.state.tags, [name]: id } }, this.digest),
      this.digest,
    );
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
    writeProjectHistory(
      { ...this.state, commits: [...this.state.commits, commit], cursor: commit.id, future: [] },
      this.digest,
    );
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
