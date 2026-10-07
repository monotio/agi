/** Correlated MAIN admission with read-only reconciliation of a lost acknowledgement. */
import type { ProjectDocumentsCompile } from "../../../src/authoring/projectDocuments.ts";
import type { ProjectImage } from "../../../src/authoring/projectModel.ts";
import { projectDocumentId } from "../../../src/authoring/projectContent.ts";
import { writeProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { WorkerQueryTimeoutError } from "./workerQueries.ts";
import type { RoomLaunchRequest } from "../worker/roomLaunch.ts";
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
  readonly waitForContinue?: () => Promise<void> | undefined;
  readonly acceptedImage?: () => ProjectImage | undefined;
}) {
  let identity = { ...input.identity };
  let runToken = input.runToken;
  let disposed = false;
  const current = () => !disposed && input.current();
  async function admit(
    compiled: ProjectDocumentsCompile,
    origins: { key: string; version: number }[],
    mode?: "restart" | "reenter" | "keep",
    preparedRoom = false,
    launch?: RoomLaunchRequest,
  ): Promise<PreviewUpdateOutcome> {
    // A Launch validates a replacement without executing the abandoned stopped run.
    const continuation = mode === "reenter" && launch ? undefined : input.waitForContinue?.();
    if (continuation) await continuation;
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
    let expectedIdentity = identity;
    const status =
      preparedRoom || input.acceptedImage ? await input.query("previewUpdateStatus") : undefined;
    if (status && input.acceptedImage) {
      // The opening grant can predate a room's publication. Follow only the
      // exact image already owned by the editor; unrelated worker drift refuses.
      const image = input.acceptedImage();
      const landed = status.current;
      if (!current() || status.runToken !== expectedRun)
        throw new Error("The running game was replaced. Reopen the game, then try Update again.");
      if (
        image &&
        landed &&
        landed.documentId === image.documentId &&
        landed.buildId === image.identity.buildId &&
        landed.revision === (preparedRoom ? candidate.revision : image.identity.revision)
      ) {
        identity = { ...landed };
        expectedIdentity = identity;
      }
    }
    if (preparedRoom) {
      // A room answer installs native resources to resume new.room. Adopt only
      // that exact compiled image on the same run, before publishing documents.
      const landed = status!.current;
      if (
        !current() ||
        status!.runToken !== expectedRun ||
        landed === null ||
        landed.epoch !== identity.epoch ||
        landed.buildId !== identity.buildId ||
        landed.updateSerial !== identity.updateSerial ||
        landed.documentId !== identity.documentId ||
        landed.revision !== candidate.revision
      )
        throw new Error(
          "The game changed while this room was being built. Reopen the game, then try again.",
        );
      expectedIdentity = landed;
    }
    let outcome: PreviewUpdateOutcome;
    try {
      const reply = await input.query("previewUpdate", {
        runToken: expectedRun,
        ...(preparedRoom ? { mode: "adoptRoom" as const } : mode === undefined ? {} : { mode }),
        expected: expectedIdentity,
        candidate,
        ...(launch ? { launch } : {}),
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
    admitPreparedRoom(
      compiled: ProjectDocumentsCompile,
      origins: { key: string; version: number }[],
    ) {
      return admit(compiled, origins, undefined, true);
    },
    restart(compiled: ProjectDocumentsCompile, origins: { key: string; version: number }[]) {
      return admit(compiled, origins, "restart");
    },
    reenter(
      compiled: ProjectDocumentsCompile,
      origins: { key: string; version: number }[],
      launch?: RoomLaunchRequest,
    ) {
      return admit(compiled, origins, "reenter", false, launch);
    },
    dispose() {
      disposed = true;
    },
  };
}
