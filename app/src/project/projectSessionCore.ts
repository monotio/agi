/** One editable model and immutable History for an opened project's lifetime. */
import { migrateAgentChats, readAgentChats, type AgentChats } from "../../../src/agent/chats.ts";
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
import { projectCommitLibrary } from "./gameMetadata.ts";
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
import { requireProjectId } from "../../../src/gameIdentity.ts";
import { inspectEditableProject } from "./projectWorkspaceSource.ts";
import type {
  authoringFingerprint,
  commitProject,
  ProjectCommitRequest,
  ProjectCommitReceipt,
} from "./gameStorage.ts";
import { createProjectAutosave } from "./projectAutosave.ts";
import {
  claimProjectSaveJournal,
  projectSaveJournalKey,
  writeProjectSaveJournal,
} from "./projectSaveJournal.ts";
import type { ProjectChange, ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { CachedGameData } from "./gameTypes.ts";
import {
  captureProjectJournal,
  journalCandidate,
  type ProjectJournalCapture,
} from "./projectJournalCapture.ts";
import type { ProjectJournalOperation } from "./projectJournalReplay.ts";
import type { PreviewUpdateOutcome } from "../worker/workerProtocol.ts";

interface SessionSave {
  readonly snapshot: ProjectSnapshot;
  readonly data: ProjectCommitRequest["data"];
  request?: ProjectCommitRequest;
  attempted?: boolean;
  acknowledged?: true;
  operation: number;
  journal?: ProjectJournalCapture;
}
/* Project save-state model: session documents and MAIN progress have separate owners.
 * State            | Typing; coordinated actions| Flush / Retry     | Exit / Reload
 * writable-clean   | accept, queue save         | drain             | drain, leave / reopen
 * writable-pending | accept, replace pending    | drain             | drain, leave / reopen
 * writable-failed  | retain; action barrier    | exact retry       | hold; Retry or discard
 * stale / removed  | journal typing; refuse rest| refuse            | leave / reopen (stale)
 * recovering       | wait for journal replay    | wait              | wait
 * closed           | refuse                     | refuse            | already left
 * State            | Download project / Export game          | Chip; banner / notes
 * writable-clean   | running image + owned sidecars / game   | Saved
 * pending / failed | flush; accepted edits; report omissions | Saving… / Could not save. Retry
 * stale / removed  | running image; report drafts + sidecars | Changed in another tab / Project removed
 * recovering       | wait for open; Home retains raw recovery| opening; replay or Discard pending edits
 * closed           | Home downloads durable data / game      | workspace gone
 * Transitions: edit -> pending; acknowledgement -> clean; rejection -> failed;
 * external write -> stale; deletion -> removed; reopen -> recovering -> clean;
 * Exit/discard -> closed. Deferred admission publishes MAIN without another save.
 * Source saving never waits for a player interaction; checkpoints await active
 * admission attempts. Name, guided actions and WORDS drain before changing the
 * model. Compatible journals replay before open. Replaced versions
 * retain their journal with a discard banner. Backup/export notes name omitted
 * editor changes and Retry; stale notes name Reload, removed notes name Download.
 * Create reload opens saved documents and keeps an older MAIN checkpoint until
 * another checkpoint replaces it. Explicit Play requires a matching build.
 */
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
interface SessionStorage {
  readonly commit: typeof commitProject;
  readonly fingerprint: typeof authoringFingerprint;
}
const owners = new Map<string, ReturnType<typeof createSession>>();
export function openOwnedProjectSession(
  input: Parameters<typeof createSession>[0],
  storage: SessionStorage,
) {
  const previous = owners.get(input.data.projectId);
  if (
    previous !== undefined &&
    previous.runToken === input.admission.runToken &&
    previous.lifetime === input.lifetime
  )
    return previous;
  previous?.dispose();
  const session = createSession(input, storage);
  owners.set(input.data.projectId, session);
  return session;
}
function createSession(
  input: {
    readonly data: CachedGameData;
    readonly lifetime: string;
    readonly admission: {
      readonly runToken: string;
      admit(
        compiled: ProjectDocumentsCompile,
        versions: { key: string; version: number }[],
      ): Promise<PreviewUpdateOutcome>;
      admitPreparedRoom?(
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
    readonly openedAt?: number;
    readonly workingDocumentId?: string;
    readonly current?: () => boolean;
    readonly boundary?: () => Promise<void>;
    readonly write?: (request: ProjectCommitRequest) => Promise<ProjectCommitReceipt>;
    readonly publish?: (
      snapshot: ProjectSnapshot,
      data: ProjectCommitRequest["data"],
      outcome?: PreviewUpdateOutcome,
      nativeInstalled?: boolean,
    ) => void;
    readonly changed?: () => void;
    readonly forked?: (data: CachedGameData, lifetime: string) => void;
    readonly saved?: (
      data: ProjectCommitRequest["data"],
      lifetime: string,
      generation: number,
    ) => void;
  },
  storage: SessionStorage,
) {
  const data = structuredClone(input.data);
  const openedProjectId = data.projectId;
  const openedAt = input.openedAt ?? Date.now();
  data.chats = migrateAgentChats(data);
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
    ...(input.workingDocumentId === undefined ? {} : { documentId: input.workingDocumentId }),
  });
  const model = new ProjectModel({ documents, build, digest: sha256Hex });
  if (history.capture().cursor === null) {
    const genesis = data.chats.chats.find((chat) => chat.title === `Created ${data.title}`);
    const result = genesis?.messages.findLast((message) => message.role === "assistant");
    history.record(documents, {
      label: genesis ? `AI: ${genesis.title}` : "Opened",
      origin: "template",
      author: genesis ? "agent" : "creator",
      time: openedAt,
      ...(genesis && result ? { chatId: genesis.id, messageId: result.id } : {}),
    });
  }
  let pendingRestart: PendingProjectRestart | null = null;
  let pendingImage: ProjectDocumentsCompile | undefined;
  let pendingPreparedRoom = false;
  let retrying = false;
  let disposed = false;
  let writeBlock: "stale" | "removed" | undefined;
  let epoch = 0;
  let serial = 0;
  let forkId: CachedGameData["projectId"] | undefined;
  let tail = Promise.resolve();
  let documentTail = tail;
  let queued = 0;
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
    authoring: storage.fingerprint(data.authoringState, data.workspace),
    buildId: build.build.identity.buildId,
  };
  const current = () => !disposed && (input.current?.() ?? true);
  const versions = (snapshot: ProjectSnapshot) =>
    snapshot.keys.map((key) => ({ key, version: snapshot.version(key) }));
  function notify() {
    if (disposed) return;
    input.changed?.();
    for (const observer of observers) {
      try {
        observer();
      } catch {
        /* A presentation observer cannot cancel the owned save. */
      }
    }
  }
  let journalBase = structuredClone(input.data);
  let journalExpected = { ...expected };
  let journalImage = model.capture().lastAdmissibleBuild!.documentId;
  let operationBase = 0;
  let operationSerial = 0;
  let operations: { index: number; operation: ProjectJournalOperation }[] = [];
  function recordOperation(operation: ProjectJournalOperation) {
    operations.push({ index: ++operationSerial, operation });
  }
  const editorIntents: Record<
    string,
    { content: ProjectContent | null; id: number; primary: string }
  > = {};
  let intentSerial = 0;
  function sameContent(a: ProjectContent | null | undefined, b: ProjectContent | null): boolean {
    return (
      a === b ||
      (a instanceof Uint8Array &&
        b instanceof Uint8Array &&
        a.length === b.length &&
        a.every((value, index) => value === b[index]))
    );
  }
  let journalFrame: number | undefined;
  let journalKey = projectSaveJournalKey(data.projectId, input.admission.runToken);
  let releaseJournal = claimProjectSaveJournal(journalKey);
  function requestFor(capture: SessionSave): ProjectCommitRequest {
    if (capture.request !== undefined) return capture.request;
    const fork = data.library?.source === "catalog";
    if (fork) forkId ??= requireProjectId(`remix-${crypto.randomUUID()}`);
    const saving = {
      ...capture.data,
      projectId: forkId ?? data.projectId,
      ...(fork
        ? {
            title: `${data.title} Remix`,
            imported: true,
            roomGeneration: false,
            library: {
              ...capture.data.library!,
              source: "remix" as const,
              catalog: undefined,
              preview: undefined,
              parent: { project: data.projectId, revision: expected.revision },
            },
          }
        : { title: data.title, library: capture.data.library }),
    };
    capture.request ??= {
      projectId: saving.projectId,
      workspaceId: `session-${input.lifetime}`,
      commitId: `edit-${input.admission.runToken}-${++serial}`,
      expected: fork ? null : { ...expected },
      buildId: capture.snapshot.lastAdmissibleBuild!.identity.buildId,
      documents: versions(capture.snapshot),
      data: saving,
    };
    return capture.request;
  }
  function persistPending(): Error | undefined {
    if (journalFrame !== undefined) {
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(journalFrame);
      else clearTimeout(journalFrame);
      journalFrame = undefined;
    }
    if (input.write !== undefined) return;
    try {
      if (typeof localStorage === "undefined") throw new Error("Browser storage is unavailable.");
      const entries = autosave
        .captures()
        .filter((capture) => !capture.acknowledged)
        .map((capture) => {
          if (capture.journal === undefined || !capture.attempted)
            capture.journal = captureProjectJournal({
              request: requestFor(capture),
              base: journalBase,
              expected: journalExpected,
              openedAt,
              baseImage: journalImage,
              image: capture.snapshot.lastAdmissibleBuild!.documentId,
              operations: operations
                .filter(({ index }) => index > operationBase && index <= capture.operation)
                .map(({ operation }) => operation),
            });
          return { capture: capture.journal, attempted: capture.attempted === true };
        });
      const intents = Object.entries(editorIntents);
      if (intents.length > 0) {
        const snapshot = model.capture();
        const image = snapshot.lastAdmissibleBuild!;
        const changes = intents.map(([key, intent]) => ({
          key,
          content: intent.content,
          version: snapshot.version(key) + 1,
        }));
        const request = {
          ...requestFor({ snapshot, data, operation: operationSerial }),
          commitId: `editor-${input.admission.runToken}-${intentSerial}-${operationSerial}`,
        };
        const capture = captureProjectJournal({
          request,
          base: journalBase,
          expected: journalExpected,
          openedAt,
          baseImage: journalImage,
          image: image.documentId,
          operations: [
            ...operations
              .filter(({ index }) => index > operationBase)
              .map(({ operation }) => operation),
            {
              kind: "edit",
              changes,
              metadata: {
                label: "Recovered editor changes",
                origin: "logic",
                author: "creator",
                time: openedAt,
              },
            },
          ],
          editorIntent: true,
        });
        entries.push({ capture, attempted: false });
      }
      writeProjectSaveJournal(localStorage, journalKey, entries);
    } catch {
      // The previous recovery intent remains until its durable acknowledgement.
      return new Error(
        "Browser recovery storage could not keep this edit. Keep this tab open until Saved.",
      );
    }
    return undefined;
  }
  function scheduleJournal() {
    if (
      input.write !== undefined ||
      typeof localStorage === "undefined" ||
      journalFrame !== undefined
    )
      return;
    journalFrame =
      typeof requestAnimationFrame === "undefined"
        ? (setTimeout(persistPending, 0) as unknown as number)
        : requestAnimationFrame(persistPending);
  }
  function hiddenJournal() {
    if (document.visibilityState === "hidden") persistPending();
  }
  if (input.write === undefined && typeof addEventListener !== "undefined") {
    addEventListener("pagehide", persistPending);
    document.addEventListener("visibilitychange", hiddenJournal);
  }
  const autosave = createProjectAutosave<SessionSave, ProjectCommitReceipt>({
    current,
    write: async (capture) => {
      requestFor(capture);
      if (!capture.attempted) {
        capture.request = {
          ...capture.request!,
          expected: data.library?.source === "catalog" ? null : { ...expected },
          data: {
            ...capture.request!.data,
            library: projectCommitLibrary(
              data.library?.source === "catalog" ? capture.request!.data.library : data.library,
              {
                revision: capture.snapshot.lastAdmissibleBuild!.identity.revision,
                source: capture.request!.data.imported ? "zip" : "authored",
              },
            ),
          },
        };
        capture.attempted = true;
        delete capture.journal;
        persistPending();
      }
      return input.write === undefined
        ? (await storage.commit(capture.request!, capture.journal?.hash)).receipt
        : input.write(capture.request!);
    },
    saved: (receipt, capture) => {
      let previousKey: string | undefined;
      let releasePrevious: (() => void) | undefined;
      if (receipt.saved.projectId !== data.projectId) {
        owners.delete(data.projectId);
        Object.assign(data, capture.request!.data, {
          projectId: receipt.saved.projectId,
          generation: receipt.saved.generation,
        });
        owners.set(data.projectId, session);
        previousKey = journalKey;
        releasePrevious = releaseJournal;
        journalKey = projectSaveJournalKey(data.projectId, input.admission.runToken);
        releaseJournal = claimProjectSaveJournal(journalKey);
        input.forked?.(structuredClone(data), receipt.saved.lifetime);
      }
      data.library = capture.request!.data.library;
      expected = { ...receipt.saved };
      journalExpected = { ...receipt.saved };
      journalImage = capture.snapshot.lastAdmissibleBuild!.documentId;
      journalBase = {
        ...capture.request!.data,
        projectId: receipt.saved.projectId,
        authoredAt: "",
        generation: receipt.saved.generation,
      };
      operationBase = capture.operation;
      operations = operations.filter(({ index }) => index > operationBase);
      capture.acknowledged = true;
      const recoveryError = persistPending();
      releasePrevious?.();
      if (
        previousKey !== undefined &&
        recoveryError === undefined &&
        input.write === undefined &&
        typeof localStorage !== "undefined"
      )
        localStorage.removeItem(previousKey);
      input.saved?.(capture.request!.data, receipt.saved.lifetime, receipt.saved.generation);
    },
    conflict(error) {
      if (
        !(error instanceof Error) ||
        !["ConcurrencyConflictError", "ProjectDeletedError", "StaleAuthoringError"].includes(
          error.name,
        )
      )
        return false;
      writeBlock = error.name === "ProjectDeletedError" ? "removed" : "stale";
      return true;
    },
    changed() {
      scheduleJournal();
      notify();
    },
  });
  function captureSave(
    snapshot: ProjectSnapshot,
    outcome?: PreviewUpdateOutcome,
    nativeInstalled = false,
    save = true,
  ) {
    const image = snapshot.lastAdmissibleBuild!;
    const next = {
      ...data,
      files: Object.fromEntries(image.files()),
      library: projectCommitLibrary(data.library, {
        revision: image.identity.revision,
        source: data.imported ? "zip" : "authored",
      }),
      workspace: writeProjectWorkspace(snapshot.documents()),
      projectHistory: writeProjectHistory(history.capture(), sha256Hex),
      ...(typeof image.documents()["world"] === "string"
        ? {
            authoringState: {
              ...data.authoringState,
              authoring: {
                ...(data.authoringState?.["authoring"] as Record<string, unknown> | undefined),
                version: 1,
                bindings: JSON.parse((image.documents()["bindings"] as string | undefined) ?? "{}"),
                world: JSON.parse(image.documents()["world"] as string),
              },
            },
          }
        : {}),
    };
    const tests = image.documents()["tests"];
    delete next.files["TESTS.JSON"];
    if (tests !== undefined)
      next.files["TESTS.JSON"] =
        typeof tests === "string" ? new TextEncoder().encode(tests) : tests.slice();
    if (next.files["WORDS.TOK"] !== undefined)
      next.words = parseWordsTok(next.files["WORDS.TOK"]).map(({ word, id }) => [word, id]);
    input.publish?.(snapshot, next, outcome, nativeInstalled);
    if (!save) return;
    autosave.enqueue({
      snapshot,
      data: next,
      operation: operationSerial,
    });
  }
  async function apply(
    proposal: ProjectProposal,
    metadata: ProjectCommitMetadata,
    action?: ProjectHistoryAction,
    preparedRoom = false,
    beforeCommit?: () => void,
    editorIntent?: number,
  ) {
    beforeCommit?.();
    if (!current() || autosave.status().state === "conflict")
      throw new Error("Project session is closed for writes.");
    const fence = {
      projectId: data.projectId,
      lifetime: input.lifetime,
      sessionEpoch: epoch,
      workerRunToken: input.admission.runToken,
      generation: expected.generation,
    };
    // A gesture can derive companion metadata again at admission. Transfer its
    // intent into the admitted capture by group, while preserving later gestures.
    const written = proposal.changes();
    const nextDocuments = proposal.documents();
    const intentGroups = new Set(
      Object.values(editorIntents)
        .filter((intent) => {
          if (action !== undefined) return true;
          if (editorIntent !== undefined) return intent.id === editorIntent;
          const primary = editorIntents[intent.primary];
          return (
            primary?.id === intent.id &&
            sameContent(nextDocuments[intent.primary] ?? null, primary.content) &&
            (written.some((change) => change.key === intent.primary) ||
              Object.entries(editorIntents)
                .filter(([, companion]) => companion.id === intent.id)
                .every(([key, companion]) =>
                  sameContent(nextDocuments[key] ?? null, companion.content),
                ))
          );
        })
        .map((intent) => intent.id),
    );
    const capturedIntents = Object.fromEntries(
      Object.entries(editorIntents)
        .filter(([, intent]) => intentGroups.has(intent.id))
        .map(([key, intent]) => [key, intent.id]),
    );
    const { prepared, outcome, changes } = await prepareAndAdmitProjectEdit({
      model,
      proposal,
      profileId: inspection.profileId,
      allowMissingRooms: data.roomGeneration === true,
      current: () =>
        current() &&
        writeBlock === undefined &&
        epoch === fence.sessionEpoch &&
        input.lifetime === fence.lifetime &&
        input.admission.runToken === fence.workerRunToken &&
        // The first save may finish this session's catalog fork while an
        // admitted edit waits. Its new body has its own generation counter.
        ((data.projectId === fence.projectId && expected.generation >= fence.generation) ||
          (fence.projectId === openedProjectId && data.projectId === forkId)),
      preflight() {
        beforeCommit?.();
        if (action === undefined)
          new ProjectHistory(sha256Hex, history.capture()).record(proposal.documents(), metadata);
      },
      admit: (compiled, documents) => {
        beforeCommit?.();
        return preparedRoom && input.admission.admitPreparedRoom
          ? input.admission.admitPreparedRoom(compiled, documents)
          : input.admission.admit(compiled, documents);
      },
    });
    beforeCommit?.();
    if (
      outcome !== undefined &&
      outcome.status !== "committed" &&
      outcome.status !== "unchanged" &&
      outcome.status !== "restartRequired" &&
      outcome.status !== "deferred"
    )
      return { ...outcome, diagnostics: prepared.diagnostics };
    if (outcome?.status === "restartRequired")
      pendingRestart = {
        action: outcome.roomReentry === true ? "reenter" : "restart",
        reason: restartReason(outcome.reason ?? "This image needs a game restart."),
      };
    else if (prepared.compiled !== undefined) pendingRestart = null;
    if (prepared.compiled !== undefined) {
      pendingImage = outcome?.status === "deferred" ? prepared.compiled : undefined;
      pendingPreparedRoom = pendingImage !== undefined && preparedRoom;
    }
    diagnostics = prepared.diagnostics;
    const snapshot = model.apply(prepared.application);
    if (action !== undefined) history.accept(action);
    else history.record(snapshot.documents(), metadata);
    recordOperation({
      kind: "edit",
      changes: changes.map((change) => ({ ...change, version: snapshot.version(change.key) })),
      metadata,
      ...(action === undefined
        ? {}
        : { action: { direction: action.direction, target: action.target } }),
    });
    captureSave(snapshot, outcome, preparedRoom);
    for (const [key, id] of Object.entries(capturedIntents))
      if (editorIntents[key]?.id === id) delete editorIntents[key];
    if (pendingImage !== undefined) void retryAdmission();
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
  function schedule<T>(operation: () => Promise<T>, savesDocuments = true): Promise<T> {
    if (savesDocuments) queued++;
    notify();
    const result = tail.then(operation).finally(() => {
      if (savesDocuments) queued--;
      notify();
    });
    tail = result.then(
      () => {},
      () => {},
    );
    if (savesDocuments) documentTail = tail;
    return result;
  }
  async function retryAdmission(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      while (current() && writeBlock === undefined && pendingImage !== undefined) {
        await (input.boundary?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 50)));
        await schedule(async () => {
          const image = pendingImage;
          if (!current() || writeBlock !== undefined || image === undefined) return;
          const before = model.capture();
          const outcome = await (pendingPreparedRoom && input.admission.admitPreparedRoom
            ? input.admission.admitPreparedRoom(image, versions(before))
            : input.admission.admit(image, versions(before)));
          if (!current() || writeBlock !== undefined || pendingImage !== image) return;
          if (outcome.status === "deferred") return;
          pendingImage = undefined;
          if (outcome.status === "restartRequired")
            pendingRestart = {
              action: outcome.roomReentry === true ? "reenter" : "restart",
              reason: restartReason(outcome.reason ?? "This image needs a game restart."),
            };
          if (outcome.status === "committed" || outcome.status === "unchanged")
            captureSave(before, outcome, false, false);
          notify();
        }, false);
      }
    } catch (cause) {
      if (current() && writeBlock === undefined) {
        pendingImage = undefined;
        pendingRestart = {
          action: "restart",
          reason: cause instanceof Error ? cause.message : String(cause),
        };
        notify();
      }
    } finally {
      retrying = false;
    }
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
      if (!current() || writeBlock !== undefined)
        throw new Error("Project session was closed for writes.");
      outcome = await admit(prepared.compiled, versions(before));
      if (!current() || writeBlock !== undefined) throw new Error("Project action was superseded.");
      if (outcome.status === "deferred")
        await (input.boundary?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 50)));
    } while (outcome.status === "deferred");
    if (!current() || writeBlock !== undefined || before.documentId !== model.capture().documentId)
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
    rememberEditorChanges(changes: readonly ProjectChange[]) {
      if (disposed) throw new Error("Project session is closed for writes.");
      const primary = changes[0]?.key;
      if (primary === undefined) return;
      const previous = editorIntents[primary];
      if (previous?.primary === primary)
        for (const [key, intent] of Object.entries(editorIntents))
          if (intent.id === previous.id) delete editorIntents[key];
      const id = ++intentSerial;
      for (const change of changes) {
        editorIntents[change.key] = {
          content: change.content instanceof Uint8Array ? change.content.slice() : change.content,
          id,
          primary,
        };
      }
      return persistPending();
    },
    get hasEditorIntents() {
      return Object.keys(editorIntents).length > 0;
    },
    captureEditorIntent(key: string): number | undefined {
      return editorIntents[key]?.id;
    },
    get closed() {
      return !current();
    },
    get allowMissingRooms() {
      return data.roomGeneration === true;
    },
    chats() {
      return readAgentChats(data.chats);
    },
    saveChats(chats: AgentChats) {
      return schedule(async () => {
        if (!current() || writeBlock !== undefined)
          throw new Error("Project session was closed for writes.");
        data.chats = readAgentChats(chats);
        recordOperation({ kind: "chats", chats: data.chats });
        captureSave(model.capture());
      });
    },
    get lifetime() {
      return expected.lifetime;
    },
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
    submit(
      edit: { proposal: ProjectProposal; beforeCommit?: () => void; editorIntent?: number } & Omit<
        ProjectCommitMetadata,
        "time"
      >,
    ) {
      return schedule(() =>
        apply(
          edit.proposal,
          {
            label: edit.label,
            origin: edit.origin,
            author: edit.author,
            time: Date.now(),
            ...(edit.chatId === undefined
              ? {}
              : { chatId: edit.chatId, messageId: edit.messageId! }),
          },
          undefined,
          false,
          edit.beforeCommit,
          edit.editorIntent,
        ),
      );
    },
    submitPreparedRoom(edit: { proposal: ProjectProposal } & Omit<ProjectCommitMetadata, "time">) {
      const { proposal, ...metadata } = edit;
      return schedule(() => apply(proposal, { ...metadata, time: Date.now() }, undefined, true));
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
        if (!current() || writeBlock !== undefined)
          throw new Error("Project session was closed for writes.");
        const cursor = history.capture().cursor;
        if (cursor !== null) {
          history.tag(name, cursor);
          recordOperation({ kind: "tag", name });
          captureSave(model.capture());
        }
      });
    },
    renameTag(name: string, next: string | null) {
      return schedule(async () => {
        if (!current() || writeBlock !== undefined)
          throw new Error("Project session was closed for writes.");
        history.renameTag(name, next);
        recordOperation({ kind: "renameTag", name, next });
        captureSave(model.capture());
      });
    },
    async flush() {
      if (!current() || writeBlock !== undefined)
        throw new Error(session.saveStatus().message || "Project session was closed.");
      let scheduled: Promise<unknown>;
      do {
        scheduled = documentTail;
        await scheduled;
        await autosave.flush();
        const status = autosave.status();
        if (status.state !== "saved")
          throw new Error(status.message || "Project save is pending. Retry the save.");
      } while (scheduled !== documentTail);
    },
    async prepareCheckpoint() {
      let scheduled: Promise<unknown>;
      do {
        scheduled = tail;
        await scheduled;
        await session.flush();
      } while (scheduled !== tail);
    },
    retry() {
      return session.flush();
    },
    capture() {
      return {
        snapshot: model.capture(),
        history: history.capture(),
        diagnostics,
        pendingRestart,
        pendingAdmission: pendingImage !== undefined,
        save: session.saveStatus(),
      };
    },
    subscribe(observer: () => void) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    saveStatus() {
      const status = autosave.status();
      if (writeBlock !== undefined)
        return {
          ...status,
          state: "conflict" as const,
          message:
            writeBlock === "removed"
              ? "Project removed. Download game to keep this version."
              : "Changed in another tab. Reload game.",
        };
      return queued > 0 && status.state === "saved"
        ? { ...status, state: "pending" as const }
        : status;
    },
    stopWrites(reason: "stale" | "removed" = "stale") {
      writeBlock = reason;
      autosave.stop();
    },
    async replay(operation: ProjectJournalOperation) {
      if (operation.kind === "capture") {
        captureSave(model.capture());
        return;
      }
      if (operation.kind === "chats") return session.saveChats(operation.chats);
      if (operation.kind === "tag") return session.tag(operation.name);
      if (operation.kind === "renameTag") return session.renameTag(operation.name, operation.next);
      const action =
        operation.action?.direction === "undo"
          ? history.undo(model)
          : operation.action?.direction === "redo"
            ? history.redo(model)
            : operation.action === undefined
              ? undefined
              : history.restore(model, operation.action.target, operation.metadata);
      if (operation.action !== undefined && action?.target !== operation.action.target)
        throw new Error("Project journal History differs from its base.");
      return apply(
        action?.proposal ??
          model.propose(model.capture(), operation.metadata.label, operation.changes),
        operation.metadata,
        action,
      );
    },
    discard() {
      for (const key of Object.keys(editorIntents)) delete editorIntents[key];
      autosave.dispose();
      session.dispose();
    },
    dispose() {
      persistPending();
      if (input.write === undefined && typeof removeEventListener !== "undefined") {
        removeEventListener("pagehide", persistPending);
        document.removeEventListener("visibilitychange", hiddenJournal);
      }
      disposed = true;
      epoch++;
      autosave.dispose();
      releaseJournal();
      for (const observer of observers) {
        try {
          observer();
        } catch {
          /* Closing retires every observer. */
        }
      }
      observers.clear();
      if (owners.get(data.projectId) === session) owners.delete(data.projectId);
    },
  };
  return session;
}
export type ProjectSession = ReturnType<typeof openOwnedProjectSession>;

/** Re-run the same preparation and History path before exposing any recovered project. */
export async function rebuildProjectJournal(
  data: CachedGameData,
  capture: ProjectJournalCapture,
  storage: SessionStorage,
): Promise<ProjectCommitRequest> {
  let rebuilt: ProjectCommitRequest["data"] | undefined;
  const session = createSession(
    {
      data,
      lifetime: capture.base.lifetime,
      openedAt: capture.openedAt,
      workingDocumentId: capture.baseImage,
      admission: {
        runToken: "journal-recovery",
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 0,
        }),
      },
      write: async () => {
        throw new Error("Recovery prepares before writing.");
      },
      publish: (_snapshot, next) => {
        rebuilt = next;
      },
    },
    storage,
  );
  try {
    for (const operation of capture.operations) await session.replay(operation);
    if (rebuilt === undefined) await session.replay({ kind: "capture" });
    if (
      capture.editorIntent !== true &&
      (session.model.capture().lastAdmissibleBuild?.identity.buildId !== capture.identity.buildId ||
        session.model.capture().lastAdmissibleBuild?.documentId !== capture.image)
    )
      throw new Error("Project journal could not rebuild its exact accepted image.");
    if (rebuilt === undefined) throw new Error("Project journal has no accepted capture.");
    const snapshot = session.model.capture();
    return journalCandidate(
      capture,
      rebuilt,
      capture.editorIntent
        ? {
            buildId: snapshot.lastAdmissibleBuild!.identity.buildId,
            documents: snapshot.keys.map((key) => ({ key, version: snapshot.version(key) })),
          }
        : undefined,
    );
  } finally {
    session.dispose();
  }
}
