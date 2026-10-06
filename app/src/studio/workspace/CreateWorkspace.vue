<script setup lang="ts">
import UiIcon from "../../ui/UiIcon.vue";
import {
  selectLaunch,
  readWorldLaunches,
  type Launch,
} from "../../../../src/authoring/launches.ts";
import type { AuthoringState } from "../../../../src/authoring/authoringState.ts";
import { renameRoomTitle } from "../../../../src/authoring/world.ts";
import { gameRoomMenu, roomMenuArmed } from "../../play/roomActionMenu.ts";
import UiDialog from "../../ui/UiDialog.vue";
import GuidedAdd from "./GuidedAdd.vue";
import {
  roomPlacements,
  moveRoomPlacement,
  type RoomPlacement,
} from "../../../../src/authoring/roomPlacements.ts";
import { soundProjectChanges } from "../sound/soundEdits.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import "./workspace.css";
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  onWatcherCleanup,
  ref,
  shallowRef,
  watch,
} from "vue";
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
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import ActionMenu from "../../ui/ActionMenu.vue";
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
const StudioKeySheet = defineAsyncComponent(() => import("../StudioKeySheet.vue"));
const GameStateTab = defineAsyncComponent(() => import("./GameStateTab.vue"));
const MessagesTab = defineAsyncComponent(() => import("./MessagesTab.vue"));
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
const stacked = computed(() => phoneWidth.value || editor.stackedLayout.value);
const roomHint = shallowRef<{ key: string; room: number }>();
function openPart(key: string, room?: number): void {
  roomHint.value = room === undefined ? undefined : { key, room };
  if (window.innerWidth <= 1280 && engine.state.powerUp.open) engine.closePowerUp();
  if ((key === "words" || key === "inventory") && text(key) === undefined) edit(key, "[]\n");
  editor.open(key);
  if (window.innerWidth <= 600) {
    editor.partsOpen.value = false;
  }
}
/** The Game state + row names a flag or variable: it joins the bindings. */
function nameState(kind: "flag" | "variable", num: number, name: string): void {
  const current = content("bindings");
  const bindings = typeof current === "string" ? readBindingsDocument(current) : {};
  edit("bindings", JSON.stringify({ ...bindings, [name]: { kind, num } }));
  openPart("state");
}
/** The Parts room row names the room in place; the world keeps everything else. */
function renameRoom(room: number, title: string): void {
  renamingRoom.value = undefined;
  const current = content("world");
  const world =
    typeof current === "string"
      ? (JSON.parse(current) as AuthoringState["world"])
      : { rooms: {}, facts: {}, quests: {} };
  edit("world", JSON.stringify(renameRoomTitle(world, room, title)));
}
/** The ⋯ menu's rare actions for the open tab, plus the frame's own. */
const frameMenuItems = computed(() => {
  const key = editor.selected.value;
  return [
    ...(key ? (editor.frameActions.value[key]?.() ?? []) : []),
    {
      id: "history",
      label: "History",
      testId: "workspace-more-history",
      disabled: undefined,
      title: undefined,
      run: () => (editor.history.value = true),
    },
  ];
});
/** One shortcut sheet for the workspace, opened at the tab's own section. */
const keySheet = computed(() => {
  const key = editor.selected.value;
  return (
    (key ? editor.keySheets.value[key]?.() : undefined) ?? {
      name: "Workspace",
      sections: [],
    }
  );
});
/** Quiet right side of the shared status bar: size, then the AGI profile. */
const statusMeta = computed(() => {
  const key = editor.selected.value;
  if (!key || !profile.value) return "";
  const registered = editor.statusMeta.value[key]?.();
  const size =
    registered ??
    (key.includes(":")
      ? native(key)?.length
      : ["words", "inventory", "notes", "bindings"].includes(key)
        ? text(key)?.length
        : undefined);
  return [
    size === undefined
      ? ""
      : typeof size === "string"
        ? size
        : `${size.toLocaleString("en")} bytes`,
    `AGI ${profile.value.id}`,
  ]
    .filter(Boolean)
    .join(" · ");
});
/** The game bar's room label: the room the game is in by name. */
const currentRoomLabel = computed(() => {
  const room = engine.roomMap.currentRoom.value;
  if (room === null) return "";
  const label = groups.value
    .flatMap((group) => group.entries)
    .find((entry) => entry.room === room && !entry.child)?.label;
  const title = label?.includes("·") ? label.split("·")[0]!.trim() : "";
  return `Room ${room}${title ? ` · ${title}` : ""}`;
});
/** The keys dot in the game bar: on while the game has focus. */
const gameFocused = ref(false);
function trackGameFocus(): void {
  gameFocused.value = !!document.querySelector(".play-area")?.contains(document.activeElement);
}
document.addEventListener("focusin", trackGameFocus);
document.addEventListener("focusout", trackGameFocus);
function focusGameInput(): void {
  document.getElementById("game-command")?.focus();
}
/** Open tabs live with the project: they come back on reload and leave on ×. */
let tabsProject = "";
watch(
  [() => engine.state.phase, () => props.creating],
  ([, creating]) => {
    const project = engine.currentGame()?.projectId;
    if (!creating || !project) return;
    const storageKey = `monotio_agi.workspaceTabs.${project}`;
    if (tabsProject === storageKey) return;
    tabsProject = storageKey;
    if (editor.tabs.value.length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
        tabs?: string[];
        selected?: string;
      } | null;
      for (const key of saved?.tabs ?? [])
        if (!editor.tabs.value.includes(key)) editor.tabs.value.push(key);
      for (const key of editor.tabs.value)
        if (!editor.retained.value.includes(key)) editor.retained.value.push(key);
      if (saved?.selected && editor.tabs.value.includes(saved.selected))
        editor.selected.value = saved.selected;
      const rename = localStorage.getItem(`monotio_agi.workspaceRename.${project}`);
      if (rename !== null) {
        localStorage.removeItem(`monotio_agi.workspaceRename.${project}`);
        const room = Number(rename);
        if (Number.isInteger(room) && room > 0 && room <= 255) renamingRoom.value = room;
      }
    } catch {
      /* Open empty. */
    }
  },
  { immediate: true },
);
watch(
  () => [editor.tabs.value.join("\u0000"), editor.selected.value],
  () => {
    if (!props.creating || !tabsProject) return;
    try {
      localStorage.setItem(
        tabsProject,
        JSON.stringify({ tabs: editor.tabs.value, selected: editor.selected.value }),
      );
    } catch {
      /* Keep this session's tabs only. */
    }
  },
);
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
  prepareLaunch: async () => {
    if (editor.changeCount.value) await updateGame(false);
    if (editor.error.value) throw new Error(editor.error.value);
  },
  launch: () => runSelectedLaunch(true),
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
  editor.canUndo.value =
    draftStatus.canUndo ||
    !!capture.history.commits.find((commit) => commit.id === capture.history.cursor)?.parent;
  editor.canRedo.value = draftStatus.canRedo || capture.history.future.length > 0;
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
  for (const key of draftMembership.value) {
    if (key.startsWith("logic:")) {
      const room = Number(key.slice(6));
      if (room > 0 && room <= 255 && !scan.shared.has(room)) roomIds.add(room);
    }
  }
  const rooms = [...roomIds]
    .filter((room) => room > 0 && room <= 255)
    .map((room) => {
      const node = engine.roomMap.graph.value.nodes.find((node) => node.room === room);
      const draftLogic = optimistic.value[`logic:${room}`];
      const draftText =
        typeof draftLogic === "string"
          ? draftLogic
          : draftLogic instanceof Uint8Array
            ? new TextDecoder().decode(draftLogic)
            : undefined;
      const bound = groupMetadata.value.bindings ?? snapshot.value?.read("bindings")?.content;
      const boundText =
        typeof bound === "string"
          ? bound
          : bound instanceof Uint8Array
            ? new TextDecoder().decode(bound)
            : undefined;
      const draftPicture = draftText !== undefined ? roomPictureNumber(draftText, boundText) : null;
      const pictures =
        draftPicture !== null
          ? [draftPicture]
          : roomPictureUse(room, {
              scans: scan.scans,
              shared: scan.shared,
              pictures: scan.picture,
            })
              .pictures.filter((use) => use.exists)
              .map((use) => use.picture);
      const logic = admitted[`logic:${room}`];
      if (pictures.length === 0 && typeof logic === "string") {
        const picture = roomPictureNumber(logic, boundText);
        if (picture !== null) pictures.push(picture);
      }
      const art =
        pictures[0] === undefined
          ? undefined
          : (optimistic.value[`picture:${pictures[0]}`] ??
            snapshot.value?.read(`picture:${pictures[0]}`)?.content);
      const artText =
        typeof art === "string"
          ? art
          : art instanceof Uint8Array
            ? new TextDecoder().decode(art)
            : undefined;
      const heading = artText ? /^#\s*([^:\n—]+)(?::|—)/.exec(artText)?.[1]?.trim() : undefined;
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
  return workspaceParts({
    keys,
    rooms,
    names,
    currentRoom: engine.roomMap.currentRoom.value,
    debugging: editor.debugging.value,
  });
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
const DATA_LABELS: Record<string, string> = {
  state: "Game state",
  problems: "Problems",
  messages: "Messages",
  "debug:variables": "Variables",
  "debug:watch": "Watch",
  "debug:stack": "Call stack",
  "debug:breakpoints": "Breakpoints",
};
const tabRows = computed(() =>
  editor.tabs.value.map((key) => ({
    key,
    label:
      DATA_LABELS[key] ??
      (key === "words"
        ? "WORDS"
        : key === "inventory"
          ? "OBJECTS"
          : key === "notes"
            ? "Notes"
            : key.replace(":", " ").toUpperCase()),
    dirty: draftMembership.value.includes(key),
    missing:
      DATA_LABELS[key] === undefined &&
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
            : (request?.room ??
              uses.find((row) => row.room === engine.roomMap.currentRoom.value)?.room ??
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
watch(
  [selectedRoom, engine.roomMap.currentRoom, snapshot, groupMetadata, groups],
  () => {
    const room = selectedRoom.value ?? engine.roomMap.currentRoom.value ?? undefined;
    editor.actionRoom.value = room;
    let world: {
      rooms?: Record<string, { title?: string }>;
      launches?: Record<string, { selected?: string; entries: Launch[] }>;
    } = {};
    try {
      world = JSON.parse(
        String(groupMetadata.value.world ?? snapshot.value?.read("world")?.content ?? "{}"),
      );
    } catch {
      /* Room identities stay available. */
    }
    editor.actionRoomName.value =
      room === undefined
        ? ""
        : world.rooms?.[room]?.title ||
          groups.value
            .flatMap((group) => group.entries)
            .find((entry) => entry.id === `room:${room}`)
            ?.label.split(" · ROOM ")[0] ||
          `Room ${room}`;
    const launches = world.launches ? readWorldLaunches(world.launches) : {};
    const choices = room === undefined ? undefined : launches[room];
    editor.launchChoices.value = choices?.entries ?? [];
    const selected = room === undefined ? "carry" : (choices?.selected ?? "carry");
    editor.selectedLaunch.value =
      selected === "beginning" ||
      selected === "carry" ||
      editor.launchChoices.value.some((entry) => entry.id === selected)
        ? selected
        : "carry";
  },
  { immediate: true },
);
editor.selectLaunch.value = async (id) => {
  const room = editor.actionRoom.value;
  if (room === undefined || !session) return;
  try {
    const capture = session.model.capture();
    const world = JSON.parse(
      String(capture.read("world")?.content ?? "{}"),
    ) as AuthoringState["world"];
    const content = JSON.stringify(selectLaunch(world, room, id));
    const result = await session.submit({
      proposal: session.model.propose(capture, "Select launch", [{ key: "world", content }]),
      label: "Select launch",
      origin: "logic",
      author: "creator",
    });
    if (!["committed", "unchanged"].includes(result.status))
      throw new Error("Launch selection could not save. Try again.");
    editor.selectedLaunch.value = id;
    refresh();
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  }
};
let launchSerial = 0;
async function runSelectedLaunch(
  debug = false,
  entry?: { room: number; beginning: boolean; state?: Launch },
): Promise<void> {
  const serial = ++launchSerial;
  const room = entry?.room ?? editor.actionRoom.value;
  if (room === undefined) throw new Error("Open a room to play it.");
  const state =
    entry === undefined
      ? editor.launchChoices.value.find((choice) => choice.id === editor.selectedLaunch.value)
      : entry.state;
  const result = await engine.launchRoom(room, {
    beginning: entry?.beginning ?? editor.selectedLaunch.value === "beginning",
    ...(state ? { state } : {}),
    debug,
  });
  if (!result.ok) throw new Error(result.reason ?? "Launch could not start. Try again.");
  if (serial === launchSerial && props.creating) {
    returnRoom.value = result.returnRoom;
    visitingRoom.value = result.room;
  }
}
const unusedArt = computed(
  () =>
    (editor.kind.value === "picture" || editor.kind.value === "view") &&
    selectedRoom.value === undefined,
);
/** The context row shows only when the open tab has tools to offer. */
const contextRow = computed(() => {
  const kind = editor.kind.value;
  return (
    kind === "picture" ||
    kind === "view" ||
    (kind === "logic" && snapshot.value !== undefined) ||
    (debug.value?.state.epoch !== undefined &&
      debug.value.state.epoch > 0 &&
      (kind === "logic" || debug.value.stopped.value || debug.value.state.stepping)) ||
    unusedArt.value
  );
});
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
watch(
  () => props.creating,
  () => {
    launchSerial++;
  },
);
watch([editor.selected, roomHint, () => props.creating], () => {
  stageNote.value = "";
  if (!props.creating) returnRoom.value = visitingRoom.value = undefined;
});
watch(
  [editor.selected, unusedArt, () => props.creating, stageNote],
  () => {
    editor.stagePaused.value = !!stageNote.value;
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
function stagedRequest(key: string) {
  return editor.studioRequests.value[key]?.staged;
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
  const staged = stagedRequest(key);
  if (staged && staged.baseRevision !== revision.value) {
    editor.error.value = "The game changed since this sheet was staged. Attach the sheet again.";
    return;
  }
  edit(key, bytes);
  if (staged) {
    const request = editor.studioRequests.value[key];
    if (request)
      editor.studioRequests.value = {
        ...editor.studioRequests.value,
        [key]: { ...request, staged: undefined },
      };
  }
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
const placementInput = computed(() => {
  try {
    return {
      room: selectedRoom.value ?? 0,
      sources: Object.fromEntries(
        (snapshot.value?.keys ?? [])
          .filter((key) => key.startsWith("logic:"))
          .flatMap((key) => {
            const source = text(key);
            return source === undefined ? [] : [[key, source]];
          }),
      ),
      bindings: readBindingsDocument(
        String(groupMetadata.value.bindings ?? text("bindings") ?? "{}"),
      ),
    };
  } catch {
    // An unfinished bindings draft supplies no provable figures.
    return undefined;
  }
});
const figures = computed(() => {
  if (selectedRoom.value === undefined || !placementInput.value) return [];
  return roomPlacements(placementInput.value);
});
const placementPreviews = ref<
  Record<
    string,
    {
      room: number;
      logic: number;
      object: number;
      startX: number;
      startY: number;
      x: number;
      y: number;
      command: string;
    }
  >
>({});
const visiblePlacementPreviews = computed(() =>
  Object.fromEntries(
    Object.entries(placementPreviews.value).flatMap(([key, preview]) => {
      const figure = figures.value.find(
        (figure) =>
          figure.object === preview.object &&
          figure.logic === preview.logic &&
          figure.x === preview.x &&
          figure.y === preview.y,
      );
      return preview.room === selectedRoom.value &&
        figure &&
        draftMembership.value.includes(`logic:${preview.logic}`)
        ? [
            [
              key,
              `LOGIC ${preview.logic} · ${preview.command}(o${preview.object}, ${preview.startX}, ${preview.startY}) → (${preview.x}, ${preview.y})`,
            ],
          ]
        : [];
    }),
  ),
);
function placeFigure(figure: RoomPlacement, x: number, y: number): void {
  if (!placementInput.value) return;
  try {
    const source = moveRoomPlacement(placementInput.value, figure, x, y);
    const key = `logic:${figure.logic}`;
    const previewKey = `${selectedRoom.value}:${figure.object}`;
    const previous = placementPreviews.value[previewKey];
    placementPreviews.value = {
      ...placementPreviews.value,
      [previewKey]: {
        room: selectedRoom.value!,
        logic: figure.logic,
        object: figure.object,
        startX: previous?.startX ?? figure.x!,
        startY: previous?.startY ?? figure.y!,
        x,
        y,
        command: figure.command,
      },
    };
    edit(key, source);
    if (!editor.tabs.value.includes(key)) editor.tabs.value.push(key);
    draftChanged(true);
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
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
      try {
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
      } catch {
        parts.add(change.key);
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
  const history = session.capture().history;
  editor.canUndo.value =
    state.canUndo || !!history.commits.find((commit) => commit.id === history.cursor)?.parent;
  editor.canRedo.value = state.canRedo || history.future.length > 0;
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
async function updateGame(restartRoom = true): Promise<void> {
  if (!session || actionBusy.value || writeConflict.value) return;
  if (editor.problemCount.value) {
    const first = updateProblems.value.find((entry) => entry.severity === "error");
    const typed = Object.entries(typingProblems).find(([, entries]) => entries.length);
    if (typed) openWordLogic(Number(typed[0].slice(6)), typed[1][0]!.line);
    else if (first) openPart(first.document);
    editor.open("problems");
    editor.error.value =
      typed || first
        ? `${(typed?.[1][0]?.message ?? first!.message).replace(/[.]+$/, "")}. Fix this part, then update.`
        : editor.error.value;
    return;
  }
  const room = editor.actionRoom.value;
  const roomName = editor.actionRoomName.value;
  const state = editor.launchChoices.value.find(
    (entry) => entry.id === editor.selectedLaunch.value,
  );
  const beginning = editor.selectedLaunch.value === "beginning";
  const launch = room === undefined ? undefined : { room, ...(state ? { state } : {}), beginning };
  actionBusy.value = true;
  try {
    await writes.flush();
    const changes = pendingParts.changes(snapshot.value, session.drafts().changes());
    if (!changes.length && !session.pendingRestart) {
      if (restartRoom) {
        if (debug.value?.state.epoch) await debug.value.stop();
        await runSelectedLaunch(false, launch);
      }
      editor.phonePlaytest.value = true;
      return;
    }
    const updatedParts = pendingParts.parts(snapshot.value, changes).length;
    const waiting = engine.state.modal !== null || engine.state.waitingForKey;
    if (restartRoom && debug.value?.state.epoch) await debug.value.stop();
    const result = await session.update(changes, restartRoom, restartRoom ? launch : undefined);
    updateProblems.value = result.diagnostics;
    if (!["committed", "unchanged", "draft"].includes(result.status)) {
      editor.problemCount.value = Math.max(
        1,
        result.diagnostics.filter((entry) => entry.severity === "error").length,
      );
      const first = result.diagnostics.find((entry) => entry.severity === "error");
      editor.error.value = first
        ? `${first.message.replace(/[.]+$/, "")}. Fix this part, then update.`
        : "reason" in result && typeof result.reason === "string"
          ? `${result.reason.replace(/[.]+$/, "")}. Choose Update and restart.`
          : "The game needs a fresh room. Choose Update and restart.";
      return;
    }
    await session.flush();
    await session.drafts().clear();
    optimistic.value = {};
    draftKeys = "";
    editor.updatedParts.value = updatedParts;
    editor.updateResult.value = updatedParts
      ? restartRoom
        ? beginning
          ? "Updated · started from beginning"
          : `Updated · ${roomName} restarted`
        : waiting
          ? "Updated · applies after this message"
          : "Updated · kept your place"
      : "";
    editor.problemCount.value = 0;
    editor.error.value = "";
    placementPreviews.value = {};
    editor.phonePlaytest.value = true;

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
    placementPreviews.value = {};
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
/** The room whose name is being edited in place in Parts (a fresh add starts there). */
const renamingRoom = ref<number>();
/** Right-click on the game offers the current room's actions, whichever editor is open. */
onMounted(() => {
  roomMenuArmed.value = true;
});
watch(gameRoomMenu, (open) => {
  if (!open) return;
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") gameRoomMenu.value = undefined;
  };
  window.addEventListener("keydown", keys);
  onWatcherCleanup(() => window.removeEventListener("keydown", keys));
});
function pickRoomAction(kind: "door" | "response" | "place-hero" | "play-sound"): void {
  const menu = gameRoomMenu.value;
  gameRoomMenu.value = undefined;
  if (!menu) return;
  openPart(`logic:${menu.room}`);
  guidedKind.value = kind;
}
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
    if (!editor.tabs.value.includes("words")) editor.tabs.value.push("words");
    editor.error.value = "";
    refresh();
  } catch (cause) {
    editor.error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function guidedAction(action: WorkspaceAction): Promise<void> {
  if (writeConflict.value || actionBusy.value) return;
  actionBusy.value = true;
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
      if (key) openPart(key);
    }
    if (action.kind === "add-room") {
      const logicKey = prepared.changes.find((change) => change.key.startsWith("logic:"))?.key;
      const room = logicKey ? Number(logicKey.slice(6)) : undefined;
      if (room !== undefined) renamingRoom.value = room;
      const key =
        prepared.changes.find((change) => change.key.startsWith("picture:"))?.key ?? logicKey;
      if (key) openPart(key);
    }
    if (action.kind === "boilerplate") {
      const key = prepared.changes.find((change) => change.key.startsWith("logic:"))?.key;
      if (key) openPart(key);
    }
    draftChanged(true);
    guidedKind.value = undefined;
    editor.error.value = "";
  } catch (cause) {
    editor.error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
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
async function add(group: string, option?: string): Promise<void> {
  if (writeConflict.value || actionBusy.value) return;
  if (group === "SHARED LOGIC" && option !== undefined && option !== "empty") {
    await guidedAction({ kind: "boilerplate", part: option as "menus" | "game-over" | "score" });
    return;
  }
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
  if (group === "ROOMS") {
    await guidedAction({ kind: "add-room", title: "" });
    return;
  }
  const kind = group === "PICTURES" ? "picture" : group === "VIEWS" ? "view" : "sound";
  const used = new Set(snapshot.value?.keys ?? []);
  let num = 1;
  while (used.has(`${kind}:${num}`) && num < 256) num++;
  if (num > 255) {
    editor.error.value = "This resource group is full. Edit an existing part.";
    return;
  }
  if (kind === "picture") edit(`picture:${num}`, "end\n");
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
  roomMenuArmed.value = false;
  gameRoomMenu.value = undefined;
  document.removeEventListener("focusin", trackGameFocus);
  document.removeEventListener("focusout", trackGameFocus);
  offDrafts?.();
  editor.update.value = undefined;
  editor.selectLaunch.value = undefined;
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
  document.removeEventListener("focusin", trackGameFocus);
  document.removeEventListener("focusout", trackGameFocus);
  window.removeEventListener("keydown", escape, true);
  window.removeEventListener("dragover", musicDrag, true);
  window.removeEventListener("drop", dropMusic, true);
  editor.stagePaused.value = false;
  engine.resumeEngine("stageArt");
});
</script>
<template>
  <UiDialog
    :open="!!editor.removalReview.value"
    title="Remove room"
    @update:open="
      (value) => {
        if (!value) editor.removalReview.value = undefined;
      }
    "
  >
    <p v-for="message in editor.removalReview.value?.messages" :key="message">{{ message }}</p>
    <template #footer>
      <UiButton variant="ghost" @click="editor.removalReview.value = undefined">Keep it</UiButton>
      <UiButton
        :disabled="editor.busy.value || writeConflict"
        @click="editor.step('undo', editor.removalReview.value)"
        >Remove anyway</UiButton
      >
    </template>
  </UiDialog>
  <div
    v-if="creating && phoneWidth && editor.selected.value"
    class="workspace-phone-toggle"
    role="group"
    aria-label="Picture workspace"
  >
    <UiButton
      size="sm"
      variant="ghost"
      :aria-pressed="!editor.phonePlaytest.value"
      @click="editor.phonePlaytest.value = false"
      >Edit</UiButton
    >
    <UiButton
      size="sm"
      variant="ghost"
      :aria-pressed="editor.phonePlaytest.value"
      @click="editor.phonePlaytest.value = true"
      >Playtest</UiButton
    >
  </div>
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
    :rename-room="renamingRoom"
    @open="(key, room) => openPart(key, room)"
    @add="add"
    @name-state="nameState"
    @rename="renameRoom"
    @rename-cancel="renamingRoom = undefined"
  />
  <div
    v-show="creating && editor.selected.value && !editor.focus.value && !phoneWidth"
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
  <Teleport defer to=".play-area">
    <div v-if="creating" class="workspace-game-bar" data-testid="workspace-game-bar">
      <span class="workspace-game-bar__room" data-testid="workspace-room">{{
        currentRoomLabel
      }}</span>
      <UiButton
        v-if="visitingRoom !== undefined && returnRoom !== undefined"
        size="sm"
        variant="ghost"
        :disabled="visitBusy"
        :title="visitBusy ? 'Entering the room' : ''"
        @click="backToGame()"
        >Back to Room {{ returnRoom }}</UiButton
      >
      <!-- The play lane's action button mounts here (rc4-s1-play). -->
      <span id="workspace-game-actions" class="workspace-game-bar__actions"></span>
      <button
        type="button"
        class="workspace-game-keys"
        :class="{ on: gameFocused }"
        data-testid="workspace-game-keys"
        @click="focusGameInput"
      >
        <span class="led" aria-hidden="true"></span>
        <span>{{ gameFocused ? "Keys go to the game" : "Click the game to play" }}</span>
      </button>
    </div>
  </Teleport>
  <section
    v-show="creating && editor.selected.value && (!phoneWidth || !editor.phonePlaytest.value)"
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
        @close="editor.close"
      />
      <div class="workspace-frame-controls">
        <UiIconButton
          v-if="!phoneWidth"
          icon="panel-left"
          size="sm"
          label="Side by side"
          data-testid="workspace-layout"
          :aria-pressed="editor.splitAxis.value === 'horizontal'"
          :title="editor.narrowFrame.value ? 'Side by side needs a wider window' : 'Side by side'"
          :disabled="editor.narrowFrame.value"
          @click="
            editor.setSplitAxis(editor.splitAxis.value === 'horizontal' ? 'vertical' : 'horizontal')
          "
        />
        <UiIconButton
          icon="keyboard"
          size="sm"
          label="Keyboard shortcuts"
          data-testid="workspace-keys"
          aria-keyshortcuts="?"
          aria-haspopup="dialog"
          @click="editor.keysOpen.value = true"
        />
        <UiIconButton
          icon="expand"
          size="sm"
          label="Focus"
          :title="VOCABULARY.focus.help"
          data-testid="workspace-focus"
          :aria-pressed="editor.focus.value"
          @click="editor.toggleFocus"
        />
        <ActionMenu
          label="More actions"
          test-id="workspace-more"
          icon-only
          icon="ellipsis"
          size="sm"
        >
          <button
            v-for="item in frameMenuItems"
            :key="item.id"
            type="button"
            role="menuitem"
            :data-testid="item.testId ?? `workspace-more-${item.id}`"
            :disabled="item.disabled"
            :title="item.title"
            @click="item.run()"
          >
            {{ item.label }}
          </button>
        </ActionMenu>
      </div>
    </header>
    <div v-if="contextRow" class="workspace-context" data-testid="workspace-context">
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
      <template
        v-if="editor.kind.value === 'logic' && selectedRoom !== undefined && !debug?.state.epoch"
      >
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="actionBusy || writeConflict"
          :title="
            writeConflict
              ? 'Editing is paused. Download your unsaved edits, then reload.'
              : 'Play the selected launch'
          "
          @click="updateGame()"
          >▶ Play {{ editor.actionRoomName.value }}</UiButton
        >
        <UiButton
          size="sm"
          variant="ghost"
          :disabled="actionBusy || writeConflict"
          :title="
            writeConflict
              ? 'Editing is paused. Download your unsaved edits, then reload.'
              : 'Debug (F5)'
          "
          @click="editor.debugCommand.value?.('start')"
          >Debug {{ editor.actionRoomName.value }}</UiButton
        >
      </template>
      <DebugControls
        v-if="
          debug?.state.epoch &&
          (editor.kind.value === 'logic' || debug.stopped.value || debug.state.stepping)
        "
        :debug="debug"
      />
      <UiChip v-if="editor.debugStatus.value" tone="warn" data-testid="workspace-debug-status">{{
        editor.debugStatus.value
      }}</UiChip>
      <GuidedAdd
        v-if="
          (editor.kind.value === 'logic' || editor.kind.value === 'picture') &&
          selectedRoom !== undefined &&
          snapshot
        "
        v-model:action="guidedKind"
        :room="selectedRoom"
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
      <span v-if="unusedArt" class="workspace-context__note" data-testid="workspace-unused"
        >Not used by a room yet</span
      >
      <UiButton
        v-if="unusedArt"
        size="sm"
        variant="ghost"
        :disabled="actionBusy || writeConflict"
        :title="
          writeConflict ? 'Resolve the project conflict first' : actionBusy ? 'Saving the room' : ''
        "
        @click="guidedAction({ kind: 'make-room', key: editor.selected.value! })"
        >Make it a room</UiButton
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
    </div>
    <!-- While the game pauses for editing the game bar hides with the
         play area, so Back repeats here. -->
    <div
      v-if="
        visitingRoom !== undefined &&
        returnRoom !== undefined &&
        (editor.stagePaused.value || editor.focus.value || phoneWidth)
      "
      class="workspace-stage-note"
      data-testid="workspace-visit"
    >
      <span>Visiting Room {{ visitingRoom }}</span>
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
        :active="creating && key === editor.selected.value"
        :figures="key === editor.selected.value ? figures : []"
        @place-figure="placeFigure"
        @agent-context="editor.setAgentContext(key, $event)"
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
        v-else-if="key.startsWith('view:') && (native(key) || stagedRequest(key)) && profile"
        v-show="imagePanel !== key"
        :workspace-focus="editor.focus.value || phoneWidth"
        :active="creating && key === editor.selected.value && imagePanel !== key"
        embedded
        :usage="spriteContexts[key]?.usage ?? { rooms: [], logics: [], dynamic: false }"
        :rooms="spriteContexts[key]?.rooms ?? []"
        :speed="livePreview.state?.vars[10] ?? 2"
        :cyclers="previewCyclers"
        :priority-base="livePreview.state?.priorityBase"
        :staged-reference="stagedRequest(key)?.reference"
        :lesson-session="editor.studioRequests.value[key]?.lesson"
        :view-number="Number(key.split(':')[1])"
        @agent-context="editor.setAgentContext(key, $event)"
        @use-staged="editView(key, $event)"
        :bytes="stagedRequest(key)?.bytes ?? native(key)!"
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
      <GameStateTab
        v-else-if="key === 'state'"
        :active="creating && key === editor.selected.value"
        :bindings="typeof content('bindings') === 'string' ? String(content('bindings')) : ''"
        :state="livePreview.state"
        :profile="profile"
      />
      <MessagesTab
        v-else-if="key === 'messages'"
        :container="container"
        :keys="snapshot?.keys ?? []"
        :profile="profile"
      />
      <Suspense v-else-if="key === 'problems' || key.startsWith('debug:')">
        <DebugPanel
          v-if="key === 'problems' || debug"
          :debug="debug ?? undefined"
          :problems="diagnostics"
          :view="
            key === 'problems'
              ? 'problems'
              : (key.slice(6) as 'variables' | 'watch' | 'stack' | 'breakpoints')
          "
          @reveal="revealDebug"
        />
        <template #fallback><p>Loading…</p></template>
      </Suspense>
      <p v-else class="workspace-error">Open an authored part to edit it.</p>
      <p
        v-for="(preview, object) in key === editor.selected.value && key.startsWith('picture:')
          ? visiblePlacementPreviews
          : {}"
        :key="object"
        class="workspace-placement-preview"
        data-testid="placement-preview"
      >
        {{ preview }}
      </p>
    </div>
    <button
      v-if="editor.focus.value && !phoneWidth"
      class="workspace-game-chip"
      data-testid="workspace-show-game"
      @click="editor.toggleFocus"
    >
      Game · Room {{ engine.roomMap.currentRoom.value }} · Show
    </button>
    <footer class="workspace-status" data-testid="workspace-status" aria-label="Status bar">
      <div id="workspace-status-left" class="workspace-status__left"></div>
      <button
        v-if="editor.problemCount.value"
        type="button"
        class="workspace-status__problems"
        data-testid="workspace-status-problems"
        @click="editor.open('problems')"
      >
        ⚠ {{ editor.problemCount.value }}
        {{ editor.problemCount.value === 1 ? "problem" : "problems" }}
      </button>
      <div class="workspace-status__right">{{ statusMeta }}</div>
    </footer>
  </section>
  <StudioKeySheet
    v-model:open="editor.keysOpen.value"
    :name="keySheet.name"
    :sections="keySheet.sections"
  />
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
  <div
    v-if="creating && gameRoomMenu"
    class="game-room-menu__backdrop"
    @click="gameRoomMenu = undefined"
    @contextmenu.prevent="gameRoomMenu = undefined"
  >
    <div
      class="game-room-menu"
      role="menu"
      aria-label="Room actions"
      data-testid="game-room-menu"
      :style="{ left: `${gameRoomMenu.x}px`, top: `${gameRoomMenu.y}px` }"
      @click.stop
    >
      <button type="button" role="menuitem" @click="pickRoomAction('door')">Door</button>
      <button type="button" role="menuitem" @click="pickRoomAction('response')">
        Answer a sentence
      </button>
      <button type="button" role="menuitem" @click="pickRoomAction('place-hero')">
        Place hero
      </button>
      <button type="button" role="menuitem" @click="pickRoomAction('play-sound')">
        Sound when…
      </button>
    </div>
  </div>
</template>

<style scoped>
.workspace-music-preview {
  position: absolute;
  right: var(--space-5);
  bottom: var(--space-5);
  width: min(440px, 90%);
  z-index: var(--z-popover);
}
.workspace-context:has(.workspace-debug-controls) {
  flex-wrap: wrap;
}
.workspace-context {
  position: relative;
  z-index: 1;
}
.workspace-game-bar__room {
  flex: 1;
  min-width: 0;
}
.game-room-menu__backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
}
.game-room-menu {
  position: fixed;
  display: grid;
  min-width: 180px;
  padding: var(--space-2);
  background: var(--surface-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  box-shadow: var(--shadow-popover, 0 8px 24px rgb(0 0 0 / 0.35));
}
.game-room-menu button {
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
}
.game-room-menu button:hover,
.game-room-menu button:focus-visible {
  background: var(--action-soft);
}
</style>
