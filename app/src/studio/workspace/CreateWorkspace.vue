<script setup lang="ts">
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
import type {
  ProjectEditOrigin,
  ProjectHistoryState,
} from "../../../../src/authoring/projectHistoryData.ts";
import type { ProjectSession } from "../../project/projectSession.ts";
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
import { createWorkspaceWrites } from "./workspaceWrites.ts";
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
const GuidedAdd = defineAsyncComponent(() => import("./GuidedAdd.vue"));
const WordsEditor = defineAsyncComponent(() => import("./WordsEditor.vue"));
const TableEditor = defineAsyncComponent(() => import("./TableEditor.vue"));
const RoomStudio = defineAsyncComponent(() => import("../RoomStudio.vue"));
const SpriteStudio = defineAsyncComponent(() => import("../sprite/SpriteStudio.vue"));
const LogicEditor = defineAsyncComponent(() => import("./LogicEditor.vue"));
const DebugPanel = defineAsyncComponent(() => import("./WorkspaceDebugPanel.vue"));
const DebugControls = defineAsyncComponent(() => import("./WorkspaceDebugControls.vue"));
const engine = useEngineApi();
const workspace = useCreateWorkspace();
const editor = useWorkspaceEditor();
function openPart(key: string, pinned = false): void {
  if (window.innerWidth <= 1280 && engine.state.powerUp.open) engine.closePowerUp();
  editor.open(key, pinned);
  if (window.innerWidth <= 600) {
    editor.focus.value = true;
    editor.partsOpen.value = false;
  }
}
function openAgent(): void {
  engine.state.powerUp.mode = "remix";
  engine.state.powerUp.open = true;
}
const snapshot = shallowRef<ProjectSnapshot>();
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
const optimistic = shallowRef<Readonly<Record<string, ProjectContent>>>({});
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
  if (capture.snapshot.keys.includes("images")) {
    void import("../../../../src/creative/imageOperations.ts").then(({ imageTraceUnderlay }) => {
      if (ticket !== imageRefresh || retired) return;
      const documents = capture.snapshot.documents();
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
  writeConflict.value = capture.save.state === "conflict";
  editor.readOnly.value = writeConflict.value;
  editor.pendingChanges.value =
    session.pendingChanges || editor.busy.value || Object.keys(optimistic.value).length > 0;
  if (writeConflict.value) editor.error.value = "";
  historyState.value = capture.history;
  editor.pendingAdmission.value = capture.pendingAdmission;
  editor.save.value =
    capture.save.state === "saved"
      ? editor.busy.value
        ? "Saving…"
        : editor.error.value && Object.keys(optimistic.value).length > 0
          ? "Could not save. Retry"
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
    if (session) unsubscribe = session.subscribe(refresh);
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
  const keys = snapshot.value?.keys ?? [];
  const scan = engine.roomMap.resources.value;
  let plan: Record<string, { title?: string }> = {};
  try {
    const world = content("world");
    if (typeof world === "string") plan = (JSON.parse(world) as { rooms: typeof plan }).rooms;
  } catch {
    /* Native room relationships remain available. */
  }
  const roomIds = new Set([
    ...engine.roomMap.graph.value.nodes.map((node) => node.room),
    ...[...scan.scans.values()].flatMap((logic) => logic.targets.map((target) => target.to)),
    ...Object.keys(plan).map(Number),
  ]);
  const rooms = [...roomIds]
    .filter((room) => room > 0 && room < 255)
    .map((room) => {
      const node = engine.roomMap.graph.value.nodes.find((node) => node.room === room);
      const pictures = roomPictureUse(room, {
        scans: scan.scans,
        shared: scan.shared,
        pictures: scan.picture,
      })
        .pictures.filter((use) => use.exists)
        .map((use) => use.picture);
      const logic = snapshot.value?.lastAdmissibleBuild?.documents()[`logic:${room}`];
      const bound = content("bindings");
      if (pictures.length === 0 && typeof logic === "string") {
        const picture = roomPictureNumber(logic, typeof bound === "string" ? bound : undefined);
        if (picture !== null) pictures.push(picture);
      }
      const art = pictures[0] === undefined ? undefined : content(`picture:${pictures[0]}`);
      const heading = typeof art === "string" ? /^# ([^:\n]+):/.exec(art)?.[1] : undefined;
      const title = plan[String(room)]?.title || heading || node?.title;
      return { room, ...(title ? { title } : {}), pictures };
    });
  const names: Record<string, string> = {};
  const bound = content("bindings");
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
watch(
  [editor.selected, groups, engine.roomMap.currentRoom],
  ([selected, rows, room]) => {
    editor.pictureLive.value =
      !!selected?.startsWith("picture:") &&
      rows.some((group) => group.entries.some((row) => row.key === selected && row.room === room));
  },
  { immediate: true },
);
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
    dirty:
      optimistic.value[key] !== undefined &&
      (snapshot.value?.keys.includes(key) || optimistic.value[key]!.length > 0),
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
const nativeCache = new Map<string, Uint8Array>();
const viewThumbnails = computed(() =>
  Object.fromEntries(
    (snapshot.value?.keys ?? [])
      .filter((key) => key.startsWith("view:"))
      .map((key) => [key, native(key)!]),
  ),
);
const gameHosts = new Map<string, HTMLElement>();
function gameHost(key: string, host: HTMLElement): void {
  gameHosts.set(key, host);
  if (editor.selected.value === key) editor.gameHost.value = host;
}
watch(editor.selected, (key) => {
  editor.gameHost.value = key ? (gameHosts.get(key) ?? null) : null;
});
const pendingResources = computed(() => {
  const resources: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(optimistic.value)) {
    if (value instanceof Uint8Array) resources[key] = value;
    else if (key.startsWith("picture:")) {
      try {
        resources[key] = compilePictureSource(value, { profile: profile.value }).bytes;
      } catch {
        /* The last working image remains available beside invalid source. */
      }
    }
  }
  return resources;
});
function native(key: string): Uint8Array | undefined {
  const [kind, num] = key.split(":");
  if (kind !== "picture" && kind !== "view" && kind !== "sound") return undefined;
  const pending = pendingResources.value[key];
  if (pending) return pending;
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
  const tempo = value instanceof Uint8Array ? soundTempos.get(value) : undefined;
  if (key.startsWith("sound:") && value instanceof Uint8Array && tempo !== undefined) {
    return soundProjectChanges(key, value, tempo, typeof music === "string" ? music : undefined);
  }
  return [{ key, content: value }];
}
const actionBusy = ref(false);
const writerBusy = ref(false);
watch(
  [actionBusy, writerBusy],
  ([action, writer]) => {
    editor.busy.value = action || writer;
  },
  { flush: "sync" },
);
const writes = createWorkspaceWrites({
  async durable() {
    await session?.flush();
  },
  async write(key, value) {
    if (retired || session === null || session !== engine.getProjectSession())
      throw new Error("Open this project again to retry the change.");
    const origin = (
      key === "notes" ? "logic" : (key.split(":")[0] ?? "logic")
    ) as ProjectEditOrigin;
    const changes = editorChanges(key, value);
    const result = await engine.submitProjectEdit({
      changes,
      origin,
      label: `Changed ${key === "inventory" ? "OBJECTS" : key === "words" ? "WORDS" : key.replace(":", " ").toUpperCase()}`,
      author: "creator",
    });
    if (!["committed", "diagnostics", "unchanged", "restartRequired"].includes(result.status))
      throw new Error("This change needs a fresh room. Return to the room and retry.");
    editor.error.value = "";
    refresh();
  },
  changed(drafts, busy) {
    optimistic.value = drafts;
    writerBusy.value = busy;
    editor.pendingChanges.value =
      busy || (session?.pendingChanges ?? false) || Object.keys(drafts).length > 0;
    if (editor.busy.value) editor.save.value = "Saving…";
    else refresh();
  },
  error(cause) {
    editor.error.value = String(cause instanceof Error ? cause.message : cause);
  },
});
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
editor.discard.value = () => {
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
  writes.edit(key, value);
}
function editSound(key: string, bytes: Uint8Array, tempo: number): void {
  if (writeConflict.value) return;
  soundTempos.set(bytes, tempo);
  if (soundTempo(key) === tempo) edit(key, bytes);
  else {
    editor.error.value = "";
    writes.edit(key, bytes);
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
  const value = content(key);
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) return undefined;
  if (key === "words")
    return JSON.stringify(parseWordsTok(value).map(({ word, id }) => [word, id]));
  if (key === "inventory") return JSON.stringify(readInventoryObjects(value, profile.value));
  if (key.startsWith("logic:")) {
    const source = text("words");
    const words = source ? (JSON.parse(source) as [string, number][]) : [];
    return derivedLogicSource(value, profile.value.id, words).source;
  }
  return undefined;
}
const diagnostics = computed(() => {
  void snapshot.value;
  return session?.capture().diagnostics ?? [];
});
const guidedKind = ref<WorkspaceAction["kind"]>();
const guidedCommand = ref("");
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
    const captured = session?.model.capture();
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
    if (!["committed", "unchanged"].includes(result.status))
      throw new Error("Check Problems before changing this meaning.");
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
  try {
    await writes.flush();
    const capture = session?.model.capture();
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
    if (!["committed", "unchanged"].includes(result.status))
      throw new Error("The action could not build. Check Problems and retry.");
    if (action.kind === "response") {
      const entry = engine.playerSentences.value.find(
        (row) => row.room === action.room && row.text === action.command,
      );
      if (entry) engine.resolvePlayerSentence(entry);
    }
    if (action.kind === "add-room") {
      const key = prepared.changes.find((change) => change.key.startsWith("logic:"))?.key;
      if (key) openPart(key);
    }
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
function resize(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
  const area = target.parentElement!.getBoundingClientRect();
  const left =
    target.parentElement!.querySelector(".parts-list")?.getBoundingClientRect().width ?? 0;
  const move = (e: PointerEvent) =>
    editor.resize((100 * (e.clientX - area.left - left)) / (area.width - left));
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
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
});
</script>
<template>
  <PartsList
    :read-only="writeConflict || actionBusy"
    :class="{ 'parts-list--open': editor.partsOpen.value }"
    v-show="
      creating && !editor.focus.value && (!workspace.collapsed.left || editor.partsOpen.value)
    "
    :groups="groups"
    :selected="editor.selected.value"
    :thumbnails="thumbnails"
    :views="viewThumbnails"
    :profile="profile"
    @open="openPart"
    @pin="(key) => openPart(key, true)"
    @add="add"
  />
  <div
    v-show="creating && editor.selected.value && !editor.focus.value"
    class="workspace-splitter"
    role="separator"
    aria-label="Editor width"
    aria-orientation="vertical"
    tabindex="0"
    :aria-valuenow="editor.split.value"
    aria-valuemin="25"
    aria-valuemax="75"
    @pointerdown="resize"
    @keydown.left.prevent="editor.resize(editor.split.value - 2)"
    @keydown.right.prevent="editor.resize(editor.split.value + 2)"
  ></div>
  <section
    v-show="creating && editor.selected.value"
    class="workspace-editor"
    :class="{ 'workspace-editor--focus': editor.focus.value }"
    data-testid="workspace-editor"
    data-shell-keys
  >
    <header class="workspace-editor__header">
      <ProjectTabs
        :tabs="tabRows"
        :selected-key="editor.selected.value ?? null"
        @select="(key) => openPart(key)"
        @pin="editor.pin"
        @close="editor.close"
      />
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
      <UiButton
        v-if="editor.kind.value === 'logic' && !debug?.state.epoch"
        size="sm"
        variant="ghost"
        :disabled="debug?.state.busy"
        data-testid="debug-start"
        title="Run or continue (F5 in the editor)"
        @click="editor.debugCommand.value?.('start')"
        >Run</UiButton
      >
      <DebugControls v-if="debug?.state.epoch" :debug="debug" />
      <GuidedAdd
        v-if="editor.kind.value === 'logic'"
        v-model:action="guidedKind"
        :room="Number(editor.selected.value?.split(':')[1] ?? 0)"
        :initial-command="guidedCommand"
        :busy="editor.busy.value || writeConflict"
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
        @changed="refresh"
      />
    </header>
    <p
      v-if="
        diagnostics.some((entry) => entry.severity === 'error') && editor.kind.value === 'logic'
      "
      class="workspace-error"
      data-testid="workspace-last-good"
    >
      The game keeps running the last working version. Fix the errors below.
    </p>
    <p
      v-if="editor.error.value && !engine.state.leaving && !editor.exitRefusal.value"
      class="workspace-error"
      role="alert"
    >
      {{ editor.error.value }} <UiButton v-if="!writeConflict" @click="retrySave">Retry</UiButton>
    </p>
    <div
      v-for="key in editor.retained.value"
      :key="key"
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
        @changed="refresh"
      />
      <RoomStudio
        :read-only="writeConflict || actionBusy"
        v-if="key.startsWith('picture:') && native(key) && profile"
        :live-game="
          creating &&
          key === editor.selected.value &&
          editor.pictureLive.value &&
          !editor.focus.value
        "
        :workspace-focus="editor.focus.value"
        embedded
        @game-host="gameHost(key, $event)"
        @agent-context="editor.setAgentContext(key, $event)"
        @agent-ask="openAgent"
        :underlay="traceUnderlays[key] ?? null"
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
        v-else-if="key.startsWith('view:') && native(key) && profile"
        v-show="imagePanel !== key"
        :workspace-focus="editor.focus.value"
        embedded
        :view-number="Number(key.split(':')[1])"
        @agent-context="editor.setAgentContext(key, $event)"
        @agent-ask="openAgent"
        :bytes="native(key)!"
        :profile="profile"
        :base-revision="revision"
        :files="files"
        @edit="edit(key, $event)"
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
        :snapshot="snapshot"
        :profile-id="profile.id"
        :active="creating && key === editor.selected.value"
        @edit="edit(key, $event)"
        @selection="editor.setAgentContext(key, $event)"
      />
      <WordsEditor
        :read-only="writeConflict || actionBusy"
        v-else-if="key === 'words' && text(key) !== undefined && snapshot"
        :source="text(key)!"
        :documents="snapshot.documents()"
        :profile="profile"
        :room="engine.roomMap.currentRoom.value ?? 0"
        :active="creating && key === editor.selected.value"
        @edit="edit(key, $event)"
        @move="wordChange"
        @remove="wordChange({ remove: $event })"
        @open-logic="openWordLogic"
        @response="wordResponse"
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
        :profile-id="profile.id"
        :active="creating && key === editor.selected.value"
        @edit="(bytes, tempo) => editSound(key, bytes, tempo)"
        :import-file="musicDropTarget === key ? musicDrop : undefined"
        @imported="musicDrop = undefined"
        @add="addImportedSound"
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
      {{ editor.debugStatus.value || "Game running" }} · Show
    </button>
  </section>
  <section
    v-if="creating && editor.panel.value"
    class="workspace-problems"
    aria-label="Problems"
    data-testid="workspace-problems"
  >
    <DebugPanel
      v-if="debug"
      :debug="debug"
      :problems="diagnostics"
      @close="editor.panel.value = false"
      @reveal="revealDebug"
    />
    <template v-else>
      <header>
        <h2>Problems</h2>
        <UiButton size="sm" variant="ghost" @click="editor.panel.value = false">×</UiButton>
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
  >
    <header>
      <h2>History</h2>
      <UiButton size="sm" variant="ghost" @click="editor.history.value = false">×</UiButton>
    </header>
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
</style>
