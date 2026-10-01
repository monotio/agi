<script setup lang="ts">
import { VOCABULARY_ACTIONS } from "../../../../src/studio/vocabulary.ts";
/**
 * Sound Studio: the stored-project workspace for native SOUND cues. It opens
 * through openEditableProject like Logic Studio — no worker, no provider, no
 * key — and edits through the same ProjectDraft authority: every cue change is
 * one draft transaction holding the tagged sound-document envelope beside the
 * music entry. Keep builds a reviewed candidate over the dirty closure and
 * admits it through keepCandidate; a dirty close or switch asks first, and the
 * recovery sidecar persists unfinished drafts between sessions.
 *
 * Audible preview runs on a private AgiAudio through the accepted
 * SoundAudition service; it acquires a runtime pause lease only while a run
 * is mounted and releases exactly its own hold on close.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { writeProjectRecovery } from "../../../../src/authoring/projectRecovery.ts";
import type { ProjectId } from "../../project/gameTypes.ts";
import type {
  EditableCandidate,
  EditableOpenOptions,
  EditableProject,
} from "../../project/editableProject.ts";
import { discardProjectDraft } from "../../project/projectDrafts.ts";
import type { RuntimePauseLeaseAcquire } from "../../engine/runtimePauseLease.ts";
import type { AudioMode } from "../../audio/AgiAudio.ts";
import type { SoundDocument, SoundEvent } from "../../../../src/sound/document.ts";
import { SOUND_PRESETS } from "../../../../src/sound/presets.ts";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiDialog from "../../ui/UiDialog.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import SoundTimeline from "./SoundTimeline.vue";
import SoundInspector from "./SoundInspector.vue";
import { createSoundPreview } from "./soundPreview.ts";
import {
  SoundDraftPersister,
  soundRecoveryEntries,
  type SoundRecoveryEntry,
} from "./soundRecovery.ts";
import { SOUND_MAX_BYTES, soundKey } from "./soundDocuments.ts";
import { splitEventAt, ticksSeconds } from "./soundEdits.ts";
import { soundStudioKey } from "./soundStudioKeys.ts";
import { SoundStudioWorkspace, type SoundEntry } from "./soundWorkspace.ts";

const props = defineProps<{
  projectId: ProjectId;
  /** The engine's runtime freeze acquirer, wired by App.vue. */
  acquirePauseLease: RuntimePauseLeaseAcquire;
}>();
const emit = defineEmits<{
  close: [];
  "update:projectId": [ProjectId];
}>();

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* --- Workspace ---------------------------------------------------------- */

const workspace = new SoundStudioWorkspace();
const revision = ref(0);
workspace.subscribe(() => {
  revision.value++;
  persister?.schedule();
});

const opening = ref(true);
const openError = ref("");
const persistError = ref<string | undefined>();
const savedNote = ref<string | undefined>();
const notice = ref<string | undefined>();
let savedNoteTimer: ReturnType<typeof setTimeout> | undefined;
let persister: SoundDraftPersister | undefined;

const entries = computed<readonly (SoundEntry | { key: string; num: number; openError: string })[]>(
  () => (revision.value < 0 ? [] : workspace.entries()),
);
const changes = computed(() => (revision.value < 0 ? 0 : workspace.dirtyKeys().length));
const title = computed(() =>
  revision.value < 0 ? "Project" : (workspace.project?.storedData().title ?? "Project"),
);

/** The selected cue number; the first entry until the user picks one. */
const activeNum = ref<number>();
const activeEntry = computed<SoundEntry | null>(() => {
  const num = activeNum.value;
  if (num === undefined) return null;
  const entry = entries.value.find((item) => item.num === num);
  return entry !== undefined && !("openError" in entry) ? entry : null;
});
const activeOpened = computed<{ document: SoundDocument } | null>(() => {
  const num = activeNum.value;
  if (num === undefined || revision.value < 0) return null;
  return workspace.documentFor(num);
});
const activeDocument = computed(() => activeOpened.value?.document ?? null);
const activeOpaque = computed(() => activeDocument.value?.representation === "opaque");

/* --- Selection and event editing ---------------------------------------- */

const selectedEventId = ref<string>();
const cursorLane = ref(0);
const cursorIndex = ref(0);
const editError = ref<string>();

const lanes = computed(() => activeDocument.value?.tracks() ?? null);
const selectedEvent = computed<SoundEvent | null>(() => {
  const id = selectedEventId.value;
  const doc = activeDocument.value;
  if (id === undefined || doc === null) return null;
  return doc.event(id) ?? null;
});

function selectCue(num: number): void {
  activeNum.value = num;
  selectedEventId.value = undefined;
  cursorLane.value = 0;
  cursorIndex.value = 0;
  editError.value = undefined;
  notice.value = undefined;
}

function selectEvent(id: string, lane: number, index: number): void {
  selectedEventId.value = id;
  cursorLane.value = lane;
  cursorIndex.value = index;
  editError.value = undefined;
}

function setCursor(lane: number, index: number): void {
  cursorLane.value = lane;
  cursorIndex.value = index;
  selectedEventId.value = undefined;
  editError.value = undefined;
}

/** One model edit on the active cue; the document's own errors surface. */
function runEdit(label: string, edit: (document: SoundDocument) => SoundDocument): boolean {
  const num = activeNum.value;
  if (num === undefined) return false;
  try {
    const next = workspace.editCue(num, label, edit);
    const id = selectedEventId.value;
    if (id !== undefined && next.event(id) === undefined) {
      const track = next.tracks()?.[cursorLane.value] ?? [];
      cursorIndex.value = Math.min(cursorIndex.value, track.length);
    }
    editError.value = undefined;
    return true;
  } catch (error) {
    editError.value = reason(error);
    return false;
  }
}

function eventEdit(
  label: string,
  edit: (document: SoundDocument, id: string) => SoundDocument,
): void {
  const id = selectedEventId.value;
  if (id === undefined) return;
  runEdit(label, (document) => edit(document, id));
}

function setEventTicks(ticks: number): void {
  eventEdit("Set duration", (document, id) => document.updateEvent(id, { ticks }));
}
function setEventNote(note: string): void {
  // The model's own grammar decides what a name or MIDI number is.
  eventEdit(`Set note ${note}`, (document, id) => document.updateEvent(id, { note }));
}
function setEventAttenuation(attenuation: number): void {
  eventEdit("Set attenuation", (document, id) => document.updateEvent(id, { attenuation }));
}
function setEventControl(control: number): void {
  eventEdit("Set noise control", (document, id) => document.updateEvent(id, { control }));
}
function replaceEventData(kind: "tone" | "noise" | "rest"): void {
  const data =
    kind === "tone"
      ? { kind: "tone" as const, divisor: 200, attenuation: 0 }
      : kind === "noise"
        ? { kind: "noise" as const, control: 4, attenuation: 0 }
        : { kind: "rest" as const };
  eventEdit(`Make ${kind}`, (document, id) => document.replaceEventData(id, data));
}
function removeSelectedEvent(): void {
  const id = selectedEventId.value;
  if (id === undefined) return;
  if (runEdit("Remove event", (document) => document.removeEvent(id))) {
    selectedEventId.value = undefined;
  }
}
function duplicateSelectedEvent(): void {
  const id = selectedEventId.value;
  if (id === undefined) return;
  runEdit("Duplicate event", (document) => document.duplicateEvent(id));
}
function splitSelectedEvent(atTicks: number): void {
  const id = selectedEventId.value;
  if (id === undefined) return;
  runEdit("Split event", (document) => splitEventAt(document, id, atTicks));
}

/** Insert a note (or noise on lane 3) at the cursor; the default is a short mid-range hit. */
function insertAtCursor(kind: "note" | "rest"): void {
  const num = activeNum.value;
  if (num === undefined || activeOpaque.value) return;
  const lane = cursorLane.value;
  const index = cursorIndex.value;
  const data =
    kind === "rest"
      ? { kind: "rest" as const }
      : lane === 3
        ? { kind: "noise" as const, control: 4, attenuation: 0 }
        : { kind: "tone" as const, divisor: 200, attenuation: 0 };
  if (
    runEdit(kind === "rest" ? "Add rest" : "Add note", (document) =>
      document.insertEvent(lane, index, { ticks: 15, data }),
    )
  ) {
    cursorIndex.value = index + 1;
  }
}

/* --- Cue actions --------------------------------------------------------- */

const newOpen = ref(false);
const presets = SOUND_PRESETS;
const freeNum = computed(() => {
  if (revision.value < 0) return null;
  const capture = workspace.draft?.capture();
  if (capture === undefined) return null;
  for (let num = 0; num <= 255; num++) {
    if (capture.read(soundKey(num))?.content === undefined) return num;
  }
  return null;
});

function createCue(presetId: string | null): void {
  newOpen.value = false;
  try {
    const num = workspace.createCue(presetId);
    selectCue(num);
  } catch (error) {
    notice.value = reason(error);
  }
}

function duplicateCue(): void {
  const num = activeNum.value;
  if (num === undefined) return;
  try {
    const target = workspace.duplicateCue(num);
    selectCue(target);
    notice.value = undefined;
  } catch (error) {
    notice.value = reason(error);
  }
}

/**
 * The removal request stages one draft transaction (cue + music entry) that
 * Undo restores and the Keep review names before anything commits — nothing
 * writes to the saved project here.
 */
function removeCue(): void {
  const num = activeNum.value;
  if (num === undefined) return;
  try {
    const refusal = workspace.removeCue(num);
    if (refusal !== null) {
      notice.value = refusal;
      return;
    }
    selectedEventId.value = undefined;
    activeNum.value = undefined;
    notice.value = undefined;
  } catch (error) {
    notice.value = reason(error);
  }
}

const importConfirm = shallowRef<{
  service: EditableProject;
  num: number;
  version: number;
  bytes: Uint8Array;
  name: string;
} | null>(null);
const fileInput = useTemplateRef("fileInput");
const importTarget = ref<number>();

function pickImport(num: number | null | undefined): void {
  importTarget.value = num ?? undefined;
  fileInput.value?.click();
}

/** The draft's version stamp for one sound key; the replace confirm pins it. */
function draftVersion(service: EditableProject, num: number): number {
  return service.draft.capture().version(soundKey(num));
}

/**
 * The owned byte bound is checked on the file's own size before any async
 * read: an oversized file is refused without touching the draft. The read is
 * pinned to the workspace it started under — a close or switch while the
 * bytes stream in drops the file rather than writing a newer project.
 */
async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const num = importTarget.value;
  const service = workspace.project;
  if (file === undefined || num === undefined || service === null) return;
  if (file.size > SOUND_MAX_BYTES) {
    notice.value = `${file.name} is ${file.size} bytes; a native SOUND resource holds at most ${SOUND_MAX_BYTES}.`;
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    notice.value = `${file.name} could not be read: ${reason(error)}`;
    return;
  }
  if (workspace.project !== service) return;
  if (workspace.documentFor(num) !== null) {
    importConfirm.value = {
      service,
      num,
      version: draftVersion(service, num),
      bytes,
      name: file.name,
    };
    return;
  }
  try {
    workspace.importCue(num, bytes);
    selectCue(num);
    notice.value = undefined;
  } catch (error) {
    notice.value = reason(error);
  }
}

/**
 * The confirm dialog owns the exact workspace and document version it asked
 * about: a switch or an edit that landed while it was open refuses instead
 * of overwriting work the user never saw.
 */
function confirmImport(): void {
  const held = importConfirm.value;
  importConfirm.value = null;
  if (held === null) return;
  if (workspace.project !== held.service) return;
  if (draftVersion(held.service, held.num) !== held.version) {
    notice.value = `SOUND ${held.num} changed while the file was read; pick Replace again to confirm.`;
    return;
  }
  try {
    workspace.importCue(held.num, held.bytes);
    selectCue(held.num);
    notice.value = undefined;
  } catch (error) {
    notice.value = reason(error);
  }
}

/** The exact native payload, downloaded as `sound-<num>.snd`. */
function exportCue(): void {
  const num = activeNum.value;
  if (num === undefined) return;
  const payload = workspace.nativePayload(num);
  if (payload === null) return;
  const url = URL.createObjectURL(new Blob([payload.buffer as ArrayBuffer]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sound-${num}.snd`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function setTempo(tempo: number): void {
  const num = activeNum.value;
  if (num === undefined) return;
  try {
    workspace.setTempo(num, tempo);
    editError.value = undefined;
  } catch (error) {
    editError.value = reason(error);
  }
}

/* --- Preview -------------------------------------------------------------- */

const preview = createSoundPreview({ acquirePauseLease: props.acquirePauseLease });
const previewTick = ref(0);
preview.subscribe(() => previewTick.value++);
const previewSnapshot = computed(() => (previewTick.value < 0 ? null : preview.snapshot));

/** Retarget the preview at the active cue's current draft payload. */
function syncPreviewTarget(): void {
  const ws = workspace.project;
  const num = activeNum.value;
  if (ws === null || num === undefined) return;
  const payload = workspace.nativePayload(num);
  if (payload === null) return;
  preview.setTarget({
    projectId: ws.projectId,
    workspaceId: ws.workspaceId,
    documentId: soundKey(num),
    revision: ws.draft.capture().version(soundKey(num)),
    payload,
    profileId: ws.profileId,
  });
}

watch([activeNum, revision], () => {
  if (activeDocument.value !== null) syncPreviewTarget();
  else preview.stop();
});

function setPreviewDevice(mode: AudioMode): void {
  preview.setDevice(mode);
}

/* --- Undo / Keep / close -------------------------------------------------- */

function undo(): void {
  workspace.undo();
}
function redo(): void {
  workspace.redo();
}

const review = shallowRef<{
  service: EditableProject;
  candidate: EditableCandidate | undefined;
  keys: readonly string[];
  selected: readonly string[];
}>();
const reviewError = ref<string | undefined>();
const keeping = ref(false);
let closeAfterKeep = false;

function requestKeep(fromClose = false, roots: readonly string[] | undefined = undefined): void {
  const ws = workspace.project;
  if (ws === null || keeping.value) return;
  reviewError.value = undefined;
  closeAfterKeep = fromClose;
  const dirty = workspace.dirtyKeys();
  const selected = (roots ?? dirty).filter((key) => dirty.includes(key));
  if (selected.length === 0) {
    review.value = { service: ws, candidate: undefined, keys: [], selected };
    return;
  }
  try {
    const candidate = workspace.buildSelected(selected);
    review.value = { service: ws, candidate, keys: candidate.keys, selected };
  } catch (error) {
    review.value = { service: ws, candidate: undefined, keys: selected, selected };
    reviewError.value = reason(error);
  }
}

function toggleKeepRoot(key: string): void {
  const held = review.value;
  if (held === undefined || keeping.value || held.service !== workspace.project) return;
  const roots = held.selected.includes(key)
    ? held.selected.filter((root) => root !== key)
    : [...held.selected, key];
  requestKeep(closeAfterKeep, roots);
}

async function afterKept(): Promise<void> {
  const target = switchTarget;
  switchTarget = null;
  if (target !== null) await openProject(target);
  else emit("close");
}

async function confirmKeep(): Promise<void> {
  const held = review.value;
  const candidate = held?.candidate;
  if (held === undefined || candidate === undefined || keeping.value) return;
  keeping.value = true;
  reviewError.value = undefined;
  try {
    // Keep through the service that issued this candidate: a project switch
    // mid-review commits the durable work the user approved, then the UI
    // aftermath pins the still-open workspace — a superseded service touches
    // no newer project's notices, persister or close routing.
    // The review names the candidate's own computed removals verbatim — the
    // service rechecks them exactly, so the approval cannot widen a removal.
    await held.service.keepCandidate(
      candidate,
      candidate.removedResources.length > 0
        ? { reviewedRemovals: candidate.removedResources }
        : undefined,
    );
    if (workspace.project !== held.service) return;
    workspace.noteKept(held.service);
    // The review was dismissed while the commit ran: the durable keep stands
    // but the close/switch aftermath does not fire under a cancelled intent.
    if (review.value !== held) return;
    review.value = undefined;
    persistError.value = undefined;
    savedNote.value = "Saved to the library";
    if (savedNoteTimer) clearTimeout(savedNoteTimer);
    savedNoteTimer = setTimeout(() => (savedNote.value = undefined), 4000);
    if (closeAfterKeep) {
      const done =
        workspace.dirtyKeys().length > 0
          ? ((await persister?.flush()) ?? true)
          : ((await persister?.discard()) ?? true);
      if (!done) {
        closeAfterKeep = false;
        return;
      }
      closeAfterKeep = false;
      await afterKept();
    } else if (workspace.dirtyKeys().length > 0) {
      persister?.schedule();
    } else {
      await persister?.discard();
    }
  } catch (error) {
    if (workspace.project === held.service) {
      reviewError.value = reason(error);
      closeAfterKeep = false;
    }
  } finally {
    keeping.value = false;
  }
}

const leaveAsk = ref(false);
let switchTarget: ProjectId | null = null;

function requestClose(): void {
  if (keeping.value) return;
  if (changes.value === 0) {
    emit("close");
    return;
  }
  leaveAsk.value = true;
}

function keepAndClose(): void {
  leaveAsk.value = false;
  requestKeep(true);
}

function cancelSwitch(): void {
  if (switchTarget === null) return;
  switchTarget = null;
  const open = workspace.projectId;
  if (open !== null) emit("update:projectId", open);
}

function cancelLeave(): void {
  leaveAsk.value = false;
  cancelSwitch();
}

async function discardAndClose(): Promise<void> {
  const done = (await persister?.discard()) ?? true;
  // A dismissed dialog while the discard ran cancels the close/switch too.
  if (!done || !leaveAsk.value) return;
  leaveAsk.value = false;
  const target = switchTarget;
  switchTarget = null;
  if (target !== null) await openProject(target);
  else emit("close");
}

/* --- Recovery -------------------------------------------------------------- */

const recovery = ref<readonly SoundRecoveryEntry[]>([]);
const recoveryOpen = ref(false);
const recoveryBusy = ref(false);
const recoveryError = ref<string | undefined>();

async function restoreRecovery(entry: SoundRecoveryEntry): Promise<void> {
  const service = workspace.project;
  if (service === null || recoveryBusy.value) return;
  recoveryBusy.value = true;
  recoveryError.value = undefined;
  try {
    const restore: EditableOpenOptions =
      entry.kind === "stored"
        ? { restore: { workspaceId: entry.workspaceId, receipt: entry.receipt } }
        : { restore: { portable: entry.recovery } };
    const ws = await workspace.open(service.projectId, restore);
    // A close or a newer open while the restore loaded owns the workspace now.
    if (ws === null || workspace.project !== ws) return;
    afterProjectOpened(ws);
    selectedEventId.value = undefined;
    activeNum.value = undefined;
    const found = await soundRecoveryEntries(ws.storedData());
    if (workspace.project !== ws) return;
    recovery.value = found;
    recoveryOpen.value = false;
  } catch (error) {
    if (workspace.project === service) recoveryError.value = reason(error);
  } finally {
    recoveryBusy.value = false;
  }
}

async function discardRecovery(entry: SoundRecoveryEntry): Promise<void> {
  const service = workspace.project;
  if (service === null || recoveryBusy.value) return;
  recoveryBusy.value = true;
  recoveryError.value = undefined;
  try {
    if (entry.kind === "stored")
      await discardProjectDraft(service.projectId, entry.workspaceId, entry.receipt);
    const found = await soundRecoveryEntries(service.storedData());
    if (workspace.project !== service) return;
    recovery.value = found;
    if (found.length === 0) recoveryOpen.value = false;
  } catch (error) {
    if (workspace.project === service) recoveryError.value = reason(error);
  } finally {
    recoveryBusy.value = false;
  }
}

/* --- Open / lifecycle ------------------------------------------------------- */

/** Per-open wiring: the persister writes this workspace's draft sidecar. */
function afterProjectOpened(ws: NonNullable<typeof workspace.project>): void {
  persister?.dispose();
  const recoveryId = ws.restoredRecovery?.workspaceId ?? ws.workspaceId;
  persister = new SoundDraftPersister({
    projectId: ws.projectId,
    workspaceId: recoveryId,
    capture: () => {
      if (workspace.project !== ws || ws.draft.dirtyKeys().length === 0) return null;
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
}

/**
 * The component's own open epoch: the latest invocation owns the spinner,
 * error and selection reset. workspace.open resolves null for a superseded
 * load, so a late completion can never install or clear newer state.
 */
let openTicket = 0;

async function openProject(next: ProjectId, options?: EditableOpenOptions): Promise<void> {
  const ticket = ++openTicket;
  opening.value = true;
  openError.value = "";
  persistError.value = undefined;
  recoveryError.value = undefined;
  review.value = undefined;
  leaveAsk.value = false;
  importConfirm.value = null;
  recovery.value = [];
  recoveryOpen.value = false;
  notice.value = undefined;
  try {
    const ws = await workspace.open(next, options);
    if (ws === null || ticket !== openTicket || workspace.project !== ws) return;
    afterProjectOpened(ws);
    selectedEventId.value = undefined;
    cursorLane.value = 0;
    cursorIndex.value = 0;
    const first = workspace.entries().find((entry) => !("openError" in entry));
    activeNum.value = first !== undefined && !("openError" in first) ? first.num : undefined;
    const found = await soundRecoveryEntries(ws.storedData());
    if (workspace.project !== ws || ticket !== openTicket) return;
    recovery.value = found;
    if (found.length > 0) recoveryOpen.value = true;
  } catch (error) {
    if (ticket === openTicket) openError.value = reason(error);
  } finally {
    if (ticket === openTicket) opening.value = false;
  }
}

/** A dirty draft never silently discards: switches gate on the leave guard. */
function requestSwitch(next: ProjectId): void {
  if (changes.value === 0) {
    void openProject(next);
    return;
  }
  switchTarget = next;
  leaveAsk.value = true;
}

watch(
  () => props.projectId,
  (next, previous) => {
    if (next === previous || next === workspace.projectId) return;
    requestSwitch(next);
  },
);

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (changes.value === 0) return;
  event.preventDefault();
}

const timeline = useTemplateRef("timeline");

function onKeydown(event: KeyboardEvent): void {
  const handled = soundStudioKey(event, {
    onTimeline: (target) =>
      target instanceof HTMLElement && timeline.value?.$el.contains(target) === true,
    dismiss: () => {
      // An open dialog owns its own Esc.
      if (
        review.value !== undefined ||
        leaveAsk.value ||
        recoveryOpen.value ||
        importConfirm.value !== null
      )
        return false;
      if (notice.value !== undefined) {
        notice.value = undefined;
        return true;
      }
      if (selectedEventId.value !== undefined) {
        selectedEventId.value = undefined;
        return true;
      }
      return false;
    },
    step: (direction) => {
      const track = lanes.value?.[cursorLane.value] ?? [];
      cursorIndex.value = Math.min(Math.max(cursorIndex.value + direction, 0), track.length);
      const entry = track[cursorIndex.value];
      selectedEventId.value = entry?.id;
    },
    lane: (direction) => {
      cursorLane.value = Math.min(Math.max(cursorLane.value + direction, 0), 3);
      const track = lanes.value?.[cursorLane.value] ?? [];
      cursorIndex.value = Math.min(cursorIndex.value, track.length);
    },
    jump: (to) => {
      const track = lanes.value?.[cursorLane.value] ?? [];
      cursorIndex.value = to === "first" ? 0 : track.length;
      selectedEventId.value = undefined;
    },
    remove: removeSelectedEvent,
    insertNote: () => insertAtCursor("note"),
    insertRest: () => insertAtCursor("rest"),
    undo,
    redo,
    togglePlay: () => {
      const status = preview.snapshot.status;
      if (status === "playing") preview.pause();
      else preview.play();
    },
  });
  if (handled) {
    event.preventDefault();
    event.stopPropagation();
  }
}

onMounted(async () => {
  window.addEventListener("beforeunload", onBeforeUnload);
  await openProject(props.projectId);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  openTicket++;
  if (savedNoteTimer) clearTimeout(savedNoteTimer);
  persister?.dispose();
  persister = undefined;
  void preview.close();
  workspace.close();
});

/** e2e/dev handle: the selected event id and cursor, mirroring Logic's cursor(). */
function cursor(): { eventId: string | null; lane: number; index: number } {
  return {
    eventId: selectedEventId.value ?? null,
    lane: cursorLane.value,
    index: cursorIndex.value,
  };
}
defineExpose({ cursor });
</script>

<template>
  <section
    class="sound-studio"
    aria-label="Sound Studio"
    data-testid="sound-studio"
    @keydown="onKeydown"
  >
    <header class="sound-studio__bar">
      <div class="sound-studio__title">
        <h1>Sound Studio</h1>
        <p>{{ title }}</p>
      </div>
      <UiChip :tone="changes === 0 ? 'neutral' : 'action'" dot data-testid="sound-studio-status">
        {{ changes === 0 ? "Saved" : `${changes} ${changes === 1 ? "change" : "changes"}` }}
      </UiChip>
      <p v-if="savedNote" class="sound-studio__saved" role="status" data-testid="sound-saved-note">
        {{ savedNote }}
      </p>
      <p v-if="notice" class="sound-studio__alert" role="alert" data-testid="sound-notice">
        {{ notice }}
      </p>
      <p
        v-if="persistError"
        class="sound-studio__alert"
        role="alert"
        data-testid="sound-persist-error"
      >
        {{ persistError }}
      </p>
      <p v-if="openError" class="sound-studio__alert" role="alert" data-testid="sound-open-error">
        {{ openError }}
      </p>
      <div class="sound-studio__actions">
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="!workspace.canUndo"
          :title="workspace.undoLabel() ?? 'Undo'"
          data-testid="sound-undo"
          @click="undo"
        >
          Undo
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          :disabled="!workspace.canRedo"
          :title="workspace.redoLabel() ?? 'Redo'"
          data-testid="sound-redo"
          @click="redo"
        >
          Redo
        </UiButton>
        <UiButton
          variant="primary"
          size="sm"
          :disabled="changes === 0 || keeping"
          title="Build the changes, review them, then keep"
          data-testid="sound-keep"
          @click="requestKeep()"
        >
          Save
        </UiButton>
        <UiIconButton
          icon="x"
          label="Close"
          size="sm"
          data-testid="sound-close"
          @click="requestClose"
        />
      </div>
    </header>

    <div class="sound-studio__body">
      <nav class="sound-studio__list" aria-label="Sounds" data-testid="sound-list">
        <div class="sound-studio__list-tools">
          <div class="sound-studio__new">
            <UiButton
              variant="secondary"
              size="sm"
              icon="plus"
              :disabled="freeNum === null"
              title="Create a new sound"
              data-testid="sound-new"
              :aria-expanded="newOpen"
              @click="newOpen = !newOpen"
            >
              New
            </UiButton>
            <div v-if="newOpen" class="sound-studio__menu" role="menu" data-testid="sound-new-menu">
              <button
                type="button"
                role="menuitem"
                data-testid="sound-preset-blank"
                @click="createCue(null)"
              >
                Blank
              </button>
              <button
                v-for="preset in presets"
                :key="preset.id"
                type="button"
                role="menuitem"
                :data-testid="`sound-preset-${preset.id}`"
                @click="createCue(preset.id)"
              >
                {{ preset.name }}
              </button>
            </div>
          </div>
          <UiButton
            variant="ghost"
            size="sm"
            icon="upload"
            :disabled="freeNum === null"
            title="Import a .snd file as a new sound"
            data-testid="sound-import"
            @click="pickImport(freeNum)"
          >
            Import
          </UiButton>
        </div>
        <ul class="sound-studio__items">
          <li v-for="entry in entries" :key="entry.key">
            <button
              type="button"
              class="sound-studio__item"
              :class="{ 'sound-studio__item--active': entry.num === activeNum }"
              :data-testid="`sound-item-${entry.num}`"
              @click="selectCue(entry.num)"
            >
              <span class="sound-studio__item-name">
                SOUND {{ entry.num }}
                <template v-if="'openError' in entry"> · unreadable</template>
                <template v-else-if="entry.opaque"> · {{ entry.family }}</template>
              </span>
              <span class="sound-studio__item-meta">
                <template v-if="!('openError' in entry)">
                  {{ entry.events ?? 0 }} events · {{ entry.bytes }} B
                </template>
                <UiChip v-if="!('openError' in entry) && entry.usedBy.length > 0">
                  {{ entry.usedBy.length }} uses
                </UiChip>
                <span
                  v-if="!('openError' in entry) && entry.dirty"
                  class="sound-studio__dot"
                  aria-label="changed"
                ></span>
              </span>
            </button>
          </li>
          <li v-if="entries.length === 0 && !opening" class="sound-studio__empty">
            Create a sound with New or Import.
          </li>
        </ul>
      </nav>

      <main class="sound-studio__main">
        <template v-if="activeEntry !== null">
          <div class="sound-studio__cuebar">
            <span class="sound-studio__cuename" data-testid="sound-cue-name">
              SOUND {{ activeEntry.num }}
            </span>
            <div class="sound-studio__transport" role="group" aria-label="Preview">
              <UiIconButton
                v-if="previewSnapshot?.status !== 'playing'"
                icon="play"
                :label="VOCABULARY_ACTIONS.play_sound.label"
                :title="VOCABULARY_ACTIONS.play_sound.help"
                size="sm"
                :disabled="activeOpaque"
                :aria-describedby="activeOpaque ? 'sound-preview-blocked' : undefined"
                data-testid="sound-play"
                @click="preview.play()"
              />
              <UiIconButton
                v-else
                icon="pause"
                label="Pause preview"
                size="sm"
                data-testid="sound-pause"
                @click="preview.pause()"
              />
              <UiIconButton
                icon="rect"
                label="Stop preview"
                size="sm"
                :disabled="activeOpaque"
                :aria-describedby="activeOpaque ? 'sound-preview-blocked' : undefined"
                data-testid="sound-stop"
                @click="preview.stop()"
              />
              <span
                v-if="activeOpaque"
                id="sound-preview-blocked"
                class="sound-studio__preview-error"
              >
                This sound format has no preview.
              </span>
              <span class="sound-studio__position" data-testid="sound-position">
                <template v-if="activeEntry.extentTicks !== null">
                  {{ previewSnapshot?.positionTicks ?? 0 }} / {{ activeEntry.extentTicks }} ticks ·
                  {{ ticksSeconds(activeEntry.extentTicks).toFixed(2) }} s
                </template>
                <template v-else>{{ previewSnapshot?.positionTicks ?? 0 }} ticks</template>
              </span>
              <span class="sound-studio__preview-label" data-testid="sound-preview-label">
                Preview
              </span>
              <div class="sound-studio__device" role="group" aria-label="Preview device">
                <button
                  type="button"
                  class="sound-studio__device-btn"
                  :class="{ 'sound-studio__device-btn--on': preview.device === 'pc-speaker' }"
                  title="Preview as the one-voice PC speaker"
                  data-testid="sound-device-speaker"
                  @click="setPreviewDevice('pc-speaker')"
                >
                  Speaker
                </button>
                <button
                  type="button"
                  class="sound-studio__device-btn"
                  :class="{ 'sound-studio__device-btn--on': preview.device === 'tandy' }"
                  title="Preview as the three-voice chip"
                  data-testid="sound-device-tandy"
                  @click="setPreviewDevice('tandy')"
                >
                  3-voice
                </button>
              </div>
              <span
                v-if="previewSnapshot?.refusal"
                class="sound-studio__preview-error"
                role="alert"
                data-testid="sound-preview-error"
              >
                {{ previewSnapshot.refusal }}
              </span>
            </div>
            <div class="sound-studio__cueactions">
              <UiButton
                variant="ghost"
                size="sm"
                icon="copy"
                title="Copy onto a free number"
                data-testid="sound-duplicate"
                @click="duplicateCue"
              >
                Duplicate
              </UiButton>
              <UiButton
                variant="ghost"
                size="sm"
                icon="upload"
                title="Replace this sound from a file"
                data-testid="sound-replace-file"
                @click="pickImport(activeNum)"
              >
                Replace…
              </UiButton>
              <UiButton
                variant="ghost"
                size="sm"
                icon="download"
                title="Download sound as a .snd file"
                data-testid="sound-export"
                @click="exportCue"
              >
                Export
              </UiButton>
              <UiButton
                variant="danger"
                size="sm"
                icon="trash"
                title="Remove this sound"
                data-testid="sound-remove-cue"
                @click="removeCue"
              >
                Remove
              </UiButton>
            </div>
          </div>
          <div class="sound-studio__center">
            <SoundTimeline
              ref="timeline"
              :document="activeDocument"
              :selected-id="selectedEventId ?? null"
              :cursor-lane="cursorLane"
              :cursor-index="cursorIndex"
              :position-ticks="
                previewSnapshot?.status === 'playing' ? previewSnapshot.positionTicks : null
              "
              :lane-muted="previewSnapshot?.laneMuted ?? [false, false, false, false]"
              :lane-solo="previewSnapshot?.soloLane ?? null"
              :lane-controls="previewSnapshot?.laneControls ?? null"
              @select="selectEvent"
              @cursor="setCursor"
              @lane-mute="preview.setLaneMuted"
              @lane-solo="preview.setLaneSolo"
            />
            <p v-if="!activeOpaque" class="sound-studio__hint" data-testid="sound-hint">
              Click the timeline to use these keys: arrows move · N adds a note · R adds a rest ·
              Space plays.
            </p>
          </div>
        </template>
        <p v-else-if="opening" class="sound-studio__empty-main">Opening…</p>
        <p v-else class="sound-studio__empty-main" data-testid="sound-empty">
          Select a sound, or create one; a preset seeds the four lanes.
        </p>
      </main>

      <SoundInspector
        :event="selectedEvent"
        :cue="activeEntry"
        :error="editError ?? null"
        :readonly="activeOpaque"
        @set-ticks="setEventTicks"
        @set-note="setEventNote"
        @set-attenuation="setEventAttenuation"
        @set-control="setEventControl"
        @replace-data="replaceEventData"
        @remove-event="removeSelectedEvent"
        @duplicate-event="duplicateSelectedEvent"
        @split-event="splitSelectedEvent"
        @set-tempo="setTempo"
      />
    </div>

    <input
      ref="fileInput"
      type="file"
      accept=".snd,.bin,application/octet-stream"
      hidden
      data-testid="sound-file-input"
      @change="onImportFile"
    />

    <p class="sound-studio__small" data-testid="sound-small-notice">
      Sound Studio needs a wider window to edit. Your draft stays open. Widen the window, or use
      Save and Close above.
    </p>

    <!-- Dirty close / project switch guard -->
    <UiDialog v-model:open="leaveAsk" title="Unsaved changes" data-testid="sound-leave-ask">
      <p>This project has changes that are not kept.</p>
      <div class="sound-studio__dialog-actions">
        <UiButton variant="primary" size="sm" data-testid="sound-leave-keep" @click="keepAndClose">
          Save
        </UiButton>
        <UiButton
          variant="danger"
          size="sm"
          data-testid="sound-leave-discard"
          @click="discardAndClose"
        >
          Discard
        </UiButton>
        <UiButton variant="ghost" size="sm" data-testid="sound-leave-cancel" @click="cancelLeave">
          Cancel
        </UiButton>
      </div>
    </UiDialog>

    <!-- Keep review -->
    <UiDialog
      v-if="review !== undefined"
      open
      title="Review changes"
      data-testid="sound-review"
      @closed="review = undefined"
    >
      <p
        v-if="review.candidate === undefined && reviewError === undefined"
        class="sound-studio__dialog-note"
      >
        Nothing is selected to keep.
      </p>
      <ul
        v-if="review.keys.length > 0"
        class="sound-studio__review-keys"
        data-testid="sound-review-keys"
      >
        <li v-for="key in review.keys" :key="key">
          <label v-if="review.selected.includes(key) || workspace.dirtyKeys().includes(key)">
            <input
              type="checkbox"
              :checked="review.selected.includes(key)"
              :data-testid="`sound-review-key-${key.replace(':', '-')}`"
              @change="toggleKeepRoot(key)"
            />
            {{ key }}
          </label>
          <span v-else>{{ key }} <em>dependency</em></span>
        </li>
      </ul>
      <ul
        v-if="review.candidate !== undefined && review.candidate.diagnostics.length > 0"
        class="sound-studio__review-diagnostics"
        data-testid="sound-review-diagnostics"
      >
        <li
          v-for="(diagnostic, index) in review.candidate.diagnostics"
          :key="index"
          :class="`sound-diagnostic--${diagnostic.severity}`"
        >
          {{ diagnostic.document }}: {{ diagnostic.message }}
        </li>
      </ul>
      <p
        v-if="review.candidate !== undefined && review.candidate.removedResources.length > 0"
        class="sound-studio__dialog-note"
        data-testid="sound-review-removals"
      >
        Save removes {{ review.candidate.removedResources.join(", ") }} from the saved project.
      </p>
      <p
        v-if="reviewError"
        class="sound-studio__alert"
        role="alert"
        data-testid="sound-review-error"
      >
        {{ reviewError }}
      </p>
      <div class="sound-studio__dialog-actions">
        <UiButton
          variant="primary"
          size="sm"
          :disabled="review.candidate === undefined || keeping"
          :title="
            keeping
              ? 'Save is writing to storage'
              : review.candidate === undefined
                ? 'Nothing is selected to keep'
                : 'Save the reviewed changes'
          "
          data-testid="sound-review-keep"
          @click="confirmKeep"
        >
          {{ keeping ? "Saving…" : "Save" }}
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          data-testid="sound-review-cancel"
          @click="review = undefined"
        >
          Cancel
        </UiButton>
      </div>
    </UiDialog>

    <!-- Recovery -->
    <UiDialog
      v-if="recovery.length > 0"
      v-model:open="recoveryOpen"
      title="Unfinished work"
      data-testid="sound-recovery"
    >
      <p>A draft was saved for this project. Restore it or leave it for later.</p>
      <ul class="sound-studio__review-keys" data-testid="sound-recovery-list">
        <li v-for="(entry, index) in recovery" :key="index">
          <span>
            {{ entry.kind === "stored" ? "Saved draft" : "Carried draft" }} ·
            {{ entry.keys.join(", ") }}
            <template v-if="entry.status === 'stale'">(older version)</template>
          </span>
          <UiButton
            size="sm"
            variant="primary"
            :disabled="recoveryBusy || entry.status === 'stale'"
            :title="
              entry.status === 'stale'
                ? 'This draft is from an older save. Choose Download or Discard.'
                : recoveryBusy
                  ? 'A draft operation is running'
                  : 'Restore this draft'
            "
            :data-testid="`sound-recovery-restore-${index}`"
            @click="restoreRecovery(entry)"
          >
            Restore
          </UiButton>
          <UiButton
            v-if="entry.kind === 'stored'"
            size="sm"
            variant="ghost"
            :disabled="recoveryBusy"
            :title="recoveryBusy ? 'A draft operation is running' : 'Delete this draft record'"
            :data-testid="`sound-recovery-discard-${index}`"
            @click="discardRecovery(entry)"
          >
            Discard
          </UiButton>
        </li>
      </ul>
      <p v-if="recoveryError" class="sound-studio__alert" role="alert">{{ recoveryError }}</p>
    </UiDialog>

    <!-- Replace confirm -->
    <UiDialog
      v-if="importConfirm !== null"
      open
      title="Replace sound"
      data-testid="sound-import-confirm"
      @closed="importConfirm = null"
    >
      <p>
        Replace SOUND {{ importConfirm?.num }} with {{ importConfirm?.name }}? The current cue's
        events are replaced by the imported bytes.
      </p>
      <div class="sound-studio__dialog-actions">
        <UiButton variant="primary" size="sm" data-testid="sound-import-ok" @click="confirmImport">
          Replace
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          data-testid="sound-import-cancel"
          @click="importConfirm = null"
        >
          Cancel
        </UiButton>
      </div>
    </UiDialog>
  </section>
</template>

<style scoped>
.sound-studio {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background: var(--surface-0);
}
.sound-studio__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
.sound-studio__title {
  min-width: 0;
}
.sound-studio__title h1 {
  margin: 0;
  font: var(--weight-semibold) var(--text-md) / var(--leading) var(--font-sans);
}
.sound-studio__title p {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.sound-studio__saved {
  margin: 0;
  color: var(--ok);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.sound-studio__alert {
  margin: 0;
  max-width: 40ch;
  color: var(--danger);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.sound-studio__actions {
  margin-left: auto;
  display: flex;
  gap: var(--space-2);
}
.sound-studio__body {
  flex: 1;
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 280px;
  min-height: 0;
}
.sound-studio__list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--hairline-strong);
  background: var(--surface-1);
  min-height: 0;
}
.sound-studio__list-tools {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  border-bottom: 1px solid var(--hairline);
}
.sound-studio__new {
  position: relative;
}
.sound-studio__menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: var(--z-popover);
  min-width: 10em;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  background: var(--surface-0);
  box-shadow: var(--shadow-pop);
}
.sound-studio__menu button {
  padding: var(--space-2) var(--space-3);
  border: 0;
  text-align: left;
  color: var(--ink);
  background: transparent;
  font: var(--text-sm) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.sound-studio__menu button:hover {
  background: var(--action-soft);
}
.sound-studio__items {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
}
.sound-studio__item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 0;
  border-bottom: 1px solid var(--hairline);
  color: var(--ink);
  background: transparent;
  text-align: left;
  font: var(--text-sm) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.sound-studio__item--active {
  background: var(--action-soft);
}
.sound-studio__item:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.sound-studio__item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sound-studio__item-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
  white-space: nowrap;
}
.sound-studio__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--action);
}
.sound-studio__empty,
.sound-studio__empty-main {
  padding: var(--space-4);
  color: var(--ink-3);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.sound-studio__empty-main {
  margin: auto;
}
.sound-studio__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.sound-studio__cuebar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--hairline-strong);
  background: var(--surface-1);
  flex-wrap: wrap;
}
.sound-studio__cuename {
  font: var(--weight-semibold) var(--text-sm) / var(--leading) var(--font-sans);
}
.sound-studio__transport {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sound-studio__position {
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-mono);
}
.sound-studio__preview-label {
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.sound-studio__device {
  display: flex;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.sound-studio__device-btn {
  padding: var(--space-1) var(--space-2);
  border: 0;
  color: var(--ink-3);
  background: transparent;
  font: var(--text-2xs) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.sound-studio__device-btn--on {
  color: var(--surface-0);
  background: var(--action);
}
.sound-studio__preview-error {
  color: var(--warn);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.sound-studio__cueactions {
  margin-left: auto;
  display: flex;
  gap: var(--space-1);
}
.sound-studio__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sound-studio__hint {
  margin: 0;
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.sound-studio__dialog-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
  margin-top: var(--space-3);
}
.sound-studio__dialog-note {
  margin: 0;
  color: var(--ink-2);
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.sound-studio__review-keys {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  font: var(--text-sm) / var(--leading-loose, var(--leading)) var(--font-sans);
}
.sound-studio__review-diagnostics {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.sound-diagnostic--error {
  color: var(--danger);
}
.sound-diagnostic--warning {
  color: var(--warn);
}
.sound-studio__small {
  display: none;
}
@media (max-width: 760px) {
  .sound-studio__body {
    display: none;
  }
  .sound-studio__small {
    display: block;
    margin: auto;
    max-width: 34ch;
    padding: var(--space-4);
    color: var(--ink-2);
    font: var(--text-sm) / var(--leading) var(--font-sans);
    text-align: center;
  }
}
</style>
