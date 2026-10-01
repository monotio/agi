<script setup lang="ts">
/**
 * Logic Studio: an independent stored-project workspace. It opens the
 * editable-project service directly — no engine, worker boot, provider,
 * model or agent session — so the library's Edit works with no AI key and
 * never changes which game is running. Editing is real Monaco over the
 * ProjectDraft; code intelligence comes from the local analysis worker;
 * Keep writes a reviewed build candidate to durable storage only.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";
import type { ProjectId } from "../../project/gameTypes.ts";
import {
  openEditableProject,
  type EditableCandidate,
  type EditableProject,
} from "../../project/editableProject.ts";
import { discardProjectDraft } from "../../project/projectDrafts.ts";
import { writeProjectRecovery } from "../../../../src/authoring/projectRecovery.ts";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiDialog from "../../ui/UiDialog.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import LogicByteView from "./LogicByteView.vue";
import LogicExplorer from "./LogicExplorer.vue";
import LogicRecoveryDialog from "./LogicRecoveryDialog.vue";
import LogicReviewDialog, { type LogicReviewEntry } from "./LogicReviewDialog.vue";
import { LogicAnalysisClient } from "./analysisClient.ts";
import { LogicDraftPersister, recoveryEntries, type LogicRecoveryEntry } from "./logicRecovery.ts";
import {
  analysisBindings,
  analysisWords,
  derivedLogicSource,
  documentLabel,
  logicDocumentUri,
  workspaceDocuments,
  type LogicWorkspaceDocument,
} from "./logicWorkspace.ts";
import {
  LOGIC_LANGUAGE_ID,
  monaco,
  registerLogicModel,
  type LogicModelHandle,
} from "./monacoLanguage.ts";

const { projectId } = defineProps<{ readonly projectId: ProjectId }>();
const emit = defineEmits<{ close: []; "update:projectId": [id: ProjectId] }>();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The workspace service and the reactive counter its draft bumps on each change. */
const workspace = shallowRef<EditableProject>();
const revision = ref(0);
const opening = ref(true);
const openError = ref("");
const contextError = ref<string | undefined>();
const persistError = ref<string | undefined>();
const savedNote = ref<string | undefined>();
let savedNoteTimer: ReturnType<typeof setTimeout> | undefined;

let client: LogicAnalysisClient | undefined;
let persister: LogicDraftPersister | undefined;
/** Kept-baseline mirror for review diffs; refreshed after each successful Keep. */
let keptDocuments: Record<string, string | Uint8Array> = {};

/** One live editor model per opened text document; closed tabs keep theirs. */
interface ModelEntry {
  readonly model: monaco.editor.ITextModel;
  readonly handle: LogicModelHandle | undefined;
}
const models = new Map<string, ModelEntry>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const openTabs = ref<string[]>([]);
const activeKey = shallowRef<string | null>(null);
const editorHost = useTemplateRef("editorHost");
let editor: monaco.editor.IStandaloneCodeEditor | undefined;

const snapshot = computed(() => {
  const tick = revision.value;
  return tick < 0 ? undefined : workspace.value?.draft.capture();
});
const documents = computed<readonly LogicWorkspaceDocument[]>(() => {
  const ws = workspace.value;
  const snap = snapshot.value;
  if (!ws || !snap) return [];
  const contents = Object.fromEntries(snap.keys.map((key) => [key, snap.read(key)!.content]));
  return workspaceDocuments(contents, ws.draft.dirtyKeys());
});
const dirtyKeys = computed<readonly string[]>(() =>
  revision.value < 0 ? [] : (workspace.value?.draft.dirtyKeys() ?? []),
);
const changes = computed(() => dirtyKeys.value.length);
const rejectedKeys = computed(() => Object.keys(workspace.value?.inspection.rejectedSources ?? {}));
const sourceDiagnostics = computed(() => workspace.value?.inspection.diagnostics ?? []);
const title = computed(() => workspace.value?.storedData().title ?? "Project");
const activeDocument = computed(() => documents.value.find((doc) => doc.key === activeKey.value));
const activeText = computed(() => activeDocument.value?.kind === "text");
const derivedPreview = computed(() => {
  const doc = activeDocument.value;
  const ws = workspace.value;
  if (!doc || !ws || !(doc.content instanceof Uint8Array)) return undefined;
  if (!doc.key.startsWith("logic:")) return undefined;
  const snap = snapshot.value;
  try {
    const words = snap ? analysisWords(snap.read("words")?.content) : [];
    return derivedLogicSource(doc.content, ws.profileId, words).source;
  } catch {
    return derivedLogicSource(doc.content, ws.profileId, []).source;
  }
});

const statusText = computed(() => {
  if (opening.value) return "Opening…";
  if (openError.value) return "Could not open";
  if (keeping.value) return "Keeping…";
  return changes.value === 0
    ? "No changes"
    : `${changes.value} ${changes.value === 1 ? "change" : "changes"}`;
});

/* --- Analysis ---------------------------------------------------------- */

function syncAnalysis(): void {
  const ws = workspace.value;
  const snap = ws?.draft.capture();
  if (!ws || !snap || !client) return;
  let words: readonly (readonly [string, number])[];
  let bindings: Readonly<Record<string, { readonly num: number }>>;
  try {
    words = analysisWords(snap.read("words")?.content);
    bindings = analysisBindings(snap.read("bindings")?.content);
  } catch (error) {
    contextError.value = reason(error);
    problems.value = [];
    clearMarkers();
    client.invalidateContext(contextError.value);
    return;
  }
  contextError.value = undefined;
  const docs: Record<string, { version: number; source: string }> = Object.create(null);
  for (const key of snap.keys) {
    if (!key.startsWith("logic:")) continue;
    const doc = snap.read(key)!;
    if (typeof doc.content === "string") docs[key] = { version: doc.version, source: doc.content };
  }
  client.setProject({
    revision: snap.revision,
    profileId: ws.profileId,
    words,
    bindings,
    documents: docs,
  });
}

/* --- Problems ---------------------------------------------------------- */

interface Problem {
  readonly key: string;
  readonly message: string;
  readonly severity: string;
  readonly line: number;
  readonly column: number;
}
const problems = shallowRef<readonly Problem[]>([]);
let problemsTimer: ReturnType<typeof setTimeout> | undefined;

function uriPrefix(): string {
  const ws = workspace.value;
  return ws ? `agi-logic://${ws.projectId}/${ws.workspaceId}/` : "";
}

function clearMarkers(): void {
  for (const entry of models.values()) {
    if (!entry.model.isDisposed()) monaco.editor.setModelMarkers(entry.model, "agi-logic", []);
  }
}

/** Refresh markers on every open model, then rebuild the Problems list. */
async function refreshProblems(): Promise<void> {
  for (const entry of models.values()) {
    await entry.handle?.refreshDiagnostics();
  }
  const prefix = uriPrefix();
  const found: Problem[] = [];
  for (const marker of monaco.editor.getModelMarkers({})) {
    const uri = marker.resource.toString();
    if (!uri.startsWith(prefix) || marker.owner !== "agi-logic") continue;
    const key = decodeURIComponent(uri.slice(prefix.length));
    found.push({
      key,
      message: marker.message,
      severity: marker.severity === monaco.MarkerSeverity.Error ? "error" : "warning",
      line: marker.startLineNumber,
      column: marker.startColumn,
    });
  }
  found.sort((a, b) => a.key.localeCompare(b.key) || a.line - b.line || a.column - b.column);
  problems.value = found;
}

function scheduleProblems(): void {
  if (problemsTimer !== undefined) clearTimeout(problemsTimer);
  problemsTimer = setTimeout(() => {
    problemsTimer = undefined;
    void refreshProblems();
  }, 250);
}

function goToProblem(problem: Problem): void {
  openDocument(problem.key);
  void nextTick(() => {
    editor?.setPosition({ lineNumber: problem.line, column: problem.column });
    editor?.revealPositionInCenter({ lineNumber: problem.line, column: problem.column });
    editor?.focus();
  });
}

/* --- Documents and models ---------------------------------------------- */

function ensureModel(key: string): monaco.editor.ITextModel | undefined {
  const held = models.get(key);
  if (held) return held.model;
  const ws = workspace.value;
  const doc = ws?.draft.capture().read(key);
  if (!ws || !doc || typeof doc.content !== "string") return undefined;
  const model = monaco.editor.createModel(
    doc.content,
    key.startsWith("logic:") ? LOGIC_LANGUAGE_ID : "plaintext",
    monaco.Uri.parse(logicDocumentUri(ws.projectId, ws.workspaceId, key)),
  );
  model.onDidChangeContent(() => {
    const service = workspace.value;
    if (!service) return;
    // The author's own typing is a single-document edit; the draft keeps
    // authority and versions it. A stale version means the model drifted —
    // resync it to the draft rather than pretend the write landed.
    try {
      const snap = service.draft.capture();
      service.draft.edit(key, model.getValue(), snap.version(key));
    } catch {
      const current = service.draft.capture().read(key);
      if (current && typeof current.content === "string" && current.content !== model.getValue())
        model.setValue(current.content);
      return;
    }
    revision.value++;
    savedNote.value = undefined;
    persister?.schedule();
    syncAnalysis();
    scheduleProblems();
  });
  const handle = client ? registerLogicModel(model, { client, documentKey: key }) : undefined;
  const entry = { model, handle };
  models.set(key, entry);
  return model;
}

function openDocument(key: string): void {
  if (!openTabs.value.includes(key)) openTabs.value = [...openTabs.value, key];
  activateDocument(key);
}

function activateDocument(key: string): void {
  if (activeKey.value !== null && activeKey.value !== key && editor)
    viewStates.set(activeKey.value, editor.saveViewState());
  activeKey.value = key;
  const doc = documents.value.find((entry) => entry.key === key);
  const model = doc?.kind === "text" ? ensureModel(key) : undefined;
  // A byte-only document has no text model: detach the previous document's
  // model so editor commands cannot reach a document the author cannot see.
  editor?.setModel(model ?? null);
  if (model) {
    const view = viewStates.get(key);
    if (view) editor?.restoreViewState(view);
  }
  scheduleProblems();
}

/** Editor commands may run only while the visible document's own text model is attached. */
const editorCommandsEnabled = computed(() => {
  const doc = activeDocument.value;
  if (doc?.kind !== "text" || workspace.value === undefined) return false;
  const held = models.get(doc.key);
  return editor !== undefined && held !== undefined && editor.getModel() === held.model;
});

/**
 * Undo/Redo act on the visible document only. Even past a disabled button the
 * handler re-verifies the active document is text and its own model — not a
 * hidden previous one — is the model attached to the editor.
 */
function runEditorCommand(command: "undo" | "redo"): void {
  if (!editorCommandsEnabled.value) return;
  editor?.trigger("toolbar", command, null);
}

/** Closing a tab only hides it — the model, its undo and its cursor stay. */
function closeDocumentTab(key: string): void {
  const index = openTabs.value.indexOf(key);
  if (index < 0) return;
  openTabs.value = openTabs.value.filter((open) => open !== key);
  if (activeKey.value !== key) return;
  viewStates.set(key, editor?.saveViewState() ?? null);
  const next = openTabs.value[Math.min(index, openTabs.value.length - 1)] ?? null;
  if (next === null) {
    activeKey.value = null;
    editor?.setModel(null);
  } else {
    activeKey.value = null;
    activateDocument(next);
  }
}

/* --- Build review and Keep ---------------------------------------------- */

const review = shallowRef<{
  candidate: EditableCandidate | undefined;
  entries: readonly LogicReviewEntry[];
  /** The dirty roots the candidate was built from; the review can narrow it. */
  selected: readonly string[];
}>();
const reviewError = ref<string | undefined>();
const keeping = ref(false);
let closeAfterKeep = false;

/**
 * Build a candidate over the chosen dirty roots (plus their dependency
 * closure) and open the review. A failed build still opens the review with
 * the error and the selection visible, so an unrelated broken document can
 * be excluded instead of blocking every Keep.
 */
function requestKeep(fromClose = false, roots: readonly string[] | undefined = undefined): void {
  const ws = workspace.value;
  if (!ws || keeping.value) return;
  reviewError.value = undefined;
  closeAfterKeep = fromClose;
  const dirty = ws.draft.dirtyKeys();
  const selected = (roots ?? dirty).filter((key) => dirty.includes(key));
  if (selected.length === 0) {
    review.value = { candidate: undefined, entries: [], selected };
    return;
  }
  try {
    const candidate = ws.buildSelected(selected);
    const after = candidate.documents();
    review.value = {
      candidate,
      entries: candidate.keys.map((key) => ({
        key,
        before: keptDocuments[key],
        after: after[key],
      })),
      selected,
    };
  } catch (error) {
    review.value = { candidate: undefined, entries: [], selected };
    reviewError.value = reason(error);
  }
}

/** Rebuild the candidate with one dirty root added or removed. */
function toggleKeepRoot(key: string): void {
  const held = review.value;
  if (!held || keeping.value) return;
  const roots = held.selected.includes(key)
    ? held.selected.filter((root) => root !== key)
    : [...held.selected, key];
  requestKeep(closeAfterKeep, roots);
}

/** After a successful Keep: hand control back — close, or finish a guarded switch. */
async function afterKept(): Promise<void> {
  const target = switchTarget;
  switchTarget = null;
  if (target !== null) await openProject(target);
  else emit("close");
}

async function confirmKeep(): Promise<void> {
  const ws = workspace.value;
  const held = review.value;
  if (!ws || !held || held.candidate === undefined) return;
  const candidate = held.candidate;
  // The Keep belongs to this workspace and this persister; a switch or
  // unmount resolving while it is in flight owns the state that follows.
  const writer = persister;
  keeping.value = true;
  reviewError.value = undefined;
  try {
    await ws.keepCandidate(candidate);
    if (workspace.value !== ws) return;
    keptDocuments = { ...candidate.documents() };
    review.value = undefined;
    revision.value++;
    persistError.value = undefined;
    savedNote.value = "Saved to the library";
    if (savedNoteTimer) clearTimeout(savedNoteTimer);
    savedNoteTimer = setTimeout(() => (savedNote.value = undefined), 4000);
    // Newer typing stays dirty: durably persist it against the new kept base
    // before honoring a close, rather than letting teardown cancel a pending
    // debounce. A fully kept workspace's recovery record is discarded.
    if (closeAfterKeep) {
      const done =
        ws.draft.dirtyKeys().length > 0
          ? ((await writer?.flush()) ?? true)
          : ((await writer?.discard()) ?? true);
      if (!done) {
        // persistError is already visible; the guard re-runs on the next close.
        if (workspace.value === ws) closeAfterKeep = false;
        return;
      }
      if (workspace.value !== ws) return;
      closeAfterKeep = false;
      await afterKept();
    } else if (ws.draft.dirtyKeys().length > 0) {
      persister?.schedule();
    } else {
      await persister?.discard();
    }
  } catch (error) {
    // A failed Keep keeps the draft and this review exactly as they were.
    reviewError.value = reason(error);
    closeAfterKeep = false;
  } finally {
    keeping.value = false;
  }
}

/* --- Close guard -------------------------------------------------------- */

const leaveAsk = ref(false);
/** A project switch waiting behind the dirty guard, or null for a plain close. */
let switchTarget: ProjectId | null = null;

function keepAndClose(): void {
  leaveAsk.value = false;
  requestKeep(true);
}

/** Set while a clean close's storage settle is in flight, so a repeat Close is a no-op. */
let closeSettling = false;

async function requestClose(): Promise<void> {
  if (keeping.value || closeSettling) return;
  if (changes.value > 0) {
    leaveAsk.value = true;
    return;
  }
  const ws = workspace.value;
  if (ws === undefined) {
    emit("close");
    return;
  }
  // A clean close can still owe the record a dirty-then-undone draft left.
  // Settle it only while the draft stays clean, then re-review this same
  // mounted draft before leaving: typing during the delete revokes the
  // close, so the new work falls back to the ordinary dirty guard.
  closeSettling = true;
  try {
    const done = (await persister?.discard({ onlyIfClean: true })) ?? true;
    if (!done) return;
    if (workspace.value !== ws) return;
    if (ws.draft.dirtyKeys().length > 0) {
      leaveAsk.value = true;
      return;
    }
    emit("close");
  } finally {
    closeSettling = false;
  }
}

/**
 * Drop a pending project switch: the parent is asked to point the request
 * back at the project still mounted, so the prop and the open project agree.
 */
function cancelSwitch(): void {
  if (switchTarget === null) return;
  switchTarget = null;
  const open = workspace.value?.projectId;
  if (open !== undefined) emit("update:projectId", open);
}

/** Cancel the leave guard; a pending project switch is cancelled with it. */
function cancelLeave(): void {
  leaveAsk.value = false;
  cancelSwitch();
}

async function discardAndClose(): Promise<void> {
  // A failed discard stays visible (persistError) and keeps the dialog open
  // so the same reviewed record can be explicitly retried — never closed over.
  const done = (await persister?.discard()) ?? true;
  if (!done) return;
  leaveAsk.value = false;
  const target = switchTarget;
  switchTarget = null;
  if (target !== null) await openProject(target);
  else emit("close");
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}
watch(
  changes,
  (unkept) => {
    if (unkept > 0) window.addEventListener("beforeunload", onBeforeUnload);
    else window.removeEventListener("beforeunload", onBeforeUnload);
  },
  { immediate: true },
);

/* --- Recovery ----------------------------------------------------------- */

const recovery = shallowRef<readonly LogicRecoveryEntry[]>([]);
const recoveryOpen = ref(false);
const recoveryBusy = ref(false);
const recoveryError = ref<string | undefined>();

async function restoreEntry(entry: LogicRecoveryEntry): Promise<void> {
  const open = workspace.value?.projectId;
  if (open === undefined) return;
  const epoch = openEpoch;
  recoveryBusy.value = true;
  recoveryError.value = undefined;
  try {
    const restore =
      entry.kind === "stored"
        ? { restore: { workspaceId: entry.workspaceId, receipt: entry.receipt } }
        : { restore: { portable: entry.recovery } };
    // The service verifies the reviewed receipt and the current saved base
    // itself, then installs a fresh draft — UI never assigns one. A close or
    // a project open resolved while the restore was in flight supersedes it.
    const ws = await openEditableProject(open, restore);
    if (epoch !== openEpoch) return;
    mountWorkspace(ws);
    recoveryOpen.value = false;
  } catch (error) {
    // A close or project open resolved meanwhile owns the current state.
    if (epoch === openEpoch) {
      recoveryError.value = reason(error);
      await refreshRecovery();
    }
  } finally {
    if (epoch === openEpoch) recoveryBusy.value = false;
  }
}

async function discardEntry(entry: LogicRecoveryEntry): Promise<void> {
  const open = workspace.value?.projectId;
  if (entry.kind !== "stored" || open === undefined) return;
  const epoch = openEpoch;
  recoveryBusy.value = true;
  recoveryError.value = undefined;
  try {
    await discardProjectDraft(open, entry.workspaceId, entry.receipt);
    await refreshRecovery();
  } catch (error) {
    if (epoch === openEpoch) recoveryError.value = reason(error);
  } finally {
    if (epoch === openEpoch) recoveryBusy.value = false;
  }
}

function downloadEntry(entry: LogicRecoveryEntry): void {
  if (entry.recovery === undefined) return;
  const blob = new Blob([JSON.stringify(entry.recovery, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.value.replace(/[^A-Za-z0-9_-]+/g, "-")}-draft.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function refreshRecovery(): Promise<void> {
  const ws = workspace.value;
  if (!ws) return;
  const entries = await recoveryEntries(ws.storedData());
  // A newer mount owns the recovery list while this read was in flight.
  if (workspace.value !== ws) return;
  recovery.value = entries;
  if (entries.length === 0) recoveryOpen.value = false;
}

/* --- Lifecycle ----------------------------------------------------------- */

function teardownModels(): void {
  for (const entry of models.values()) {
    entry.handle?.dispose();
    entry.model.dispose();
  }
  models.clear();
  viewStates.clear();
  openTabs.value = [];
  activeKey.value = null;
}

function mountWorkspace(ws: EditableProject): void {
  teardownModels();
  persister?.dispose();
  client?.dispose();
  workspace.value = ws;
  keptDocuments = { ...ws.inspection.documents };
  client = new LogicAnalysisClient();
  const recoveryId = ws.restoredRecovery?.workspaceId ?? ws.workspaceId;
  persister = new LogicDraftPersister({
    projectId: ws.projectId,
    workspaceId: recoveryId,
    capture: () => {
      if (workspace.value !== ws) return null;
      // A mounted draft that undid its way back to the saved base retires its
      // own record; a superseded workspace (null) never touches storage.
      if (ws.draft.dirtyKeys().length === 0) return { clean: true };
      const saved = ws.savedIdentity();
      return {
        expected: { generation: saved.generation, lifetime: saved.lifetime },
        recovery: writeProjectRecovery(
          { revision: saved.revision, authoring: saved.authoring, profileId: ws.profileId },
          ws.draft.captureRecovery(),
        ),
      };
    },
    onError: (message) => {
      persistError.value = `Unsaved work could not be stored: ${message}`;
    },
    ...(ws.restoredRecovery ? { receipt: ws.restoredRecovery.receipt } : {}),
  });
  revision.value++;
  syncAnalysis();
  const first =
    documents.value.find((doc) => doc.key.startsWith("logic:"))?.key ?? documents.value[0]?.key;
  if (first) openDocument(first);
}

/**
 * The mount/open epoch: each open supersedes the one before it, and unmount
 * voids every in-flight open. A deferred result must never install models,
 * a persister or recovery state onto a studio that has already moved on.
 */
let openEpoch = 0;

/**
 * Open (or switch to) a stored project inside this mounted workspace. A
 * dirty draft never silently discards: the caller gates on the guard first.
 */
async function openProject(next: ProjectId): Promise<void> {
  const epoch = ++openEpoch;
  opening.value = true;
  openError.value = "";
  persistError.value = undefined;
  recoveryError.value = undefined;
  review.value = undefined;
  leaveAsk.value = false;
  problems.value = [];
  try {
    // A clean switch can still owe the record the outgoing draft left behind.
    // Settle it only while that draft stays clean — typing during the wait
    // means the record protects live work again — then re-review the same
    // mounted workspace before mounting over it.
    const outgoing = workspace.value;
    const writer = persister;
    // The outgoing draft's revision fingerprints the state this switch was
    // decided against: a deliberately approved dirty switch (the Keep and
    // Discard paths re-enter here) keeps the same revision and proceeds,
    // while any write — typing or undo — during an await bumps it and, if
    // the draft is still dirty, revokes the switch back to the dirty guard.
    const outgoingRevision = outgoing?.draft.capture().revision;
    const dirtyAgain = (): boolean =>
      outgoing !== undefined &&
      outgoing.draft.capture().revision !== outgoingRevision &&
      outgoing.draft.dirtyKeys().length > 0;
    const settled = (await writer?.discard({ onlyIfClean: true })) ?? true;
    if (epoch !== openEpoch) return;
    if (!settled) {
      // The settle failed with persistError shown; keep the mounted project
      // and point the parent back at it so prop and visible work agree.
      const open = workspace.value?.projectId;
      if (open !== undefined && open !== next) emit("update:projectId", open);
      return;
    }
    if (workspace.value !== outgoing) {
      // The mounted workspace moved while settling; the prop's current
      // target still applies to whatever is open now.
      if (projectId !== undefined && projectId !== workspace.value?.projectId)
        void openProject(projectId);
      return;
    }
    if (dirtyAgain()) {
      switchTarget = next;
      leaveAsk.value = true;
      return;
    }
    const ws = await openEditableProject(next);
    if (epoch !== openEpoch) return;
    // The target can take arbitrarily long to open; the outgoing editor
    // stayed live meanwhile, so re-review it before mounting over it. The
    // refused workspace is never mounted: no models, analysis or persister.
    if (workspace.value !== outgoing) {
      if (projectId !== undefined && projectId !== workspace.value?.projectId)
        void openProject(projectId);
      return;
    }
    if (dirtyAgain()) {
      switchTarget = next;
      leaveAsk.value = true;
      return;
    }
    mountWorkspace(ws);
    await refreshRecovery();
    if (epoch !== openEpoch) return;
    if (recovery.value.length > 0) recoveryOpen.value = true;
    // The projectId watch is inert while an open is in flight, so a switch
    // requested during a deferred open would otherwise be dropped — honor
    // the prop's current target after this open lands.
    if (projectId !== undefined && projectId !== next) void openProject(projectId);
  } catch (error) {
    if (epoch === openEpoch) openError.value = reason(error);
  } finally {
    if (epoch === openEpoch) opening.value = false;
  }
}

// A new projectId while one is mounted is a switch request, not a remount:
// dirty work gets the same Keep/Discard/Cancel guard as closing, and the
// displayed project keeps its identity until the user decides.
watch(
  () => projectId,
  (next) => {
    if (next === workspace.value?.projectId || opening.value) return;
    if (changes.value > 0 || keeping.value) {
      switchTarget = next;
      leaveAsk.value = true;
    } else {
      void openProject(next);
    }
  },
);

onMounted(async () => {
  editor = monaco.editor.create(editorHost.value!, {
    automaticLayout: true,
    theme: "vs-dark",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    tabSize: 2,
    insertSpaces: true,
    ariaLabel: "Project document",
  });
  await openProject(projectId);
});

onBeforeUnmount(() => {
  openEpoch++;
  window.removeEventListener("beforeunload", onBeforeUnload);
  if (problemsTimer !== undefined) clearTimeout(problemsTimer);
  if (savedNoteTimer) clearTimeout(savedNoteTimer);
  teardownModels();
  persister?.dispose();
  client?.dispose();
  editor?.dispose();
});

/** Dev/e2e handle: the editor's caret, for the definition-navigation check. */
function cursor(): { line: number; column: number } | undefined {
  const position = editor?.getPosition();
  return position ? { line: position.lineNumber, column: position.column } : undefined;
}
defineExpose({ cursor });
</script>

<template>
  <section class="logic-studio" data-testid="logic-studio" aria-label="Logic Studio">
    <header class="logic-studio__bar">
      <div class="logic-studio__title">
        <h1>{{ title }}</h1>
        <p>Source: stored project</p>
      </div>
      <UiChip :tone="changes === 0 ? 'neutral' : 'action'" dot data-testid="logic-studio-status">
        {{ statusText }}
      </UiChip>
      <p v-if="savedNote" class="logic-studio__saved" data-testid="logic-saved-note" role="status">
        {{ savedNote }}
      </p>
      <p
        v-if="persistError"
        class="logic-studio__alert"
        role="alert"
        data-testid="logic-persist-error"
      >
        {{ persistError }}
      </p>
      <p v-if="openError" class="logic-studio__alert" role="alert" data-testid="logic-open-error">
        {{ openError }}
      </p>
      <div class="logic-studio__actions">
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="!editorCommandsEnabled"
          title="Undo"
          data-testid="logic-undo"
          @click="runEditorCommand('undo')"
        >
          Undo
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="!editorCommandsEnabled"
          title="Redo"
          data-testid="logic-redo"
          @click="runEditorCommand('redo')"
        >
          Redo
        </UiButton>
        <UiButton
          variant="primary"
          size="sm"
          :disabled="changes === 0 || keeping"
          :title="
            rejectedKeys.length
              ? 'The project has source claims set aside for review; resolve them first'
              : 'Build the changes, review the diff, then keep'
          "
          data-testid="logic-review-build"
          @click="requestKeep()"
        >
          Keep
        </UiButton>
        <UiIconButton
          icon="x"
          label="Close"
          size="sm"
          data-testid="logic-close"
          @click="requestClose"
        />
      </div>
    </header>

    <div class="logic-studio__body">
      <LogicExplorer
        class="logic-studio__rail"
        :documents
        :active-key="activeKey"
        :rejected-keys="rejectedKeys"
        @open="openDocument"
      />
      <div class="logic-studio__main">
        <div
          v-if="rejectedKeys.length || sourceDiagnostics.length"
          class="logic-studio__review-note"
          role="status"
        >
          <p v-for="(diag, index) in sourceDiagnostics" :key="index">
            {{ diag.key }}: {{ diag.message }}
          </p>
        </div>
        <div class="logic-studio__tabs" role="tablist" aria-label="Open documents">
          <div
            v-for="key in openTabs"
            :key="key"
            role="tab"
            class="logic-studio__tab"
            :class="{ 'logic-studio__tab--active': key === activeKey }"
            :aria-selected="key === activeKey"
            :data-testid="`logic-tab-${key}`"
          >
            <button type="button" class="logic-studio__tab-name" @click="activateDocument(key)">
              {{ documentLabel(key) }}
            </button>
            <button
              type="button"
              class="logic-studio__tab-close"
              :aria-label="`Close ${documentLabel(key)}`"
              :data-testid="`logic-tab-close-${key}`"
              @click="closeDocumentTab(key)"
            >
              ×
            </button>
          </div>
        </div>
        <div class="logic-studio__editor">
          <div
            v-show="activeText"
            ref="editorHost"
            class="logic-studio__monaco"
            data-testid="logic-editor"
          ></div>
          <LogicByteView
            v-if="activeDocument?.kind === 'bytes'"
            :bytes="activeDocument.content as Uint8Array"
            :derived-source="derivedPreview"
          />
          <p v-if="activeDocument === undefined" class="logic-studio__empty">
            {{ opening ? "Opening the project…" : "Choose a document on the left." }}
          </p>
        </div>
        <section class="logic-studio__problems" data-testid="logic-problems" aria-label="Problems">
          <h2>
            Problems<template v-if="problems.length"> ({{ problems.length }})</template>
          </h2>
          <p v-if="contextError" class="logic-studio__problem logic-studio__problem--error">
            {{ contextError }}
          </p>
          <p v-if="!contextError && problems.length === 0" class="logic-studio__problem-none">
            No problems in the open documents.
          </p>
          <button
            v-for="(problem, index) in problems"
            :key="index"
            type="button"
            class="logic-studio__problem"
            :class="`logic-studio__problem--${problem.severity}`"
            @click="goToProblem(problem)"
          >
            {{ documentLabel(problem.key) }} {{ problem.line }}:{{ problem.column }} —
            {{ problem.message }}
          </button>
        </section>
      </div>
      <div class="logic-studio__companion"></div>
    </div>

    <UiDialog
      :open="leaveAsk"
      title="Keep your changes?"
      size="sm"
      :description="`${title} has ${changes} unkept ${changes === 1 ? 'change' : 'changes'}. Keep builds and reviews them first.`"
      data-testid="logic-leave-dialog"
      @update:open="(next) => (next ? (leaveAsk = true) : cancelLeave())"
    >
      <template #footer>
        <UiButton variant="ghost" data-testid="logic-leave-cancel" @click="cancelLeave">
          Cancel
        </UiButton>
        <UiButton variant="danger" data-testid="logic-leave-discard" @click="discardAndClose">
          Discard
        </UiButton>
        <UiButton
          variant="primary"
          :disabled="rejectedKeys.length > 0"
          :title="
            rejectedKeys.length > 0
              ? 'Resolve the source claims set aside for review first'
              : undefined
          "
          data-testid="logic-leave-keep"
          @click="keepAndClose"
        >
          Keep
        </UiButton>
      </template>
    </UiDialog>

    <LogicReviewDialog
      v-if="review"
      :open="review !== undefined"
      :candidate="review.candidate"
      :entries="review.entries"
      :dirty="dirtyKeys"
      :selected="review.selected"
      :keeping
      :error="reviewError"
      @update:open="
        (next) => {
          if (!next) {
            review = undefined;
            closeAfterKeep = false;
            cancelSwitch();
          }
        }
      "
      @toggle="toggleKeepRoot"
      @keep="confirmKeep"
    />

    <LogicRecoveryDialog
      v-if="recovery.length"
      v-model:open="recoveryOpen"
      :entries="recovery"
      :busy="recoveryBusy"
      @restore="restoreEntry"
      @discard="discardEntry"
      @download="downloadEntry"
      @open-stored="recoveryOpen = false"
    />
    <p v-if="recoveryError" class="logic-studio__alert" role="alert">{{ recoveryError }}</p>
  </section>
</template>

<style scoped>
.logic-studio {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background: var(--surface-0);
}
.logic-studio__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
.logic-studio__title {
  min-width: 0;
}
.logic-studio__title h1 {
  margin: 0;
  font: var(--weight-semibold) var(--text-md) / var(--leading) var(--font-sans);
}
.logic-studio__title p {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.logic-studio__saved {
  margin: 0;
  color: var(--ok);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-studio__alert {
  margin: 0;
  color: var(--danger);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-studio__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}
.logic-studio__body {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 220px;
  flex: 1;
  min-height: 0;
}
.logic-studio__rail {
  border-right: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
.logic-studio__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.logic-studio__review-note {
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--warn-line);
  color: var(--warn);
  background: var(--warn-soft);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-studio__review-note p {
  margin: 0;
}
.logic-studio__tabs {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2) 0;
  border-bottom: 1px solid var(--hairline-strong);
  background: var(--surface-sunken);
  overflow-x: auto;
}
.logic-studio__tab {
  display: inline-flex;
  align-items: center;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  color: var(--ink-2);
}
.logic-studio__tab--active {
  color: var(--ink);
  background: var(--surface-0);
  border-color: var(--hairline-strong);
}
.logic-studio__tab-name {
  padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
  border: 0;
  color: inherit;
  background: transparent;
  font: var(--text-xs) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.logic-studio__tab-close {
  padding: var(--space-1) var(--space-2);
  border: 0;
  color: var(--ink-3);
  background: transparent;
  font: var(--text-sm) / 1 var(--font-sans);
  cursor: pointer;
}
.logic-studio__tab-close:hover {
  color: var(--ink);
}
.logic-studio__editor {
  position: relative;
  flex: 1;
  min-height: 0;
}
.logic-studio__monaco {
  position: absolute;
  inset: 0;
}
.logic-studio__empty {
  padding: var(--space-6);
  color: var(--ink-3);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.logic-studio__problems {
  max-height: 168px;
  overflow: auto;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
.logic-studio__problems h2 {
  margin: 0 0 var(--space-1);
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.logic-studio__problem {
  display: block;
  width: 100%;
  padding: var(--space-0) 0;
  border: 0;
  color: var(--ink-2);
  background: transparent;
  font: var(--text-xs) / var(--leading) var(--font-mono);
  text-align: left;
  cursor: pointer;
}
.logic-studio__problem--error {
  color: var(--danger);
}
.logic-studio__problem--warning {
  color: var(--warn);
}
.logic-studio__problem-none {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-studio__companion {
  padding: var(--space-4);
  border-left: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
@media (max-width: 1100px) {
  .logic-studio__body {
    grid-template-columns: 200px minmax(0, 1fr);
  }
  .logic-studio__companion {
    display: none;
  }
}
</style>
