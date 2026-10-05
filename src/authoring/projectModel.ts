/** One current document set, with an independently identified last admissible image. */
import { checkProjectDocumentKey } from "./projectDocumentKey.ts";
import { isCompiledProjectDocuments, type ProjectDocumentsCompile } from "./projectDocuments.ts";
import {
  copyProjectDocuments,
  diffProjectDocuments,
  projectDocumentId,
  projectContentHash,
  type ProjectChange,
  type ProjectContent,
  type ProjectDigest,
} from "./projectContent.ts";

export interface ProjectImage {
  readonly documentId: string;
  readonly identity: ProjectDocumentsCompile["build"]["identity"];
  documents(): Readonly<Record<string, ProjectContent>>;
  files(): ReadonlyMap<string, Uint8Array>;
}
export interface ProjectSnapshot {
  readonly revision: number;
  readonly documentId: string;
  readonly keys: readonly string[];
  readonly lastAdmissibleBuild: ProjectImage | undefined;
  read(
    key: string,
  ):
    | { readonly key: string; readonly version: number; readonly content: ProjectContent }
    | undefined;
  version(key: string): number;
  documents(): Readonly<Record<string, ProjectContent>>;
}
export interface ProjectProposal {
  readonly base: ProjectSnapshot;
  readonly label: string;
  readonly baseRevision: number;
  changes(): readonly ProjectChange[];
  documents(): Readonly<Record<string, ProjectContent>>;
}
export interface ProjectApplication {
  readonly proposal: ProjectProposal;
  readonly documentId: string;
}
interface ApplicationState {
  readonly proposal: ProjectProposal;
  readonly documents: Readonly<Record<string, ProjectContent>>;
  readonly image: ProjectImage | undefined;
  consumed: boolean;
}

function captureImage(build: ProjectDocumentsCompile, digest: ProjectDigest): ProjectImage {
  if (!isCompiledProjectDocuments(build))
    throw new Error("Project image must be an issued compiled result.");
  const documents = copyProjectDocuments(build.documents());
  const files = new Map([...build.files()].map(([key, value]) => [key, new Uint8Array(value)]));
  return Object.freeze({
    documentId: projectDocumentId(documents, digest),
    identity: Object.freeze({ ...build.build.identity }),
    documents: () => copyProjectDocuments(documents),
    files: () => new Map([...files].map(([key, value]) => [key, new Uint8Array(value)])),
  });
}

export class ProjectModel {
  private readonly digest: ProjectDigest;
  private documents: Readonly<Record<string, ProjectContent>>;
  private versions: Record<string, number>;
  private revision = 0;
  private captured: ProjectSnapshot | undefined;
  private readonly hashes: Record<string, { version: number; hash: string }> = {};
  private image: ProjectImage | undefined;
  private readonly snapshots = new WeakSet<ProjectSnapshot>();
  private readonly proposals = new WeakSet<ProjectProposal>();
  private readonly appliedProposals = new WeakSet<ProjectProposal>();
  private readonly applications = new WeakMap<ProjectApplication, ApplicationState>();

  constructor(input: {
    readonly documents: Readonly<Record<string, ProjectContent>>;
    readonly digest: ProjectDigest;
    readonly build?: ProjectDocumentsCompile;
  }) {
    this.digest = input.digest;
    this.documents = copyProjectDocuments(input.documents);
    this.versions = Object.fromEntries(Object.keys(this.documents).map((key) => [key, 1]));
    this.image = input.build === undefined ? undefined : captureImage(input.build, this.digest);
  }

  capture(): ProjectSnapshot {
    if (this.captured !== undefined) return this.captured;
    const documents = this.documents;
    const manifest = Object.keys(documents)
      .sort()
      .map((key) => {
        let cached = this.hashes[key];
        if (cached === undefined || cached.version !== this.versions[key]) {
          cached = {
            version: this.versions[key]!,
            hash: projectContentHash(documents[key]!, this.digest),
          };
          this.hashes[key] = cached;
        }
        return [key, typeof documents[key] === "string" ? "text" : "bytes", cached.hash];
      });
    const documentId = projectContentHash(JSON.stringify(manifest), this.digest);
    const versions = Object.freeze({ ...this.versions });
    const snapshot: ProjectSnapshot = Object.freeze({
      revision: this.revision,
      documentId,
      keys: Object.freeze(Object.keys(documents)),
      lastAdmissibleBuild: this.image,
      read(key: string) {
        checkProjectDocumentKey(key);
        const content = documents[key];
        return content === undefined
          ? undefined
          : Object.freeze({
              key,
              version: versions[key]!,
              content: content instanceof Uint8Array ? new Uint8Array(content) : content,
            });
      },
      version(key: string) {
        checkProjectDocumentKey(key);
        return versions[key] ?? 0;
      },
      documents: () => copyProjectDocuments(documents),
    });
    this.snapshots.add(snapshot);
    this.captured = snapshot;
    return snapshot;
  }

  propose(
    base: ProjectSnapshot,
    label: string,
    changes: readonly ProjectChange[],
  ): ProjectProposal {
    if (!this.snapshots.has(base))
      throw new Error("Project snapshot is foreign; use an owned capture.");
    if (typeof label !== "string" || label.length > 1024)
      throw new Error("Invalid project edit label.");
    const seen = new Set<string>();
    const documents = { ...base.documents() };
    for (const { key, content } of changes) {
      checkProjectDocumentKey(key);
      if (seen.has(key)) throw new Error(`Duplicate project change: ${key}`);
      seen.add(key);
      if (content === null) delete documents[key];
      else if (typeof content === "string" || content instanceof Uint8Array)
        documents[key] = content instanceof Uint8Array ? new Uint8Array(content) : content;
      else throw new Error(`Invalid project document ${key}: expected text or bytes.`);
    }
    const owned = copyProjectDocuments(documents);
    const proposal = Object.freeze({
      base,
      label,
      baseRevision: base.revision,
      changes: () => diffProjectDocuments(base.documents(), owned),
      documents: () => copyProjectDocuments(owned),
    });
    this.proposals.add(proposal);
    return proposal;
  }

  /** Preparation issues authority; source-only applications carry no replacement image. */
  issueApplication(proposal: ProjectProposal, build?: ProjectDocumentsCompile): ProjectApplication {
    this.checkProposal(proposal);
    const documents = proposal.documents();
    const documentId = projectDocumentId(documents, this.digest);
    const image = build === undefined ? undefined : captureImage(build, this.digest);
    if (image !== undefined && image.documentId !== documentId)
      throw new Error("Build documents differ from the project proposal.");
    const application = Object.freeze({ proposal, documentId });
    this.applications.set(application, { proposal, documents, image, consumed: false });
    return application;
  }

  apply(application: ProjectApplication): ProjectSnapshot {
    const state = this.applications.get(application);
    if (!state || state.consumed)
      throw new Error("Project application must be issued and unconsumed.");
    this.checkProposal(state.proposal);
    const changes = diffProjectDocuments(this.documents, state.documents);
    for (const { key } of changes) this.versions[key] = (this.versions[key] ?? 0) + 1;
    if (changes.length > 0) {
      this.documents = state.documents;
      this.revision++;
    }
    if (state.image !== undefined) this.image = state.image;
    this.captured = undefined;
    state.consumed = true;
    this.appliedProposals.add(state.proposal);
    return this.capture();
  }

  /** Session-local evidence for History settlement; matching bytes confer no authority. */
  hasApplied(proposal: ProjectProposal): boolean {
    return this.appliedProposals.has(proposal);
  }

  private checkProposal(proposal: ProjectProposal): void {
    if (!this.proposals.has(proposal))
      throw new Error("Project proposal must be issued by this model.");
    if (proposal.baseRevision !== this.revision) throw new Error("Project proposal is stale.");
  }
}
