/** Correlated MAIN admission with read-only reconciliation of a lost acknowledgement. */
import type { ProjectDocumentsCompile } from "../../../src/authoring/projectDocuments.ts";
import { projectDocumentId } from "../../../src/authoring/projectContent.ts";
import { writeProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { WorkerQueryTimeoutError } from "./workerQueries.ts";
import type {
  PreviewLaneIdentity,
  PreviewUpdateOutcome,
  WorkerQueryFn,
  SourceBindingKind,
} from "../worker/workerProtocol.ts";

export function createMainProjectAdmission(input: {
  readonly runToken: string;
  readonly identity: PreviewLaneIdentity;
  readonly query: WorkerQueryFn;
  readonly current: () => boolean;
}) {
  let identity = { ...input.identity };
  let runToken = input.runToken;
  let disposed = false;
  const current = () => !disposed && input.current();
  async function admit(
    compiled: ProjectDocumentsCompile,
    origins: { key: string; version: number }[],
    mode?: "restart",
  ): Promise<PreviewUpdateOutcome> {
    if (!current()) throw new Error("Project run was replaced.");
    const documents = compiled.documents();
    const sources: Record<string, string> = {};
    for (const [key, content] of Object.entries(documents)) {
      if (key.startsWith("logic:") && typeof content === "string") sources[key.slice(6)] = content;
    }
    const bindings = documents["bindings"];
    const candidate = {
      files: Object.fromEntries(compiled.files()),
      profile: compiled.build.identity.profileId,
      sources,
      sourceBindings:
        typeof bindings === "string"
          ? (JSON.parse(bindings) as Record<string, { kind: SourceBindingKind; num: number }>)
          : {},
      buildId: compiled.build.identity.buildId,
      revision: compiled.build.identity.revision,
      documents: writeProjectWorkspace(documents),
      documentId: projectDocumentId(documents, sha256Hex),
      origins,
    };
    const expectedRun = runToken;
    let outcome: PreviewUpdateOutcome;
    try {
      const reply = await input.query("previewUpdate", {
        runToken: expectedRun,
        ...(mode === undefined ? {} : { mode }),
        expected: identity,
        candidate,
      });
      if (reply.runToken !== expectedRun)
        throw new Error("Project acknowledgement belongs to another run.");
      outcome = reply;
    } catch (error) {
      if (!(error instanceof WorkerQueryTimeoutError) || !current()) throw error;
      const status = await input.query("previewUpdateStatus", { transactionId: error.id });
      if (
        typeof status.transaction !== "object" ||
        status.transaction === null ||
        status.transaction.id !== error.id
      )
        throw new Error("Project admission acknowledgement is unavailable.", { cause: error });
      outcome = status.transaction.outcome;
      if (status.runToken !== expectedRun && status.runToken !== outcome.replacementRunToken)
        throw new Error("Project acknowledgement belongs to another run.", { cause: error });
    }
    if (!current()) throw new Error("Project run was replaced.");
    if (outcome.status === "committed" || outcome.status === "unchanged") {
      if (
        outcome.current?.documentId !== candidate.documentId ||
        outcome.current.buildId !== candidate.buildId ||
        outcome.current.revision !== candidate.revision
      )
        throw new Error("Project acknowledgement names another image.");
      if (mode === "restart" && !outcome.replacementRunToken)
        throw new Error("Project restart acknowledgement carries no replacement token.");
      identity = { ...outcome.current };
      runToken = outcome.replacementRunToken ?? runToken;
    }
    return outcome;
  }
  return {
    get runToken() {
      return runToken;
    },
    admit,
    restart(compiled: ProjectDocumentsCompile, origins: { key: string; version: number }[]) {
      return admit(compiled, origins, "restart");
    },
    dispose() {
      disposed = true;
    },
  };
}
