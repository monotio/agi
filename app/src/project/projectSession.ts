/** One editable model and immutable History for an opened project's lifetime. */
import { parseWordsTok } from "../../../src/logic/words.ts";
import {
  ProjectModel,
  type ProjectProposal,
  type ProjectSnapshot,
} from "../../../src/authoring/projectModel.ts";
import {
  ProjectHistory,
  type ProjectHistoryAction,
} from "../../../src/authoring/projectHistory.ts";
import {
  readProjectHistory,
  writeProjectHistory,
} from "../../../src/authoring/projectHistoryCodec.ts";
import { compileWorkingProjectImage } from "./projectWorkingImage.ts";
import {
  prepareProjectEdit,
  type PreparedProjectEdit,
} from "../../../src/authoring/projectEdit.ts";
import { prepareAndAdmitProjectEdit } from "./projectWritePipeline.ts";
import type { ProjectDocumentsCompile } from "../../../src/authoring/projectDocuments.ts";
import type { ProjectCommitMetadata } from "../../../src/authoring/projectHistoryData.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { inspectEditableProject } from "./projectWorkspaceSource.ts";
import {
  authoringFingerprint,
  commitProject,
  type ProjectCommitRequest,
  type ProjectCommitReceipt,
} from "./gameStorage.ts";
import { createProjectAutosave } from "./projectAutosave.ts";
import type { CachedGameData } from "./gameTypes.ts";
import type { PreviewUpdateOutcome } from "../worker/workerProtocol.ts";

interface SessionSave {
  readonly snapshot: ProjectSnapshot;
  readonly data: ProjectCommitRequest["data"];
  request?: ProjectCommitRequest;
}
export interface PendingProjectRestart {
  readonly action: "restart" | "reenter";
  readonly reason: string;
}

function restartReason(reason: string): string {
  return reason
    .replace(/^preview candidate /, "This change ")
    .replace(/; restart applies.*$/, "")
    .replace(
      /logic (\d+) holds a nonzero scan.start resume offset/,
      "LOGIC $1 remembers a position in its instructions.",
    )
    .replace(
      /view (\d+) changes its loop\/cel layout while loaded/,
      "VIEW $1 has new loops or cels for a loaded actor.",
    )
    .replace(
      /view (\d+) changes the live geometry of object (\d+)/,
      "VIEW $1 changes the size of actor $2.",
    )
    .replace(/view (\d+) is baked into add.to.pic/, "VIEW $1 is drawn into the room background.")
    .replace(/\bview\b/g, "VIEW")
    .replace(/\blogic\b/g, "LOGIC")
    .replace(/\bpicture\b/g, "PICTURE");
}
const owners = new Map<string, ReturnType<typeof createSession>>();
export function openProjectSession(input: Parameters<typeof createSession>[0]) {
  const previous = owners.get(input.data.projectId);
  if (
    previous !== undefined &&
    previous.runToken === input.admission.runToken &&
    previous.lifetime === input.lifetime
  )
    return previous;
  previous?.dispose();
  const session = createSession(input);
  owners.set(input.data.projectId, session);
  return session;
}
function createSession(input: {
  readonly data: CachedGameData;
  readonly lifetime: string;
  readonly admission: {
    readonly runToken: string;
    admit(
      compiled: ProjectDocumentsCompile,
      versions: { key: string; version: number }[],
    ): Promise<PreviewUpdateOutcome>;
    restart?(
      compiled: ProjectDocumentsCompile,
      versions: { key: string; version: number }[],
    ): Promise<PreviewUpdateOutcome>;
    reenter?(
      compiled: ProjectDocumentsCompile,
      versions: { key: string; version: number }[],
    ): Promise<PreviewUpdateOutcome>;
  };
  readonly current?: () => boolean;
  readonly boundary?: () => Promise<void>;
  readonly write?: (request: ProjectCommitRequest) => Promise<ProjectCommitReceipt>;
  readonly publish?: (
    snapshot: ProjectSnapshot,
    data: ProjectCommitRequest["data"],
    outcome?: PreviewUpdateOutcome,
  ) => void;
  readonly changed?: () => void;
}) {
  const data = structuredClone(input.data);
  const inspection = inspectEditableProject(data);
  const history = new ProjectHistory(
    sha256Hex,
    data.projectHistory === undefined
      ? undefined
      : readProjectHistory(data.projectHistory, sha256Hex),
  );
  const documents =
    data.workspace === undefined
      ? inspection.documents
      : data.projectHistory === undefined
        ? { ...inspection.documents, ...readProjectWorkspace(data.workspace) }
        : readProjectWorkspace(data.workspace);
  const build = compileWorkingProjectImage({
    files: data.files,
    documents,
    fallback: inspection.documents,
    history: history.capture(),
    profileId: inspection.profileId,
  });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  if (history.capture().cursor === null)
    history.record(documents, {
      label: "Opened",
      origin: "template",
      author: "creator",
      time: Date.now(),
    });
  let pendingRestart: PendingProjectRestart | null = null;
  let disposed = false;
  let epoch = 0;
  let serial = 0;
  let tail = Promise.resolve();
  let diagnostics: PreparedProjectEdit["diagnostics"] = prepareProjectEdit({
    model,
    proposal: model.propose(model.capture(), "Opened", []),
    profileId: inspection.profileId,
    policy: { allowMissingRooms: data.roomGeneration === true },
  }).diagnostics;
  const observers = new Set<() => void>();
  let expected: NonNullable<ProjectCommitRequest["expected"]> = {
    projectId: data.projectId,
    lifetime: input.lifetime,
    generation: data.generation ?? 0,
    revision: computeResourceRevision(data.files),
    authoring: authoringFingerprint(data.authoringState, data.workspace),
    buildId: build.build.identity.buildId,
  };
  const current = () => !disposed && (input.current?.() ?? true);
  const versions = (snapshot: ProjectSnapshot) =>
    snapshot.keys.map((key) => ({ key, version: snapshot.version(key) }));
  function notify() {
    if (!current()) return;
    input.changed?.();
    for (const observer of observers) {
      try {
        observer();
      } catch {
        /* A presentation observer cannot cancel the owned save. */
      }
    }
  }
  const autosave = createProjectAutosave<SessionSave, ProjectCommitReceipt>({
    current,
    write: async (capture) => {
      capture.request ??= {
        projectId: data.projectId,
        workspaceId: `session-${input.lifetime}`,
        commitId: `edit-${input.admission.runToken}-${++serial}`,
        expected: { ...expected },
        buildId: capture.snapshot.lastAdmissibleBuild!.identity.buildId,
        documents: versions(capture.snapshot),
        data: capture.data,
      };
      return input.write === undefined
        ? (await commitProject(capture.request)).receipt
        : input.write(capture.request);
    },
    saved: (receipt) => {
      expected = { ...receipt.saved };
    },
    conflict: (error) =>
      error instanceof Error &&
      ["ConcurrencyConflictError", "ProjectDeletedError", "StaleAuthoringError"].includes(
        error.name,
      ),
    changed: notify,
  });
  function captureSave(snapshot: ProjectSnapshot, outcome?: PreviewUpdateOutcome) {
    const image = snapshot.lastAdmissibleBuild!;
    const next = {
      ...data,
      files: Object.fromEntries(image.files()),
      workspace: writeProjectWorkspace(snapshot.documents()),
      projectHistory: writeProjectHistory(history.capture(), sha256Hex),
    };
    if (next.files["WORDS.TOK"] !== undefined)
      next.words = parseWordsTok(next.files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
    input.publish?.(snapshot, next, outcome);
    autosave.enqueue({ snapshot, data: next });
  }
  async function apply(
    proposal: ProjectProposal,
    metadata: ProjectCommitMetadata,
    action?: ProjectHistoryAction,
  ) {
    if (!current() || autosave.status().state === "conflict")
      throw new Error("Project session is closed for writes.");
    const fence = {
      projectId: data.projectId,
      lifetime: input.lifetime,
      sessionEpoch: epoch,
      workerRunToken: input.admission.runToken,
      generation: expected.generation,
    };
    const { prepared, outcome } = await prepareAndAdmitProjectEdit({
      model,
      proposal,
      profileId: inspection.profileId,
      allowMissingRooms: data.roomGeneration === true,
      current: () =>
        current() &&
        epoch === fence.sessionEpoch &&
        data.projectId === fence.projectId &&
        input.lifetime === fence.lifetime &&
        input.admission.runToken === fence.workerRunToken &&
        expected.generation >= fence.generation,
      preflight() {
        if (action === undefined)
          new ProjectHistory(sha256Hex, history.capture()).record(proposal.documents(), metadata);
      },
      admit: (compiled, documents) => input.admission.admit(compiled, documents),
      boundary: input.boundary ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50))),
    });
    if (
      outcome !== undefined &&
      outcome.status !== "committed" &&
      outcome.status !== "unchanged" &&
      outcome.status !== "restartRequired"
    )
      return { ...outcome, diagnostics: prepared.diagnostics };
    if (outcome?.status === "restartRequired")
      pendingRestart = {
        action: outcome.roomReentry === true ? "reenter" : "restart",
        reason: restartReason(outcome.reason ?? "This image needs a game restart."),
      };
    else if (prepared.compiled !== undefined) pendingRestart = null;
    diagnostics = prepared.diagnostics;
    const snapshot = model.apply(prepared.application);
    if (action !== undefined) history.accept(action);
    else history.record(snapshot.documents(), metadata);
    captureSave(snapshot, outcome);
    return {
      status:
        outcome?.status === "restartRequired"
          ? ("restartRequired" as const)
          : prepared.compiled === undefined
            ? ("diagnostics" as const)
            : ("committed" as const),
      diagnostics: prepared.diagnostics,
    };
  }
  function schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function activate(mode: "restart" | "reenter") {
    if (!current() || autosave.status().state === "conflict")
      throw new Error("Project session is closed for writes.");
    if (pendingRestart === null) return undefined;
    const before = model.capture();
    const prepared = prepareProjectEdit({
      model,
      proposal: model.propose(before, mode === "restart" ? "Restart" : "Re-enter room", []),
      profileId: inspection.profileId,
      policy: { allowMissingRooms: data.roomGeneration === true },
    });
    if (prepared.compiled === undefined)
      return { status: "diagnostics" as const, diagnostics: prepared.diagnostics };
    const admit = mode === "restart" ? input.admission.restart : input.admission.reenter;
    if (admit === undefined) throw new Error("The running game cannot use this action.");
    let outcome: PreviewUpdateOutcome;
    do {
      if (!current()) throw new Error("Project session was closed.");
      outcome = await admit(prepared.compiled, versions(before));
      if (!current()) throw new Error("Project action was superseded.");
      if (outcome.status === "deferred")
        await (input.boundary?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 50)));
    } while (outcome.status === "deferred");
    if (!current() || before.documentId !== model.capture().documentId)
      throw new Error("Project restart was superseded.");
    if (outcome.status === "committed" || outcome.status === "unchanged") {
      pendingRestart = null;
      captureSave(model.apply(prepared.application), outcome);
    }
    if (outcome.status === "restartRequired") {
      pendingRestart = {
        action: outcome.roomReentry === true ? "reenter" : "restart",
        reason: restartReason(outcome.reason ?? "This image needs a game restart."),
      };
      notify();
    }
    return outcome;
  }
  const session = {
    model,
    history,
    lifetime: input.lifetime,
    get runToken() {
      return input.admission.runToken;
    },
    get pendingRestart() {
      return pendingRestart;
    },
    restartWithChanges() {
      return schedule(() => activate("restart"));
    },
    reenterRoom() {
      return schedule(() => activate("reenter"));
    },
    submit(edit: { proposal: ProjectProposal } & Omit<ProjectCommitMetadata, "time">) {
      return schedule(() =>
        apply(edit.proposal, {
          label: edit.label,
          origin: edit.origin,
          author: edit.author,
          time: Date.now(),
        }),
      );
    },
    undo() {
      return schedule(async () => {
        const action = history.undo(model);
        return action === undefined
          ? undefined
          : apply(
              action.proposal,
              { label: "Undo", origin: "history", author: "creator", time: Date.now() },
              action,
            );
      });
    },
    redo() {
      return schedule(async () => {
        const action = history.redo(model);
        return action === undefined
          ? undefined
          : apply(
              action.proposal,
              { label: "Redo", origin: "history", author: "creator", time: Date.now() },
              action,
            );
      });
    },
    restore(id: string) {
      return schedule(() => {
        const metadata = { label: "Restore", author: "creator" as const, time: Date.now() };
        const action = history.restore(model, id, metadata);
        return apply(action.proposal, { ...metadata, origin: "history" }, action);
      });
    },
    tag(name: string) {
      return schedule(async () => {
        if (!current()) throw new Error("Project session was closed.");
        const cursor = history.capture().cursor;
        if (cursor !== null) {
          history.tag(name, cursor);
          captureSave(model.capture());
        }
      });
    },
    async flush() {
      await tail;
      await autosave.flush();
    },
    retry: autosave.retry,
    capture() {
      return {
        snapshot: model.capture(),
        history: history.capture(),
        diagnostics,
        pendingRestart,
        save: autosave.status(),
      };
    },
    subscribe(observer: () => void) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    saveStatus: autosave.status,
    stopWrites: autosave.stop,
    dispose() {
      disposed = true;
      epoch++;
      autosave.dispose();
      observers.clear();
      if (owners.get(data.projectId) === session) owners.delete(data.projectId);
    },
  };
  return session;
}
export type ProjectSession = ReturnType<typeof openProjectSession>;
