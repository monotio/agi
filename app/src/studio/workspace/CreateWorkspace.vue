<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import GuidedAdd from "./GuidedAdd.vue";
import { soundProjectChanges } from "../sound/soundEdits.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import "./workspace.css";
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { compilePictureSource } from "../../../../src/picture/source.ts";
import { openContainer } from "../../../../src/container/container.ts";
import {
  readMusicDocument,
  readBindingsDocument,
} from "../../../../src/authoring/projectDocuments.ts";
import type { ProjectChange, ProjectContent } from "../../../../src/authoring/projectContent.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import type { ProjectHistoryState } from "../../../../src/authoring/projectHistoryData.ts";
import type { ProjectSession } from "../../project/projectSession.ts";
import { layoutDragging } from "../../play/layoutDrag.ts";
import { usePresentation } from "../../play/usePresentation.ts";
import { workspaceStudioContext } from "./studioContext.ts";
import type { PlayHereTarget } from "../../../../src/runtime/playHere.ts";
import type { BindingKind } from "../../../../src/agent/authoringState.ts";
import type { EngineStateReport, ScreenObjectState } from "../../../../src/runtime/engine.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useCreateWorkspace } from "../../shell/useCreateWorkspace.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { openExplainer } from "../../ui/explain.ts";
import { useAiSettings } from "../../settings/useAiSettings.ts";
import type { WordsTask } from "./wordsAgent.ts";
import UiButton from "../../ui/UiButton.vue";
import PartsList from "./PartsList.vue";
import ProjectTabs from "../host/ProjectTabs.vue";
import { workspaceParts, workspaceOpenParts } from "../host/workspaceParts.ts";
import { roomPictureUse } from "../../../../src/agent/roomPictures.ts";
import { useNodeThumbs } from "../../world/nodeThumbs.ts";
import { parseWordsTok } from "../../../../src/logic/words.ts";
import { readInventoryObjects } from "../../../../src/authoring/inventory.ts";
import { derivedLogicSource } from "../logic/logicWorkspace.ts";
import { roomPictureNumber } from "../logic/guided/guidedPreview.ts";
import { createWorkspacePending } from "./workspacePending.ts";
import type { WorkspaceAction } from "./workspaceGuided.ts";
import { useWorkspaceDebug, type LogicEditorHandle } from "./useWorkspaceDebug.ts";
const props = defineProps<{ creating: boolean }>();
const NotesEditor = defineAsyncComponent(() => import("./NotesEditor.vue"));
const ImageReferencePanel = defineAsyncComponent(
  () => import("../creative/ImageReferencePanel.vue"),
);
const imagePanel = ref<string>();
const imageGenerate = ref(false);
const traceUnderlays = shallowRef<
  Record<string, { pixels: Uint8Array; opacity: number; behindArt: boolean } | null>
>({});
let imageRefresh = 0;
const SoundPanel = defineAsyncComponent(() => import("./SoundPanel.vue"));
const SoundImport = defineAsyncComponent(() => import("../sound/SoundImport.vue"));
const WordsEditor = defineAsyncComponent(() => import("./WordsEditor.vue"));
const TableEditor = defineAsyncComponent(() => import("./TableEditor.vue"));
const RoomStudio = defineAsyncComponent(() => import("../RoomStudio.vue"));
const PausedPicture = defineAsyncComponent(() => import("./PausedPicture.vue"));
const SpriteStudio = defineAsyncComponent(() => import("../sprite/SpriteStudio.vue"));
const LogicEditor = defineAsyncComponent(() => import("./LogicEditor.vue"));
const DebugPanel = defineAsyncComponent(() => import("./WorkspaceDebugPanel.vue"));
const DebugControls = defineAsyncComponent(() => import("./WorkspaceDebugControls.vue"));
const engine = useEngineApi();
const workspace = useCreateWorkspace();
const editor = useWorkspaceEditor();
const presentation = usePresentation();
const InspectPanel = defineAsyncComponent(() => import("../../inspector/InspectPanel.vue"));
const phoneQuery = window.matchMedia("(max-width: 600px)");
const phoneWidth = ref(phoneQuery.matches);
function phoneLayout(event: MediaQueryListEvent): void {
  phoneWidth.value = event.matches;
}
phoneQuery.addEventListener("change", phoneLayout);
const stacked = computed(() => phoneWidth.value || editor.splitAxis.value === "vertical");
const roomHint = shallowRef<{ key: string; room: number }>();
function openPart(key: string, pinned = false, room?: number): void {
  roomHint.value = room === undefined ? undefined : { key, room };
  if (window.innerWidth <= 1280 && engine.state.powerUp.open) engine.closePowerUp();
  editor.open(key, pinned);
  if (window.innerWidth <= 600) {
    editor.partsOpen.value = false;
  }
}
function openAgent(): void {
  engine.state.powerUp.mode = "remix";
  engine.state.powerUp.open = true;
}
const snapshot = shallowRef<ProjectSnapshot>();
const languageSnapshot = shallowRef<ProjectSnapshot>();
let languageInputs: readonly (ProjectContent | undefined)[] = [];
const languageBase = computed(() =>
  ["words", "inventory", "bindings"].map((key) => snapshot.value?.read(key)?.content),
);
const {
  debug,
  logicEditors,
  reveal: revealDebug,
  toggleBreakpoint,
} = useWorkspaceDebug({
  creating: () => props.creating,
  engine,
  editor,
  snapshot,
  profile: () => profile.value.id,
});
const historyState = shallowRef<ProjectHistoryState>();
const optimistic = shallowRef<Record<string, ProjectContent>>({});
let offDrafts: (() => void) | undefined;
let draftKeys = "";
let draftError = "";
const draftMembership = shallowRef<readonly string[]>([]);
const groupMetadata = shallowRef<{
  world: ProjectContent | undefined;
  bindings: ProjectContent | undefined;
}>({ world: undefined, bindings: undefined });
const editorEpoch = ref(0);
let session: ProjectSession | null = null;
let unsubscribe: (() => void) | undefined;
let retired = false;
const writeConflict = ref(false);
const musicDrop = shallowRef<File>();
const musicDropTarget = ref<string>();
function musicDrag(event: DragEvent): void {
  if (
    props.creating &&
    (event.target as HTMLElement).closest?.(".play-area") &&
    event.dataTransfer?.types.includes("Files")
  )
    event.preventDefault();
}
function dropMusic(event: DragEvent): void {
  if (!props.creating || !(event.target as HTMLElement).closest?.(".play-area")) return;
  const file = event.dataTransfer?.files[0];
  if (!file || !/\.(mid|midi|vgm)$/i.test(file.name)) return;
  event.preventDefault();
  event.stopPropagation();
  musicDropTarget.value = editor.selected.value?.startsWith("sound:")
    ? editor.selected.value
    : undefined;
  musicDrop.value = file;
}
function addImportedSound(bytes: Uint8Array, tempo: number): void {
  const used = new Set([...(snapshot.value?.keys ?? []), ...Object.keys(optimistic.value)]);
  let number = 1;
  while (used.has(`sound:${number}`) && number < 256) number++;
  if (number > 255) {
    editor.error.value = "SOUND resources are full. Replace an existing SOUND.";
    return;
  }
  const key = `sound:${number}`;
  editSound(key, bytes, tempo);
  openPart(key);
  musicDrop.value = undefined;
}
window.addEventListener("dragover", musicDrag, true);
window.addEventListener("drop", dropMusic, true);
function refresh(): void {
  if (!session) return;
  const capture = session.capture();
  snapshot.value = capture.snapshot;
  const ticket = ++imageRefresh;
  if (session.workingSnapshot().keys.includes("images")) {
    void import("../../../../src/creative/imageOperations.ts").then(({ imageTraceUnderlay }) => {
      if (ticket !== imageRefresh || retired) return;
      const documents = session!.workingSnapshot().documents();
      void import("../creative/tracePresentation.ts").then(({ presentTrace }) => {
        if (ticket !== imageRefresh || retired) return;
        traceUnderlays.value = Object.fromEntries(
          capture.snapshot.keys
            .filter((key) => key.startsWith("picture:"))
            .map((key) => [key, presentTrace(session!, key, imageTraceUnderlay(documents, key))]),
        );
      });
    });
  } else traceUnderlays.value = {};
  const draftStatus = session.drafts().status();
  writeConflict.value =
    capture.save.state === "conflict" || draftStatus.error.includes("another tab");
  editor.readOnly.value = writeConflict.value;
  editor.pendingChanges.value =
    session.pendingChanges || editor.busy.value || draftStatus.pending || !!draftStatus.error;
  if (writeConflict.value) editor.error.value = "";
  historyState.value = capture.history;
  editor.pendingAdmission.value = capture.pendingAdmission;
  editor.save.value =
    capture.save.state === "saved"
      ? draftStatus.error
        ? "Could not save. Retry"
        : draftStatus.pending || draftStatus.busy
          ? "Draft saving…"
          : editor.changeCount.value
            ? "Draft saved"
            : "Saved"
      : capture.save.state === "pending" || capture.save.state === "saving"
        ? "Saving…"
        : capture.save.message;
  editor.canUndo.value = !!capture.history.commits.find(
    (commit) => commit.id === capture.history.cursor,
  )?.parent;
  editor.canRedo.value = capture.history.future.length > 0;
}
function attach(): void {
  const next = engine.getProjectSession();
  if (next !== session) {
    unsubscribe?.();
    session = next;
    offDrafts?.();
    optimistic.value = {};
    groupMetadata.value = { world: undefined, bindings: undefined };
    draftKeys = "";
    if (session) {
      unsubscribe = session.subscribe(refresh);
      const drafts = session.drafts();
      offDrafts = session.subscribeDrafts(draftChanged);
      void drafts.ready
        .then(() => {
          draftChanged(true);
        })
        .catch((cause: unknown) => {
          editor.error.value = cause instanceof Error ? cause.message : String(cause);
          editor.readOnly.value = writeConflict.value = true;
        });
    }
  }
  refresh();
}
watch(() => [engine.state.phase, engine.state.patchTick, engine.state.status], attach, {
  immediate: true,
});
function content(key: string): ProjectContent | undefined {
  return optimistic.value[key] ?? snapshot.value?.read(key)?.content;
}
const container = computed(() => {
  const build = snapshot.value?.lastAdmissibleBuild;
  return (
    build &&
    openContainer(new Map(build.files()), { profile: engine.roomMap.resources.value.profile! })
  );
});
const groups = computed(() => {
  const keys = [...new Set([...(snapshot.value?.keys ?? []), ...draftMembership.value])];
  const scan = engine.roomMap.resources.value;
  const admitted = snapshot.value?.lastAdmissibleBuild?.documents() ?? {};
  let plan: Record<string, { title?: string }> = {};
  try {
    const world = groupMetadata.value.world ?? snapshot.value?.read("world")?.content;
    if (typeof world === "string") plan = (JSON.parse(world) as { rooms: typeof plan }).rooms;
  } catch {
    /* Native room relationships remain available. */
  }
  const roomIds = new Set([
    ...engine.roomMap.graph.value.nodes.map((node) => node.room),
    ...[...scan.scans]
      .filter(([room, logic]) => !scan.shared.has(room) && logic.roomEvidence)
      .map(([room]) => room),
    ...[...scan.scans.values()].flatMap((logic) => logic.targets.map((target) => target.to)),
    ...Object.keys(plan).map(Number),
  ]);
  const rooms = [...roomIds]
    .filter((room) => room > 0 && room <= 255)
    .map((room) => {
      const node = engine.roomMap.graph.value.nodes.find((node) => node.room === room);
      const pictures = roomPictureUse(room, {
        scans: scan.scans,
        shared: scan.shared,
        pictures: scan.picture,
      })
        .pictures.filter((use) => use.exists)
        .map((use) => use.picture);
      const logic = admitted[`logic:${room}`];
      const bound = snapshot.value?.read("bindings")?.content;
      if (pictures.length === 0 && typeof logic === "string") {
        const picture = roomPictureNumber(logic, typeof bound === "string" ? bound : undefined);
        if (picture !== null) pictures.push(picture);
      }
      const art =
        pictures[0] === undefined
          ? undefined
          : snapshot.value?.read(`picture:${pictures[0]}`)?.content;
      const heading = typeof art === "string" ? /^# ([^:\n]+):/.exec(art)?.[1] : undefined;
      const title = plan[String(room)]?.title || heading || node?.title;
      return { room, ...(title ? { title } : {}), pictures };
    });
  const names: Record<string, string> = {};
  const bound = groupMetadata.value.bindings ?? snapshot.value?.read("bindings")?.content;
  if (typeof bound === "string") {
    try {
      for (const [name, binding] of Object.entries(readBindingsDocument(bound)))
        names[`${binding.kind}:${binding.num}`] =
          name === "ego_view"
            ? "Hero"
            : name === "boot_logic"
              ? "Start-up and menus"
              : name === "death_logic"
                ? "Game over"
                : name.replaceAll("_", " ");
    } catch {
      /* Resource ids remain reachable. */
    }
  }
  return workspaceParts({ keys, rooms, names, currentRoom: engine.roomMap.currentRoom.value });
});
const roomThumbs = useNodeThumbs(engine.roomMap, () => engine.roomMap.graph.value.nodes);
const thumbnails = computed<Readonly<Record<string, string>>>(() => {
  void engine.roomMap.thumbVersion.value;
  const result: Record<string, string> = {};
  for (const row of groups.value.flatMap((group) => group.entries)) {
    if (row.child || row.room === undefined) continue;
    const thumb = roomThumbs.value.get(row.room);
    if (thumb) result[row.id] = thumb;
  }
  return result;
});
watch(
  groups,
  (next) => {
    editor.parts.value = workspaceOpenParts(next).map((row) => ({
      id: row.key,
      title: row.label,
      run: () => openPart(row.key),
    }));
  },
  { immediate: true },
);
const tabRows = computed(() =>
  editor.tabs.value.map((key) => ({
    key,
    label:
      key === "words"
        ? "WORDS"
        : key === "inventory"
          ? "OBJECTS"
          : key === "notes"
            ? "Notes"
            : key.replace(":", " ").toUpperCase(),
    dirty: draftMembership.value.includes(key),
    preview: key === editor.preview.value,
    missing:
      !snapshot.value?.keys.includes(key) &&
      (key !== "notes" || (optimistic.value[key]?.length ?? 0) > 0),
  })),
);
const profile = computed(() => engine.roomMap.resources.value.profile!);
const revision = computed(() => snapshot.value?.lastAdmissibleBuild?.identity.revision);
const files = computed(
  () => snapshot.value?.lastAdmissibleBuild?.files() ?? new Map<string, Uint8Array>(),
);
const livePreview = shallowRef<{
  state: EngineStateReport | null;
  objects: readonly ScreenObjectState[];
}>({ state: null, objects: [] });
let previewRead = 0;
watch(
  [editor.selected, revision, engine.roomMap.currentRoom],
  async () => {
    const ticket = ++previewRead;
    const [state, objects] = await Promise.all([
      engine.readEngineState().catch(() => null),
      engine.readObjects().catch(() => []),
    ]);
    if (ticket === previewRead && !retired) livePreview.value = { state, objects };
  },
  { immediate: true },
);
let studioContextKey = "";
let admittedStudioContext: ReturnType<typeof workspaceStudioContext>;
const studioContext = computed(() => {
  const documents = snapshot.value?.lastAdmissibleBuild?.documents() ?? {};
  const rooms = engine.roomMap.graph.value.nodes.map((node) => ({
    room: node.room,
    title: node.title ?? "",
  }));
  const key = JSON.stringify([revision.value, documents["bindings"], documents["world"], rooms]);
  if (key === studioContextKey && admittedStudioContext) return admittedStudioContext;
  studioContextKey = key;
  return (admittedStudioContext = workspaceStudioContext(
    files.value,
    snapshot.value?.lastAdmissibleBuild?.documents() ?? {},
    profile.value,
    engine.roomMap.graph.value.nodes.map((node) => ({ room: node.room, title: node.title ?? "" })),
  ));
});
const pictureWalks = computed(() =>
  Object.fromEntries(
    editor.retained.value
      .filter((key) => key.startsWith("picture:"))
      .map((key) => {
        const request = editor.studioRequests.value[key];
        const uses = groups.value
          .flatMap((group) => group.entries)
          .filter((row) => row.key === key && row.room !== undefined);
        const room =
          roomHint.value?.key === key
            ? roomHint.value.room
            : request?.kind === "picture"
              ? request.room
              : (uses.find((row) => row.room === engine.roomMap.currentRoom.value)?.room ??
                uses[0]?.room);
        return [key, room === undefined || room < 1 ? null : studioContext.value.room(room)];
      }),
  ),
);
const spriteContexts = computed(() =>
  Object.fromEntries(
    editor.retained.value
      .filter((key) => key.startsWith("view:"))
      .map((key) => [
        key,
        studioContext.value.sprite(
          Number(key.slice(5)),
          engine.roomMap.currentRoom.value ?? undefined,
        ),
      ]),
  ),
);
const selectedRoom = computed(() => {
  const key = editor.selected.value;
  if (!key) return undefined;
  const uses = key.startsWith("view:")
    ? (spriteContexts.value[key]?.usage.rooms ?? [])
    : groups.value
        .flatMap((group) => group.entries)
        .filter((row) => row.key === key && row.room !== undefined)
        .map((row) => row.room!);
  if (roomHint.value?.key === key && uses.includes(roomHint.value.room)) return roomHint.value.room;
  const current = engine.roomMap.currentRoom.value;
  if (
    key.startsWith("view:") &&
    current !== null &&
    (spriteContexts.value[key]?.usage.logics.includes(0) ||
      (livePreview.value.state?.vars[0] === current &&
        livePreview.value.objects.some((object) => object.view === Number(key.slice(5)))))
  )
    return current;
  return uses.find((room) => room === current) ?? uses[0];
});
const unusedArt = computed(
  () =>
    (editor.kind.value === "picture" || editor.kind.value === "view") &&
    selectedRoom.value === undefined,
);
let makingRoom = false;
const madeRoomArt: Record<string, string> = {};
const returnRoom = ref<number>();
const visitingRoom = ref<number>();
const stageNote = ref("");
const visitBusy = ref(false);
const pausedPicture = computed(() => {
  const row = groups.value
    .flatMap((group) => group.entries)
    .find((entry) => entry.room === visitingRoom.value && entry.key.startsWith("picture:"));
  return row ? native(row.key) : undefined;
});
let visitQueue = Promise.resolve();
let selectionSerial = 0;
watch([editor.selected, roomHint, () => props.creating], ([, , creating], [, , wasCreating]) => {
  const serial = ++selectionSerial;
  if (!creating || makingRoom) return;
  if (
    !wasCreating &&
    selectedRoom.value !== undefined &&
    selectedRoom.value !== engine.roomMap.currentRoom.value
  ) {
    stageNote.value = "";
    const room = engine.roomMap.currentRoom.value;
    const part = groups.value
      .flatMap((group) => group.entries)
      .find(
        (row) =>
          row.room === room &&
          row.key.startsWith(editor.kind.value === "logic" ? "logic:" : "picture:"),
      );
    if (part) openPart(part.key);
    else editor.selected.value = undefined;
    if (returnRoom.value !== undefined) visitingRoom.value = room ?? undefined;
    return;
  }
  visitQueue = visitQueue.then(async () => {
    if (serial !== selectionSerial || retired) return;
    const room = selectedRoom.value;
    stageNote.value = "";
    if (room === undefined || room === engine.roomMap.currentRoom.value) return;
    if (!snapshot.value?.keys.includes(`logic:${room}`)) {
      stageNote.value = "Update game to open this room.";
      return;
    }
    visitBusy.value = true;
    try {
      await flushWorkspace();
      if (serial !== selectionSerial || retired) return;
      const result = await engine.visitRoom(room);
      returnRoom.value = result.returnRoom;
      visitingRoom.value = room;
      if (!result.ok)
        stageNote.value = `Room ${room} needs more game state. The picture is paused for editing.`;
    } catch {
      stageNote.value = `Room ${room} could not open. The picture is paused for editing.`;
    } finally {
      visitBusy.value = false;
    }
  });
});
watch(engine.roomMap.currentRoom, (room) => {
  if (
    !props.creating ||
    visitBusy.value ||
    makingRoom ||
    stageNote.value ||
    room === null ||
    selectedRoom.value === undefined ||
    selectedRoom.value === room
  )
    return;
  const part = groups.value
    .flatMap((group) => group.entries)
    .find(
      (row) =>
        row.room === room &&
        row.key.startsWith(editor.kind.value === "logic" ? "logic:" : "picture:"),
    );
  if (part) openPart(part.key, false, room);
  else editor.selected.value = undefined;
  if (returnRoom.value !== undefined) visitingRoom.value = room;
});
watch(
  [editor.selected, unusedArt, () => props.creating, stageNote],
  () => {
    editor.pictureLive.value = editor.kind.value === "picture";
    editor.stageSolo.value = unusedArt.value;
    editor.stagePaused.value = unusedArt.value || !!stageNote.value;
    if (props.creating && editor.stagePaused.value) engine.pauseEngine("stageArt");
    else engine.resumeEngine("stageArt");
  },
  { immediate: true },
);
let returningRemovedRoom = false;
watch(snapshot, async (current) => {
  const room = engine.roomMap.currentRoom.value;
  if (
    !props.creating ||
    returningRemovedRoom ||
    returnRoom.value === undefined ||
    room === null ||
    !current ||
    current.keys.includes(`logic:${room}`)
  )
    return;
  returningRemovedRoom = true;
  const selected = editor.selected.value;
  const art = selected && madeRoomArt[selected];
  if (selected && art && !current.keys.includes(selected) && current.keys.includes(art))
    openPart(art);
  try {
    await backToGame(false);
  } finally {
    returningRemovedRoom = false;
  }
});
async function backToGame(openRoom = true): Promise<void> {
  ++selectionSerial;
  await visitQueue;
  visitBusy.value = true;
  try {
    await flushWorkspace();
    const result = await engine.visitRoom("back");
    if (!result.ok) throw new Error(result.reason);
    returnRoom.value = visitingRoom.value = undefined;
    stageNote.value = "";
    if (openRoom) {
      const picture = groups.value
        .flatMap((group) => group.entries)
        .find((row) => row.room === result.room && row.key.startsWith("picture:"));
      if (picture) openPart(picture.key);
      else editor.selected.value = undefined;
    }
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    visitBusy.value = false;
  }
}
const previewCyclers = computed(() =>
  livePreview.value.objects.map(({ num, view, loop, cycling, cycleTime }) => ({
    num,
    view,
    loop,
    cycling,
    cycleTime,
  })),
);
async function playHere(target: PlayHereTarget): Promise<void> {
  try {
    await flushWorkspace();
    const result = await engine.playHere(target);
    if (!result.ok) throw new Error(result.reason);
    editor.focus.value = false;
    document.querySelector<HTMLInputElement>('[data-testid="input-line"]')?.focus();
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
function spriteRequest(key: string) {
  const request = editor.studioRequests.value[key];
  return request?.kind === "sprite" ? request : undefined;
}
const coordinatedChanges = new Map<string, readonly ProjectChange[]>();
function editRoom(
  pictureKey: string,
  room: number,
  source: string,
  bindings: Readonly<Record<string, { kind: BindingKind; num: number }>>,
  pictureSource: string | undefined,
): void {
  const key = pictureSource === undefined ? `logic:${room}` : pictureKey;
  const value = pictureSource ?? source;
  const changes: ProjectChange[] = [{ key: `logic:${room}`, content: source }];
  if (pictureSource !== undefined) changes.push({ key, content: pictureSource });
  if (Object.keys(bindings).length) {
    const current = text("bindings");
    changes.push({
      key: "bindings",
      content: JSON.stringify({ ...(current ? readBindingsDocument(current) : {}), ...bindings }),
    });
  }
  coordinatedChanges.set(`${key}\0${value}`, changes);
  edit(key, value);
}
function editView(key: string, bytes: Uint8Array): void {
  const request = spriteRequest(key);
  if (request?.stagedReference && request.baseRevision !== revision.value) {
    editor.error.value = "The game changed since this sheet was staged. Attach the sheet again.";
    return;
  }
  edit(key, bytes);
  if (request?.stagedReference)
    editor.studioRequests.value = {
      ...editor.studioRequests.value,
      [key]: { ...request, stagedReference: undefined },
    };
}
const nativeCache = new Map<string, Uint8Array>();
const viewThumbnails = computed(() =>
  Object.fromEntries(
    (snapshot.value?.keys ?? [])
      .filter((key) => key.startsWith("view:"))
      .map((key) => [key, native(key)!]),
  ),
);
const guidedSounds = computed(() =>
  (groups.value.find((group) => group.label === "SOUNDS")?.entries ?? []).map((row) => ({
    sound: Number(row.key.split(":")[1]),
    name: row.label,
    bytes: soundBytes(row.key),
  })),
);
const gameHosts = new Map<string, HTMLElement>();
function gameHost(key: string, host: HTMLElement): void {
  gameHosts.set(key, host);
  if (editor.selected.value === key) editor.gameHost.value = host;
}
watch(editor.selected, (key) => {
  editor.gameHost.value = key ? (gameHosts.get(key) ?? null) : null;
});
const pendingNative: Record<string, { content: ProjectContent; bytes: Uint8Array }> = {};
function native(key: string): Uint8Array | undefined {
  const [kind, num] = key.split(":");
  if (kind !== "picture" && kind !== "view" && kind !== "sound") return undefined;
  const pending = optimistic.value[key];
  if (pending instanceof Uint8Array) return pending;
  if (typeof pending === "string" && kind === "picture") {
    const cached = pendingNative[key];
    if (cached?.content === pending) return cached.bytes;
    try {
      const bytes = compilePictureSource(pending, { profile: profile.value }).bytes;
      pendingNative[key] = { content: pending, bytes };
      return bytes;
    } catch {
      /* The editor keeps the last rendered picture beside invalid source. */
    }
  }
  const bytes = container.value?.getResource(kind, Number(num)) ?? undefined;
  const prior = nativeCache.get(key);
  if (
    bytes &&
    prior &&
    bytes.length === prior.length &&
    bytes.every((byte, index) => byte === prior[index])
  )
    return prior;
  if (bytes) nativeCache.set(key, bytes);
  return bytes;
}
const soundTempos = new WeakMap<Uint8Array, number>();
function editorChanges(
  key: string,
  value: ProjectContent,
  music = content("music"),
): readonly ProjectChange[] {
  if (typeof value === "string") {
    const coordinated = coordinatedChanges.get(`${key}\0${value}`);
    if (coordinated) return coordinated;
  }
  const tempo = value instanceof Uint8Array ? soundTempos.get(value) : undefined;
  if (key.startsWith("sound:") && value instanceof Uint8Array && tempo !== undefined) {
    return soundProjectChanges(key, value, tempo, typeof music === "string" ? music : undefined);
  }
  return [{ key, content: value }];
}
const actionBusy = ref(false);
const writerBusy = ref(false);
function changedPartKeys(changes: readonly ProjectChange[], fallback = true): string[] {
  const parts = new Set<string>();
  for (const change of changes) {
    if (
      /^(logic|picture|view|sound):/.test(change.key) ||
      ["words", "inventory", "notes"].includes(change.key)
    )
      parts.add(change.key);
    else if (change.key === "images" && typeof change.content === "string") {
      const before = JSON.parse(
        String(snapshot.value?.read("images")?.content ?? '{"traces":{}}'),
      ) as { traces?: Record<string, unknown> };
      const after = JSON.parse(change.content) as { traces?: Record<string, unknown> };
      for (const key of new Set([
        ...Object.keys(before.traces ?? {}),
        ...Object.keys(after.traces ?? {}),
      ]))
        if (JSON.stringify(before.traces?.[key]) !== JSON.stringify(after.traces?.[key]))
          parts.add(key);
    } else if (change.key === "bindings" && typeof change.content === "string") {
      const before = readBindingsDocument(
        String(snapshot.value?.read("bindings")?.content ?? "{}"),
      );
      const after = readBindingsDocument(change.content);
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[name]) === JSON.stringify(after[name])) continue;
        const binding = after[name] ?? before[name];
        if (binding && ["logic", "picture", "view", "sound"].includes(binding.kind))
          parts.add(`${binding.kind}:${binding.num}`);
      }
    } else if (change.key === "world" && typeof change.content === "string") {
      const before = JSON.parse(
        String(snapshot.value?.read("world")?.content ?? '{"rooms":{}}'),
      ) as { rooms?: Record<string, unknown> };
      const after = JSON.parse(change.content) as { rooms?: Record<string, unknown> };
      for (const room of new Set([
        ...Object.keys(before.rooms ?? {}),
        ...Object.keys(after.rooms ?? {}),
      ]))
        if (JSON.stringify(before.rooms?.[room]) !== JSON.stringify(after.rooms?.[room]))
          parts.add(`logic:${room}`);
    }
  }
  if (fallback && !parts.size && changes.length) parts.add(changes[0]!.key);
  return [...parts];
}
const pendingParts = createWorkspacePending((change) => changedPartKeys([change], false));
watch(
  [actionBusy, writerBusy],
  ([action, writer]) => {
    editor.busy.value = action || writer;
  },
  { flush: "sync" },
);
function draftChanged(force = false): void {
  if (!session || retired) return;
  const drafts = session.drafts();
  const changes = pendingParts.changes(snapshot.value, drafts.changes());
  const next: Record<string, ProjectContent> = {};
  for (const { key, content: value } of changes) if (value !== null) next[key] = value;
  const metadata = { world: next["world"], bindings: next["bindings"] };
  if (
    metadata.world !== groupMetadata.value.world ||
    metadata.bindings !== groupMetadata.value.bindings
  )
    groupMetadata.value = metadata;
  const keys = Object.keys(next).sort().join("\0");
  const parts = pendingParts.parts(snapshot.value, changes);
  if (parts.slice().sort().join("\0") !== draftMembership.value.slice().sort().join("\0"))
    draftMembership.value = parts;
  if (force || keys !== draftKeys) {
    optimistic.value = next;
    draftKeys = keys;
  } else Object.assign(optimistic.value, next);
  const state = drafts.status();
  if (!state.error && editor.error.value === draftError) editor.error.value = "";
  draftError = state.error;
  writerBusy.value = state.busy;
  editor.changeCount.value = parts.length;
  const context = ["words", "inventory", "bindings"].map(
    (key, index) => next[key] ?? languageBase.value[index],
  );
  if (
    languageSnapshot.value?.revision !== snapshot.value?.revision ||
    context.some((value, index) => value !== languageInputs[index])
  ) {
    languageInputs = context;
    languageSnapshot.value = session.workingSnapshot();
  }
  editor.pendingChanges.value =
    state.pending || state.busy || !!state.error || (session.pendingChanges ?? false);
  const gameSave = session.saveStatus();
  editor.save.value =
    gameSave.state !== "saved"
      ? gameSave.state === "pending" || gameSave.state === "saving"
        ? "Saving…"
        : gameSave.message
      : state.error
        ? "Could not save. Retry"
        : state.pending || state.busy
          ? "Draft saving…"
          : parts.length
            ? "Draft saved"
            : "Saved";
  if (state.error) {
    editor.error.value = state.error;
    if (state.error.includes("another tab")) {
      editor.readOnly.value = writeConflict.value = true;
    }
  }
}
const writes = {
  flush: async () => {
    await session?.drafts().flush();
    await session?.flush();
    draftChanged();
  },
  retry: async () => {
    await session?.drafts().flush();
    draftChanged();
  },
  dispose: () => {},
};
const updateProblems = shallowRef<ReturnType<ProjectSession["capture"]>["diagnostics"]>([]);
const typingProblems: Record<string, readonly { message: string; line: number }[]> = {};
function reportProblems(key: string, entries: readonly { message: string; line: number }[]): void {
  typingProblems[key] = entries;
  editor.problemCount.value = Object.values(typingProblems).reduce(
    (count, rows) => count + rows.length,
    0,
  );
}
async function updateGame(restartRoom = false): Promise<void> {
  if (!session || actionBusy.value || writeConflict.value) return;
  if (editor.problemCount.value && !restartRoom) {
    const first = updateProblems.value.find((entry) => entry.severity === "error");
    const typed = Object.entries(typingProblems).find(([, entries]) => entries.length);
    if (typed) openWordLogic(Number(typed[0].slice(6)), typed[1][0]!.line);
    else if (first) openPart(first.document, true);
    editor.panel.value = true;
    editor.error.value =
      typed || first
        ? `${(typed?.[1][0]?.message ?? first!.message).replace(/[.]+$/, "")}. Fix this part, then Update game.`
        : editor.error.value;
    return;
  }
  actionBusy.value = true;
  try {
    await writes.flush();
    const changes = pendingParts.changes(snapshot.value, session.drafts().changes());
    if (!changes.length && !restartRoom) return;
    const updatedParts = pendingParts.parts(snapshot.value, changes).length;
    const result = await session.update(changes, restartRoom);
    updateProblems.value = result.diagnostics;
    if (!["committed", "unchanged", "draft"].includes(result.status)) {
      editor.problemCount.value = Math.max(
        1,
        result.diagnostics.filter((entry) => entry.severity === "error").length,
      );
      const first = result.diagnostics.find((entry) => entry.severity === "error");
      editor.error.value = first
        ? `${first.message.replace(/[.]+$/, "")}. Fix this part, then Update game.`
        : "reason" in result && typeof result.reason === "string"
          ? `${result.reason.replace(/[.]+$/, "")}. Choose Update and restart this room.`
          : "The game needs a fresh room. Choose Update and restart this room.";
      return;
    }
    await session.flush();
    await session.drafts().clear();
    optimistic.value = {};
    draftKeys = "";
    editor.updatedParts.value = updatedParts;
    editor.problemCount.value = 0;
    editor.error.value = "";
    if (stageNote.value === "Update game to open this room.")
      stageNote.value = "Choose this room in Parts to play it.";
    refresh();
    draftChanged(true);
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    actionBusy.value = false;
  }
}
async function discardChanges(): Promise<void> {
  if (!session) return;
  actionBusy.value = true;
  try {
    await session.drafts().clear();
    optimistic.value = {};
    draftKeys = "";
    coordinatedChanges.clear();
    editorEpoch.value++;
    updateProblems.value = [];
    for (const key of Object.keys(typingProblems)) delete typingProblems[key];
    editor.problemCount.value = 0;
    editor.error.value = "";
    draftChanged(true);
  } finally {
    actionBusy.value = false;
  }
}
watch(snapshot, () => draftChanged());
editor.update.value = updateGame;
editor.discardDrafts.value = discardChanges;
async function flushWorkspace(): Promise<void> {
  if (session?.saveStatus().state === "conflict") return;
  try {
    await writes.flush();
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
    editor.save.value = "Could not save. Retry";
    throw cause;
  }
}
editor.flush.value = flushWorkspace;
editor.discard.value = async () => {
  await discardChanges();
  writes.dispose();
  session?.discard();
};
editor.retry.value = async () => {
  if (session?.saveStatus().state === "conflict") return;
  try {
    await writes.retry();
    editor.error.value = "";
    refresh();
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
    editor.save.value = "Could not save. Retry";
    throw cause;
  }
};
async function retrySave(): Promise<void> {
  try {
    await editor.retry.value?.();
  } catch {
    /* The save notice keeps the cause and Retry. */
  }
}
function edit(key: string, value: ProjectContent): void {
  if (writeConflict.value) return;
  const before = content(key);
  if (typeof before === "string" && before === value) return;
  if (
    before instanceof Uint8Array &&
    value instanceof Uint8Array &&
    before.length === value.length &&
    before.every((byte, index) => value[index] === byte)
  )
    return;
  editor.error.value = "";
  editor.pin(key);
  const changes = editorChanges(key, value);
  session?.drafts().stage(changes);
  for (const change of changes)
    if (change.content !== null) optimistic.value[change.key] = change.content;
  delete typingProblems[key];
  editor.problemCount.value = Object.values(typingProblems).reduce(
    (count, rows) => count + rows.length,
    0,
  );
  editor.updatedParts.value = 0;
  draftChanged(!key.startsWith("logic:") && key !== "notes");
}
function editSound(key: string, bytes: Uint8Array, tempo: number): void {
  if (writeConflict.value) return;
  soundTempos.set(bytes, tempo);
  if (soundTempo(key) === tempo) edit(key, bytes);
  else {
    editor.error.value = "";
    session?.drafts().stage(editorChanges(key, bytes));
    draftChanged(true);
  }
}
function soundTempo(key: string): number {
  const draft = optimistic.value[key];
  const pending = draft instanceof Uint8Array ? soundTempos.get(draft) : undefined;
  if (pending !== undefined) return pending;
  const music = content("music");
  if (typeof music !== "string") return 120;
  try {
    return readMusicDocument(music)[key.split(":")[1]!]?.tempo ?? 120;
  } catch {
    return 120;
  }
}
function soundBytes(key: string): Uint8Array {
  const value = content(key);
  return value instanceof Uint8Array ? value : native(key)!;
}
function text(key: string): string | undefined {
  const version = snapshot.value?.version(key) ?? 0;
  const cached = derivedText.get(key);
  if (
    optimistic.value[key] === undefined &&
    cached?.version === version &&
    cached.wordsVersion === snapshot.value?.version("words")
  )
    return cached.text;
  const value = content(key);
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) return undefined;
  if (key === "words")
    return JSON.stringify(parseWordsTok(value).map(({ word, id }) => [word, id]));
  if (key === "inventory") return JSON.stringify(readInventoryObjects(value, profile.value));
  if (key.startsWith("logic:")) {
    const source = text("words");
    const words = source ? (JSON.parse(source) as [string, number][]) : [];
    const cached = derivedText.get(key);
    if (cached?.value === value && cached.words === source) return cached.text;
    const derived = derivedLogicSource(value, profile.value.id, words).source;
    derivedText.set(key, {
      value,
      version,
      wordsVersion: snapshot.value?.version("words") ?? 0,
      words: source,
      text: derived,
    });
    return derived;
  }
  return undefined;
}
function workingSnapshot(): ProjectSnapshot | undefined {
  if (session) return session.workingSnapshot();
  const base = snapshot.value;
  if (!base) return undefined;
  const documents = { ...base.documents(), ...optimistic.value };
  return {
    ...base,
    keys: Object.keys(documents),
    read(key) {
      const value = documents[key];
      return value === undefined ? undefined : { key, version: base.version(key), content: value };
    },
    documents: () => documents,
  };
}
const derivedText = new Map<
  string,
  {
    value: ProjectContent;
    version: number;
    wordsVersion: number;
    words: string | undefined;
    text: string;
  }
>();
const diagnostics = computed(() => {
  void snapshot.value;
  void editor.problemCount.value;
  const typed = Object.entries(typingProblems).flatMap(([document, entries]) =>
    entries.map((entry) => ({ document, severity: "error" as const, message: entry.message })),
  );
  if (typed.length) return typed;
  return updateProblems.value.length
    ? updateProblems.value
    : (session?.capture().diagnostics ?? []);
});
const acceptedDocuments = computed(() => snapshot.value?.documents() ?? {});
const workingDocuments = computed(() => ({ ...acceptedDocuments.value, ...optimistic.value }));
const guidedKind = ref<WorkspaceAction["kind"]>();
const guidedCommand = ref("");
const unknownSentence = computed(() =>
  engine.playerSentences.value.findLast(
    (entry) => entry.unknown && entry.room === engine.roomMap.currentRoom.value,
  ),
);
const logicLocation = ref<{ key: string; line: number; serial: number }>();
function openWordLogic(logic: number, line: number): void {
  const key = `logic:${logic}`;
  logicLocation.value = { key, line, serial: (logicLocation.value?.serial ?? 0) + 1 };
  openPart(key);
}
function wordResponse(room: number, command: string): void {
  openPart(`logic:${room}`);
  guidedCommand.value = command;
  guidedKind.value = "response";
}
const ai = useAiSettings();
async function openWordsChat(): Promise<void> {
  editor.focus.value = false;
  if (!engine.state.powerUp.open) await engine.openPowerUp(ai.llmConfig());
  workspace.showPanel("assistant");
}
async function wordsTask(task: WordsTask): Promise<void> {
  editor.focus.value = false;
  const { openWordsTask } = await import("./wordsAgent.ts");
  const scoped =
    task.kind === "suggest"
      ? task
      : { ...task, pictures: engine.roomMap.resources.value.scans.get(task.room)?.pictures ?? [] };
  await openWordsTask({
    task: scoped,
    documents: snapshot.value?.documents() ?? {},
    engine,
    compose: (request) => {
      workspace.showPanel("assistant");
      editor.agentPrefill.value = { ...request, readOnly: task.kind !== "review" };
    },
    configured: ai.aiConfigured.value,
    config: ai.llmConfig(),
    setup: () => ai.openAiSettings(null, "assistant"),
  });
}
async function wordChange(
  action: { from: number; to: number; word?: string } | { remove: string },
): Promise<void> {
  try {
    if (writeConflict.value) throw new Error(session!.saveStatus().message);
    await writes.flush();
    const captured = workingSnapshot();
    if (!captured) return;
    const { changeMeaning, removeMeaningWord } = await import("./wordsAnalysis.ts");
    const document = captured.read("words")!.content;
    const words =
      typeof document === "string"
        ? (JSON.parse(document) as [string, number][])
        : parseWordsTok(document).map(({ word, id }) => [word, id] as [string, number]);
    const changes =
      "remove" in action
        ? removeMeaningWord(words, captured.documents(), action.remove, profile.value)
        : changeMeaning(words, captured.documents(), action, profile.value);
    const result = await engine.submitProjectEdit({
      changes,
      origin: "words",
      author: "creator",
      label:
        "remove" in action
          ? `Removed word ${action.remove}`
          : `Changed meaning ${action.from} to ${action.to}`,
    });
    if (!["committed", "unchanged", "draft"].includes(result.status))
      throw new Error("Check Problems before changing this meaning.");
    draftChanged(true);
    editor.pin("words");
    editor.error.value = "";
    refresh();
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function guidedAction(action: WorkspaceAction): Promise<void> {
  if (writeConflict.value || actionBusy.value) return;
  actionBusy.value = true;
  makingRoom = action.kind === "make-room";
  try {
    await writes.flush();
    const capture = workingSnapshot();
    if (!capture) return;
    const { prepareWorkspaceAction } = await import("./workspaceGuided.ts");
    const prepared = prepareWorkspaceAction(capture, profile.value.id, action);
    if (!prepared.ok) throw new Error(prepared.message);
    const result = await engine.submitProjectEdit({
      changes: prepared.changes,
      label: prepared.label,
      origin: "logic",
      author: "creator",
    });
    if (!["committed", "unchanged", "draft"].includes(result.status))
      throw new Error("The action could not build. Check Problems and retry.");
    if (action.kind === "response") {
      const entry = engine.playerSentences.value.find(
        (row) => row.room === action.room && row.text === action.command,
      );
      if (entry) engine.resolvePlayerSentence(entry);
    }
    if (action.kind === "make-room") {
      refresh();
      const key = prepared.changes.find((change) => change.key.startsWith("logic:"))?.key;
      if (key) madeRoomArt[key] = action.key;
      if (key && props.creating && result.status !== "draft") {
        const room = Number(key.slice(6));
        const result = await engine.visitRoom(room);
        returnRoom.value = result.returnRoom;
        visitingRoom.value = room;
        if (!result.ok)
          stageNote.value = `Room ${room} needs more game state. The picture is paused for editing.`;
      }
    }
    if (action.kind === "add-room") {
      const key = prepared.changes.find((change) => change.key.startsWith("logic:"))?.key;
      if (key) openPart(key);
    }
    draftChanged(true);
    guidedKind.value = undefined;
    editor.error.value = "";
  } catch (cause) {
    editor.error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    makingRoom = false;
    actionBusy.value = false;
    refresh();
  }
}
const versionName = ref("");
const editingName = ref<string>();
const versionNames = computed(() => {
  const names: Record<string, string[]> = {};
  for (const [name, id] of Object.entries(historyState.value?.tags ?? {}))
    (names[id] ??= []).push(name);
  return names;
});
async function historyAction(action: () => Promise<unknown>): Promise<void> {
  actionBusy.value = true;
  try {
    if (writeConflict.value) throw new Error(session!.saveStatus().message);
    await writes.flush();
    await action();
    await session?.flush();
    editor.error.value = "";
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    actionBusy.value = false;
    refresh();
  }
}
async function restore(id: string): Promise<void> {
  await historyAction(async () => session?.restore(id));
}
async function nameVersion(): Promise<void> {
  if (!versionName.value.trim()) return;
  await historyAction(async () => {
    if (editingName.value === undefined) await session?.tag(versionName.value.trim());
    else await session?.renameTag(editingName.value, versionName.value.trim());
    versionName.value = "";
    editingName.value = undefined;
  });
}
async function clearName(name: string): Promise<void> {
  await historyAction(async () => {
    await session?.renameTag(name, null);
    if (editingName.value === name) {
      editingName.value = undefined;
      versionName.value = "";
    }
  });
}
async function add(group: string): Promise<void> {
  if (writeConflict.value || actionBusy.value) return;
  if (group === "WORDS" || group === "OBJECTS") {
    const key = group === "WORDS" ? "words" : "inventory";
    const source = text(key);
    const rows = typeof source === "string" ? (JSON.parse(source) as unknown[]) : [];
    if (group === "WORDS") {
      const { nextWordGroup } = await import("./wordGroups.ts");
      rows.push(["word", nextWordGroup(rows as [string, number][])]);
    } else rows.push({ name: "Object", startingRoom: 255 });
    edit(key, JSON.stringify(rows));
    openPart(key);
    return;
  }
  if (group === "SHARED LOGIC") {
    let num = 1;
    while (snapshot.value?.keys.includes(`logic:${num}`) && num < 256) num++;
    if (num > 255) {
      editor.error.value = "This resource group is full. Edit an existing part.";
      return;
    }
    edit(`logic:${num}`, "return;\n");
    openPart(`logic:${num}`);
    return;
  }
  const kind =
    group === "ROOMS"
      ? "logic"
      : group === "PICTURES"
        ? "picture"
        : group === "VIEWS"
          ? "view"
          : "sound";
  const used = new Set(snapshot.value?.keys ?? []);
  let num = 1;
  while (used.has(`${kind}:${num}`) && num < 256) num++;
  if (num > 255) {
    editor.error.value = "This resource group is full. Edit an existing part.";
    return;
  }
  if (kind === "logic") {
    openPart(`logic:${engine.roomMap.currentRoom.value ?? 0}`);
    guidedKind.value = "add-room";
    return;
  }
  if (kind === "picture") edit(`picture:${num}`, "vis 15\nfill 0,0\nend\n");
  else if (kind === "view") {
    const { buildView } = await import("../../../../src/view/view.ts");
    edit(
      `view:${num}`,
      buildView({
        loops: [
          {
            cels: [
              { width: 8, height: 8, transparentColor: 15, pixels: new Uint8Array(64).fill(15) },
            ],
          },
        ],
      }),
    );
  } else {
    const { createSoundDocument } = await import("../../../../src/sound/document.ts");
    const { applySoundPreset } = await import("../../../../src/sound/presets.ts");
    edit(
      `sound:${num}`,
      applySoundPreset(createSoundDocument({ profileId: profile.value.id }), "discovery").encode(),
    );
  }
  openPart(`${kind}:${num}`);
}
let endResize: (() => void) | undefined;
function resize(event: PointerEvent): void {
  endResize?.();
  const target = event.currentTarget as HTMLElement;
  const host = target.parentElement!;
  target.setPointerCapture(event.pointerId);
  const area = host.getBoundingClientRect();
  const left = host.querySelector(".parts-list")?.getBoundingClientRect().width ?? 0;
  let value = editor.effectiveSplit.value;
  let frame = 0;
  layoutDragging.value = true;
  host.classList.add("is-resizing");
  const paint = () => {
    frame = 0;
    host.style.setProperty("--workspace-game", `minmax(0, ${value}fr)`);
    host.style.setProperty("--workspace-edit", `minmax(0, ${100 - value}fr)`);
  };
  const move = (e: PointerEvent) => {
    value = Math.min(
      75,
      Math.max(
        25,
        stacked.value
          ? (100 * (e.clientY - area.top)) / area.height
          : (100 * (e.clientX - area.left - left)) / (area.width - left),
      ),
    );
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const end = () => {
    cancelAnimationFrame(frame);
    editor.resize(value);
    host.classList.remove("is-resizing");
    layoutDragging.value = false;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    target.removeEventListener("lostpointercapture", end);
    endResize = undefined;
  };
  endResize = end;
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
  target.addEventListener("lostpointercapture", end);
}
let lastEscape = 0;
function escape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !props.creating || !editor.focus.value) return;
  if (
    openExplainer.value !== null ||
    [
      ...document.querySelectorAll(
        'dialog[open], [role="menu"], .suggest-widget.visible, .monaco-hover, .workspace-guided__form, .words-choice, .word-suggestion',
      ),
    ].some((popover) => popover.getClientRects().length > 0)
  ) {
    lastEscape = 0;
    return;
  }
  const now = Date.now();
  if (now - lastEscape < 700) {
    editor.toggleFocus();
    event.preventDefault();
    event.stopImmediatePropagation();
    lastEscape = 0;
  } else lastEscape = now;
}
window.addEventListener("keydown", escape, true);
function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}
watch(
  () => editor.pendingChanges.value,
  (unsaved) => {
    if (unsaved) window.addEventListener("beforeunload", warnBeforeUnload);
    else window.removeEventListener("beforeunload", warnBeforeUnload);
  },
  { immediate: true, flush: "sync" },
);
function flushHidden(): void {
  if (!writeConflict.value) void flushWorkspace().catch(() => {});
}
function visibilityChanged(): void {
  if (document.visibilityState === "hidden") flushHidden();
}
window.addEventListener("pagehide", flushHidden);
document.addEventListener("visibilitychange", visibilityChanged);
editor.unsavedEdits.value = () => {
  const buffers = {
    ...(session?.saveStatus().state === "saved" ? {} : snapshot.value?.documents()),
    ...optimistic.value,
  };
  for (const [key, value] of Object.entries(buffers))
    if (key.startsWith("sound:"))
      for (const change of editorChanges(key, value, buffers["music"]))
        buffers[change.key] = change.content!;
  return buffers;
};
onBeforeUnmount(() => {
  offDrafts?.();
  editor.update.value = undefined;
  editor.discardDrafts.value = undefined;
  editor.changeCount.value = 0;
  phoneQuery.removeEventListener("change", phoneLayout);
  endResize?.();
  retired = true;
  window.removeEventListener("beforeunload", warnBeforeUnload);
  window.removeEventListener("pagehide", flushHidden);
  document.removeEventListener("visibilitychange", visibilityChanged);
  editor.unsavedEdits.value = undefined;
  editor.pendingChanges.value = false;
  writes.dispose();
  editor.flush.value = undefined;
  editor.discard.value = undefined;
  editor.retry.value = undefined;
  unsubscribe?.();
  window.removeEventListener("keydown", escape, true);
  window.removeEventListener("dragover", musicDrag, true);
  window.removeEventListener("drop", dropMusic, true);
  editor.gameHost.value = null;
  editor.pictureLive.value = false;
  editor.stageSolo.value = false;
  editor.stagePaused.value = false;
  engine.resumeEngine("stageArt");
});
</script>
<template>
  <PausedPicture
    v-if="
      creating &&
      stageNote &&
      editor.kind.value !== 'picture' &&
      !editor.focus.value &&
      pausedPicture
    "
    :bytes="pausedPicture"
    :profile
  />
  <aside
    v-if="creating && presentation.debugOpen.value"
    class="workspace-inspector"
    aria-label="Game inspector"
    @keydown.esc.stop.prevent="presentation.debugOpen.value = false"
  >
    <header>
      <strong>Inspector</strong
      ><UiButton
        size="sm"
        variant="ghost"
        aria-label="Close"
        @click="presentation.debugOpen.value = false"
        ><UiIcon name="x" :size="16"
      /></UiButton>
    </header>
    <InspectPanel />
  </aside>
  <PartsList
    :data-analysis="engine.roomMap.analysisStatus.value"
    :active="
      creating && !editor.focus.value && (!workspace.collapsed.left || editor.partsOpen.value)
    "
    :read-only="writeConflict || actionBusy"
    :class="{ 'parts-list--open': editor.partsOpen.value }"
    v-show="
      creating && !editor.focus.value && (!workspace.collapsed.left || editor.partsOpen.value)
    "
    :pending="draftMembership"
    :bindings="typeof content('bindings') === 'string' ? String(content('bindings')) : undefined"
    :groups="groups"
    :selected="editor.selected.value"
    :thumbnails="thumbnails"
    :views="viewThumbnails"
    :profile="profile"
    @open="(key, room) => openPart(key, false, room)"
    @pin="(key, room) => openPart(key, true, room)"
    @add="add"
  />
  <div
    v-show="creating && editor.selected.value && !editor.focus.value"
    class="workspace-splitter"
    role="separator"
    :aria-label="stacked ? 'Editor height' : 'Editor width'"
    :aria-orientation="stacked ? 'horizontal' : 'vertical'"
    tabindex="0"
    :aria-valuenow="editor.split.value"
    aria-valuemin="25"
    aria-valuemax="75"
    @pointerdown="resize"
    @keydown.left.prevent="editor.resize(editor.split.value - 2)"
    @keydown.right.prevent="editor.resize(editor.split.value + 2)"
    @keydown.up.prevent="editor.resize(editor.split.value - 2)"
    @keydown.down.prevent="editor.resize(editor.split.value + 2)"
  ></div>
  <Teleport defer to=".play-area"
    ><UiButton
      v-if="creating && unknownSentence"
      size="sm"
      variant="ghost"
      class="workspace-teach"
      @click="wordResponse(unknownSentence.room, unknownSentence.text)"
      >Teach this</UiButton
    ></Teleport
  >
  <section
    v-show="creating && editor.selected.value"
    class="workspace-editor"
    :class="{ 'workspace-editor--focus': editor.focus.value }"
    data-testid="workspace-editor"
    data-shell-keys
  >
    <header class="workspace-editor__header">
      <ProjectTabs
        pending
        :tabs="tabRows"
        :selected-key="editor.selected.value ?? null"
        @select="(key) => openPart(key)"
        @pin="editor.pin"
        @close="editor.close"
      />
      <div
        v-if="editor.kind.value !== 'picture' && !unusedArt"
        class="workspace-axis"
        aria-label="Editor layout"
      >
        <UiButton
          size="sm"
          variant="ghost"
          aria-label="Side by side"
          title="Side by side"
          :aria-pressed="editor.splitAxis.value === 'horizontal'"
          @click="editor.setSplitAxis('horizontal')"
          ><UiIcon name="panel-left" :size="16"
        /></UiButton>
        <UiButton
          size="sm"
          variant="ghost"
          aria-label="Stacked"
          title="Stacked"
          :aria-pressed="editor.splitAxis.value === 'vertical'"
          @click="editor.setSplitAxis('vertical')"
          ><UiIcon name="panel-left" :size="16" style="transform: rotate(90deg)"
        /></UiButton>
      </div>
      <template v-if="editor.kind.value === 'picture' || editor.kind.value === 'view'">
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="writeConflict || actionBusy"
          :title="
            writeConflict ? 'Editing is paused. Download your unsaved edits, then reload.' : ''
          "
          @click="
            imagePanel = editor.selected.value;
            imageGenerate = false;
          "
          >{{
            editor.kind.value === "picture"
              ? VOCABULARY.traceImage.label
              : VOCABULARY.makeCels.label
          }}</UiButton
        >
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="writeConflict || actionBusy"
          :title="
            writeConflict ? 'Editing is paused. Download your unsaved edits, then reload.' : ''
          "
          @click="
            imagePanel = editor.selected.value;
            imageGenerate = true;
          "
          >Generate</UiButton
        >
      </template>
      <DebugControls
        v-if="
          debug?.state.epoch &&
          (editor.kind.value === 'logic' || debug.stopped.value || debug.state.stepping)
        "
        :debug="debug"
      />
      <GuidedAdd
        v-if="editor.kind.value === 'logic' && snapshot"
        v-model:action="guidedKind"
        :room="Number(editor.selected.value?.split(':')[1] ?? 0)"
        :initial-command="guidedCommand"
        :busy="editor.busy.value || writeConflict"
        :snapshot
        :profile-id="profile.id"
        :groups
        :thumbnails
        :views="viewThumbnails"
        :sounds="guidedSounds"
        @add="guidedAction"
      />
      <UiButton
        size="sm"
        variant="ghost"
        data-testid="workspace-focus"
        :aria-pressed="editor.focus.value"
        :title="VOCABULARY.focus.help"
        @click="editor.toggleFocus"
        >Focus</UiButton
      >
      <ImageReferencePanel
        v-if="
          !writeConflict &&
          imagePanel === editor.selected.value &&
          imagePanel?.startsWith('picture:') &&
          session
        "
        :key="imagePanel"
        :session="session"
        :target="imagePanel"
        :profile="profile"
        :generate="imageGenerate"
        active
        :image-revision="snapshot?.version('images') ?? 0"
        :resource-revision="snapshot?.version(imagePanel) ?? 0"
        @close="imagePanel = undefined"
        @changed="
          draftChanged(true);
          refresh();
        "
      />
    </header>
    <div v-if="unusedArt" class="workspace-stage-note" data-testid="workspace-unused">
      <span>Not used by a room yet</span>
      <UiButton
        size="sm"
        variant="ghost"
        :disabled="actionBusy || writeConflict"
        :title="
          writeConflict ? 'Resolve the project conflict first' : actionBusy ? 'Saving the room' : ''
        "
        @click="guidedAction({ kind: 'make-room', key: editor.selected.value! })"
        >Make it a room</UiButton
      >
      <UiButton
        v-if="returnRoom !== undefined"
        size="sm"
        variant="ghost"
        :disabled="visitBusy"
        :title="visitBusy ? 'Entering the room' : ''"
        @click="backToGame()"
        >Back to Room {{ returnRoom }}</UiButton
      >
    </div>
    <div
      v-else-if="visitingRoom !== undefined && returnRoom !== undefined"
      class="workspace-stage-note"
      data-testid="workspace-visit"
    >
      <span>Visiting Room {{ visitingRoom }}</span>
      <span v-if="editor.kind.value === 'picture' && !stageNote">· running your last update</span>
      <UiButton
        size="sm"
        variant="ghost"
        :disabled="visitBusy"
        :title="visitBusy ? 'Entering the room' : ''"
        @click="backToGame()"
        >Back to Room {{ returnRoom }}</UiButton
      >
    </div>
    <p v-if="stageNote" class="workspace-stage-note" data-testid="workspace-stage-note">
      {{ stageNote }}
    </p>
    <div
      v-else-if="
        editor.kind.value === 'picture' && selectedRoom !== undefined && returnRoom === undefined
      "
      class="workspace-stage-note"
      data-testid="workspace-room-live"
    >
      Room {{ selectedRoom }} · running your last update
    </div>
    <p
      v-if="
        diagnostics.some((entry) => entry.severity === 'error') && editor.kind.value === 'logic'
      "
      class="workspace-error"
      data-testid="workspace-last-good"
    >
      The game keeps running the last working version. Fix the errors below.
    </p>
    <Teleport
      v-if="creating && editor.error.value && !engine.state.leaving && !editor.exitRefusal.value"
      defer
      :to="editor.history.value ? '#workspace-history-errors' : undefined"
      :disabled="!editor.history.value"
    >
      <p class="workspace-error" role="alert">
        {{ editor.error.value }} <UiButton v-if="!writeConflict" @click="retrySave">Retry</UiButton>
      </p>
    </Teleport>
    <div
      v-for="key in editor.retained.value"
      :key="`${key}:${editorEpoch}`"
      v-show="key === editor.selected.value"
      class="workspace-editor__surface"
    >
      <ImageReferencePanel
        v-if="!writeConflict && imagePanel === key && session && key.startsWith('view:')"
        :session="session"
        :target="key"
        :profile="profile"
        :generate="imageGenerate"
        :active="key === editor.selected.value"
        :image-revision="snapshot?.version('images') ?? 0"
        :resource-revision="snapshot?.version(key) ?? 0"
        @close="imagePanel = undefined"
        @changed="
          draftChanged(true);
          refresh();
        "
      />
      <RoomStudio
        :read-only="writeConflict || actionBusy"
        v-if="key.startsWith('picture:') && native(key) && profile"
        :live-game="
          creating &&
          key === editor.selected.value &&
          editor.pictureLive.value &&
          !editor.stagePaused.value &&
          selectedRoom === engine.roomMap.currentRoom.value
        "
        :workspace-focus="editor.focus.value"
        embedded
        @game-host="gameHost(key, $event)"
        @agent-context="editor.setAgentContext(key, $event)"
        @agent-ask="openAgent"
        :underlay="traceUnderlays[key] ?? null"
        :walk="pictureWalks[key]"
        :current-room-source="
          () => (pictureWalks[key] ? text(`logic:${pictureWalks[key]!.room}`) : undefined)
        "
        :priority-base="livePreview.state?.priorityBase"
        :lesson-session="editor.studioRequests.value[key]?.lesson"
        @room-edit="
          (room, source, bindings, pictureSource) =>
            editRoom(key, room, source, bindings, pictureSource)
        "
        @play-here="playHere"
        :running-bytes="container?.getResource('picture', Number(key.split(':')[1])) ?? undefined"
        :picture-number="Number(key.split(':')[1])"
        :bytes="native(key)!"
        :authored-source="text(key)"
        :profile="profile"
        :title="tabRows.find((tab) => tab.key === key)?.label ?? key"
        :base-revision="revision"
        :files="files"
        @edit="edit(key, $event)"
      />
      <SpriteStudio
        :read-only="writeConflict || actionBusy"
        v-else-if="
          key.startsWith('view:') && (native(key) || spriteRequest(key)?.stagedReference) && profile
        "
        v-show="imagePanel !== key"
        :workspace-focus="editor.focus.value || phoneWidth"
        embedded
        :usage="spriteContexts[key]?.usage ?? { rooms: [], logics: [], dynamic: false }"
        :rooms="spriteContexts[key]?.rooms ?? []"
        :speed="livePreview.state?.vars[10] ?? 2"
        :cyclers="previewCyclers"
        :priority-base="livePreview.state?.priorityBase"
        :staged-reference="spriteRequest(key)?.stagedReference"
        :lesson-session="editor.studioRequests.value[key]?.lesson"
        :view-number="Number(key.split(':')[1])"
        @agent-context="editor.setAgentContext(key, $event)"
        @agent-ask="openAgent"
        @use-staged="editView(key, $event)"
        :bytes="spriteRequest(key)?.stagedReference ? spriteRequest(key)!.bytes : native(key)!"
        :profile="profile"
        :base-revision="revision"
        :files="files"
        @edit="editView(key, $event)"
      />
      <LogicEditor
        :read-only="writeConflict || actionBusy"
        v-else-if="key.startsWith('logic:') && text(key) !== undefined && snapshot"
        :ref="
          (instance) => {
            if (instance) logicEditors.set(key, instance as unknown as LogicEditorHandle);
            else logicEditors.delete(key);
          }
        "
        :document-key="key"
        :breakpoints="
          debug?.state.breakpoints
            .filter((point) => point.logic === Number(key.slice(6)))
            .map((point) => point.line)
        "
        :stopped-line="
          debug?.position.value?.logic === Number(key.slice(6))
            ? debug.position.value.line
            : undefined
        "
        :running-source="debug?.state.epoch ? debug.sources.value[key.slice(6)] : undefined"
        @breakpoint="toggleBreakpoint(key, $event)"
        :location="logicLocation?.key === key ? logicLocation : undefined"
        :source="text(key)!"
        :snapshot="languageSnapshot ?? snapshot"
        :profile-id="profile.id"
        :active="creating && key === editor.selected.value"
        @edit="edit(key, $event)"
        @selection="editor.setAgentContext(key, $event)"
        @problems="reportProblems(key, $event)"
      />
      <WordsEditor
        :read-only="writeConflict || actionBusy"
        v-else-if="key === 'words' && text(key) !== undefined && snapshot"
        :source="text(key)!"
        :documents="workingDocuments"
        :snapshot
        :profile="profile"
        :room="engine.roomMap.currentRoom.value ?? 0"
        :active="creating && key === editor.selected.value"
        @edit="edit(key, $event)"
        @move="wordChange"
        @remove="wordChange({ remove: $event })"
        @open-logic="openWordLogic"
        @response="wordResponse"
        @guided="guidedAction"
        @task="wordsTask"
        @chat="openWordsChat"
      />
      <TableEditor
        :read-only="writeConflict || actionBusy"
        v-else-if="key === 'inventory' && text(key) !== undefined"
        :kind="key"
        :source="text(key)!"
        @edit="edit(key, $event)"
      />
      <SoundPanel
        :read-only="writeConflict || actionBusy"
        v-else-if="key.startsWith('sound:') && native(key)"
        :document-key="key"
        :bytes="soundBytes(key)"
        :tempo="soundTempo(key)"
        :sounds="guidedSounds"
        :profile-id="profile.id"
        :active="creating && key === editor.selected.value"
        @edit="(bytes, tempo) => editSound(key, bytes, tempo)"
        :import-file="musicDropTarget === key ? musicDrop : undefined"
        @imported="musicDrop = undefined"
        @add="addImportedSound"
        @open="openPart(`sound:${$event}`)"
      />
      <NotesEditor
        :read-only="writeConflict || actionBusy"
        v-else-if="key === 'notes'"
        :source="text(key) ?? ''"
        @edit="edit(key, $event)"
      />
      <p v-else class="workspace-error">Open an authored part to edit it.</p>
    </div>
    <button
      v-if="editor.focus.value"
      class="workspace-game-chip"
      data-testid="workspace-show-game"
      @click="editor.toggleFocus"
    >
      {{
        editor.stagePaused.value ? "Done" : `${editor.debugStatus.value || "Game running"} · Show`
      }}
    </button>
  </section>
  <section
    v-if="creating && editor.panel.value"
    class="workspace-problems"
    aria-label="Problems"
    data-testid="workspace-problems"
    @keydown.esc.stop.prevent="editor.panel.value = false"
  >
    <UiButton
      class="workspace-problems-close"
      size="sm"
      variant="ghost"
      aria-label="Close"
      @click="editor.panel.value = false"
      ><UiIcon name="x" :size="16"
    /></UiButton>
    <Suspense v-if="debug">
      <DebugPanel :debug="debug" :problems="diagnostics" @reveal="revealDebug" />
      <template #fallback>
        <header>
          <h2>Problems</h2>
        </header>
      </template>
    </Suspense>
    <template v-else>
      <header>
        <h2>Problems</h2>
      </header>
      <p v-if="diagnostics.length === 0">Everything builds.</p>
      <p v-for="(entry, index) in diagnostics" :key="index">{{ entry.message }}</p>
    </template>
  </section>
  <aside
    v-if="creating && editor.history.value"
    class="workspace-history"
    aria-label="History"
    data-testid="workspace-history"
    @keydown.esc.stop.prevent="editor.history.value = false"
  >
    <header>
      <h2>History</h2>
      <UiButton size="sm" variant="ghost" aria-label="Close" @click="editor.history.value = false"
        ><UiIcon name="x" :size="16"
      /></UiButton>
    </header>
    <div id="workspace-history-errors"></div>
    <p>{{ VOCABULARY.history.help }}</p>
    <form @submit.prevent="nameVersion">
      <input v-model="versionName" aria-label="Version name" placeholder="Opening scene" /><UiButton
        size="sm"
        type="submit"
        :disabled="writeConflict || editor.busy.value"
        >{{ editingName === undefined ? "Name this version" : "Save name" }}</UiButton
      >
      <UiButton
        v-if="editingName !== undefined"
        size="sm"
        variant="ghost"
        @click="
          editingName = undefined;
          versionName = '';
        "
        >Cancel</UiButton
      >
    </form>
    <div
      v-for="commit in [...(historyState?.commits ?? [])].reverse()"
      :key="commit.id"
      class="workspace-history__row"
    >
      <div class="workspace-history__labels">
        <div
          v-for="name in versionNames[commit.id] ?? []"
          :key="name"
          class="workspace-history__checkpoint"
        >
          <span class="workspace-history__name">{{ name }}</span>
          <div class="workspace-history__actions">
            <UiButton
              size="sm"
              variant="ghost"
              :disabled="writeConflict || editor.busy.value"
              :aria-label="`Rename ${name}`"
              @click="
                editingName = name;
                versionName = name;
              "
              >Rename</UiButton
            >
            <UiButton
              size="sm"
              variant="ghost"
              :disabled="writeConflict || editor.busy.value"
              :aria-label="`Clear ${name}`"
              @click="clearName(name)"
              >Clear</UiButton
            >
          </div>
        </div>
        <span
          class="workspace-history__label"
          :class="{ 'is-secondary': versionNames[commit.id]?.length }"
          >{{ commit.label }}</span
        >
      </div>
      <UiButton
        size="sm"
        :disabled="writeConflict || commit.id === historyState?.cursor || editor.busy.value"
        @click="restore(commit.id)"
        >Restore</UiButton
      >
    </div>
  </aside>
  <aside
    v-if="creating && musicDrop && !musicDropTarget"
    class="workspace-music-preview"
    aria-label="Music import"
  >
    <SoundImport
      :file="musicDrop"
      :profile-id="profile.id"
      @apply="(bytes, tempo) => addImportedSound(bytes, tempo)"
      @cancel="musicDrop = undefined"
    />
  </aside>
</template>

<style scoped>
.workspace-music-preview {
  position: absolute;
  right: var(--space-5);
  bottom: var(--space-5);
  width: min(440px, 90%);
  z-index: var(--z-popover);
}
.workspace-editor__header:has(.workspace-debug-controls) {
  flex-wrap: wrap;
}
.workspace-problems:has(.workspace-debug-panel) {
  max-height: 290px;
  overflow: hidden;
}
.workspace-problems {
  position: relative;
}
.workspace-problems-close {
  position: absolute;
  top: var(--space-3);
  right: var(--space-5);
  z-index: 1;
}
.workspace-problems :deep(header) {
  padding-right: var(--space-8);
}
</style>
