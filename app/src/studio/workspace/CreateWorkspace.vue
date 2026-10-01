<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import "./workspace.css";
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { openContainer } from "../../../../src/container/container.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";
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
const props = defineProps<{ creating: boolean }>();
const NotesEditor = defineAsyncComponent(() => import("./NotesEditor.vue"));
const SoundPanel = defineAsyncComponent(() => import("./SoundPanel.vue"));
const GuidedAdd = defineAsyncComponent(() => import("./GuidedAdd.vue"));
const TableEditor = defineAsyncComponent(() => import("./TableEditor.vue"));
const RoomStudio = defineAsyncComponent(() => import("../RoomStudio.vue"));
const SpriteStudio = defineAsyncComponent(() => import("../sprite/SpriteStudio.vue"));
const LogicEditor = defineAsyncComponent(() => import("./LogicEditor.vue"));
const engine = useEngineApi();
const workspace = useCreateWorkspace();
const editor = useWorkspaceEditor();
function openAgent(): void {
  engine.state.powerUp.mode = "remix";
  engine.state.powerUp.open = true;
}
const snapshot = shallowRef<ProjectSnapshot>();
const historyState = shallowRef<ProjectHistoryState>();
const optimistic = shallowRef<Readonly<Record<string, ProjectContent>>>({});
let session: ProjectSession | null = null;
let unsubscribe: (() => void) | undefined;
let retired = false;
function refresh(): void {
  if (!session) return;
  const capture = session.capture();
  snapshot.value = capture.snapshot;
  historyState.value = capture.history;
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
      run: () => editor.open(row.key),
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
    dirty: false,
    missing: !snapshot.value?.keys.includes(key),
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
function native(key: string): Uint8Array | undefined {
  const [kind, num] = key.split(":");
  if (kind !== "picture" && kind !== "view" && kind !== "sound") return undefined;
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
const writes = createWorkspaceWrites({
  async write(key, value) {
    if (retired || session === null || session !== engine.getProjectSession())
      throw new Error("Open this project again to retry the change.");
    const origin = (
      key === "notes" ? "logic" : (key.split(":")[0] ?? "logic")
    ) as ProjectEditOrigin;
    const result = await engine.submitProjectEdit({
      changes: [{ key, content: value }],
      origin,
      label: `Changed ${key === "inventory" ? "OBJECTS" : key === "words" ? "WORDS" : key.replace(":", " ").toUpperCase()}`,
      author: "creator",
    });
    if (!["committed", "diagnostics", "unchanged"].includes(result.status))
      throw new Error("This change needs a fresh room. Return to the room and retry.");
    editor.error.value = "";
    refresh();
  },
  changed(drafts, busy) {
    optimistic.value = drafts;
    editor.busy.value = busy;
    if (busy) editor.save.value = "Saving…";
    else refresh();
  },
  error(cause) {
    editor.error.value = String(cause instanceof Error ? cause.message : cause);
  },
});
editor.flush.value = async () => {
  await writes.flush();
  await session?.flush();
};
editor.retry.value = async () => {
  await writes.retry();
  await session?.retry();
  await session?.flush();
};
function edit(key: string, value: ProjectContent): void {
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
  writes.edit(key, value);
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
async function guidedAction(action: WorkspaceAction): Promise<void> {
  await writes.flush();
  const capture = session?.model.capture();
  if (!capture) return;
  editor.busy.value = true;
  try {
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
    if (action.kind === "add-room") {
      const key = prepared.changes.find((change) => change.key.startsWith("logic:"))?.key;
      if (key) editor.open(key);
    }
    editor.error.value = "";
  } catch (cause) {
    editor.error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    editor.busy.value = false;
    refresh();
  }
}
const versionName = ref("");
async function restore(id: string): Promise<void> {
  await session?.restore(id);
}
async function nameVersion(): Promise<void> {
  if (versionName.value.trim()) {
    await session?.tag(versionName.value.trim());
    versionName.value = "";
  }
}
async function add(group: string): Promise<void> {
  if (group === "WORDS" || group === "OBJECTS") {
    const key = group === "WORDS" ? "words" : "inventory";
    const source = text(key);
    const rows = typeof source === "string" ? (JSON.parse(source) as unknown[]) : [];
    rows.push(group === "WORDS" ? ["word", 1] : { name: "Object", startingRoom: 255 });
    edit(key, JSON.stringify(rows));
    editor.open(key);
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
    editor.open(`logic:${num}`);
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
    editor.open(`logic:${engine.roomMap.currentRoom.value ?? 0}`);
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
  } else edit(`sound:${num}`, "[]");
  editor.open(`${kind}:${num}`);
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
        'dialog[open], [role="menu"], .suggest-widget.visible, .monaco-hover, .workspace-guided__form',
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
onBeforeUnmount(() => {
  retired = true;
  writes.dispose();
  editor.flush.value = undefined;
  editor.retry.value = undefined;
  unsubscribe?.();
  window.removeEventListener("keydown", escape, true);
  editor.gameHost.value = null;
  editor.pictureLive.value = false;
});
</script>
<template>
  <PartsList
    v-show="creating && !workspace.collapsed.left && !editor.focus.value"
    :groups="groups"
    :selected="editor.selected.value"
    :thumbnails="thumbnails"
    :views="viewThumbnails"
    :profile="profile"
    @open="editor.open"
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
        @select="editor.open"
        @close="editor.close"
      />
      <GuidedAdd
        v-if="editor.kind.value === 'logic'"
        v-model:action="guidedKind"
        :room="Number(editor.selected.value?.split(':')[1] ?? 0)"
        :busy="editor.busy.value"
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
    <p v-if="editor.error.value" class="workspace-error" role="alert">
      {{ editor.error.value }} <UiButton @click="editor.retry.value?.()">Retry</UiButton>
    </p>
    <div
      v-for="key in editor.retained.value"
      :key="key"
      v-show="key === editor.selected.value"
      class="workspace-editor__surface"
    >
      <RoomStudio
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
        :picture-number="Number(key.split(':')[1])"
        :bytes="native(key)!"
        :authored-source="
          typeof snapshot?.read(key)?.content === 'string'
            ? (snapshot.read(key)!.content as string)
            : undefined
        "
        :profile="profile"
        :title="tabRows.find((tab) => tab.key === key)?.label ?? key"
        :base-revision="revision"
        :files="files"
        @edit="edit(key, $event)"
      />
      <SpriteStudio
        v-else-if="key.startsWith('view:') && native(key) && profile"
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
        v-else-if="key.startsWith('logic:') && text(key) !== undefined && snapshot"
        :document-key="key"
        :source="text(key)!"
        :snapshot="snapshot"
        :profile-id="profile.id"
        :active="creating && key === editor.selected.value"
        @edit="edit(key, $event)"
        @selection="editor.setAgentContext(key, $event)"
      />
      <TableEditor
        v-else-if="(key === 'words' || key === 'inventory') && text(key) !== undefined"
        :kind="key"
        :source="text(key)!"
        @edit="edit(key, $event)"
      />
      <SoundPanel
        v-else-if="key.startsWith('sound:') && native(key)"
        :document-key="key"
        :bytes="native(key)!"
        :profile-id="profile.id"
        :active="creating && key === editor.selected.value"
        @edit="edit(key, $event)"
      />
      <NotesEditor
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
      Game running · Show
    </button>
  </section>
  <section
    v-if="creating && editor.panel.value"
    class="workspace-problems"
    aria-label="Problems"
    data-testid="workspace-problems"
  >
    <header>
      <h2>Problems</h2>
      <UiButton size="sm" variant="ghost" @click="editor.panel.value = false">×</UiButton>
    </header>
    <p v-if="diagnostics.length === 0">Everything builds.</p>
    <p v-for="(entry, index) in diagnostics" :key="index">{{ entry.message }}</p>
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
    <p>
      Every version of your game. Restore brings back an earlier one; later versions stay in
      History.
    </p>
    <form @submit.prevent="nameVersion">
      <input v-model="versionName" aria-label="Version name" /><UiButton size="sm" type="submit"
        >Name this version</UiButton
      >
    </form>
    <div
      v-for="commit in [...(historyState?.commits ?? [])].reverse()"
      :key="commit.id"
      class="workspace-history__row"
    >
      <span>{{ commit.label }}</span
      ><UiButton
        size="sm"
        :disabled="commit.id === historyState?.cursor || editor.busy.value"
        @click="restore(commit.id)"
        >Restore</UiButton
      >
    </div>
  </aside>
</template>
