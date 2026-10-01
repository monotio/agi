<script setup lang="ts">
/**
 * The project resource editors' mount: one draft `picture:N`/`view:N`
 * document drawn in the existing Room or Sprite Studio, over the active
 * EditableProject — no engine, worker or provider. The session
 * (projectResourceEdits.ts) owns draft authority and the Keep transaction;
 * this component owns the mount, a reopen that rereads the draft, the
 * session's end — and the creative material workspace docked beside it.
 * The workspace's own Keep composes through the same candidate the drawing
 * Keep uses, so an underlay recipe, prepared VIEW and original land in the
 * same durable transaction as the drawing that carries them.
 */
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from "vue";
import type { EditableProject } from "../../project/editableProject.ts";
import RoomStudio from "../RoomStudio.vue";
import SpriteStudio from "../sprite/SpriteStudio.vue";
import CreativeWorkspace from "../creative/CreativeWorkspace.vue";
import {
  openCreativeWorkspace,
  type CreativeMaterialWorkspace,
} from "../creative/creativeWorkspace.ts";
import { documentLabel } from "../logic/logicWorkspace.ts";
import { openProjectResourceEditor, type ProjectResourceEditor } from "./projectResourceEdits.ts";

const { project, resourceKey, isCurrent } = defineProps<{
  /** The workspace the session opens on and every Keep admits through. */
  readonly project: EditableProject;
  /** The draft document to edit: `picture:N` or `view:N`. */
  readonly resourceKey: string;
  /** Refuses a Keep once the host no longer serves this workspace. */
  readonly isCurrent: () => boolean;
}>();
const emit = defineEmits<{
  close: [];
  /** The session wrote the document into the shared draft — resync the models. */
  draftChanged: [keys: readonly string[]];
  /** The durable receipt landed: update kept baselines and status. */
  kept: [key: string, content: string | Uint8Array];
  /** The document could not open as a resource — the precise reason. */
  error: [message: string];
}>();

const session = shallowRef<ProjectResourceEditor>();
const creative = shallowRef<CreativeMaterialWorkspace>();
const creativePanel = useTemplateRef("creativePanel");
/** The creative dock folds to a labelled rail when the art needs the room. */
const creativeOpen = ref(true);
/** The controller mutates in place; subscribe to re-read it. */
const creativeTick = ref(0);
let unsubscribeCreative: (() => void) | undefined;

const title = computed(() => (session.value === undefined ? "" : documentLabel(session.value.key)));

/** The active underlay, only for the picture it was prepared against. */
const underlay = computed(() => {
  const _t = creativeTick.value;
  const job = creative.value?.underlay;
  if (
    session.value?.kind !== "picture" ||
    job === null ||
    job === undefined ||
    job.resourceId !== session.value.number
  )
    return null;
  const prepared = creative.value?.underlayPreview() ?? null;
  return prepared === null ? null : { pixels: prepared.rgba, opacity: prepared.opacity };
});

function open(): void {
  session.value?.close();
  try {
    session.value = openProjectResourceEditor(project, resourceKey, {
      onDraftChanged: (keys) => emit("draftChanged", keys),
      onKept: (key, content) => emit("kept", key, content),
      isCurrent: () => session.value !== undefined && isCurrent(),
    });
    // A drawing Keep through this session seals the workspace's pending
    // creative work into the same candidate and the same transaction.
    session.value.bindCreativeKeep(creative.value?.creativeKeepProvider);
  } catch (error) {
    session.value = undefined;
    emit("error", error instanceof Error ? error.message : String(error));
    emit("close");
  }
}

/** The child's reopen: reread the draft — the authority — into a fresh session. */
function reopen(): void {
  if (session.value === undefined) return;
  open();
}

function close(): void {
  session.value?.close();
  session.value = undefined;
  emit("close");
}

/** The workspace wrote prepared bytes or kept work; keep the editor honest. */
function onCreativeChanged(keys: readonly string[]): void {
  emit("draftChanged", keys);
  if (session.value !== undefined && keys.includes(session.value.key)) reopen();
}

/** Drop anywhere on the editor surface imports the image into the workspace. */
function onDrop(event: DragEvent): void {
  const file = event.dataTransfer?.files?.[0];
  if (file === undefined || !file.type.startsWith("image/")) return;
  event.preventDefault();
  void creativePanel.value?.importFile(file);
}
/** Paste anywhere (outside text inputs) imports the clipboard image. */
function onPaste(event: ClipboardEvent): void {
  const target = event.target as Element | null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  const item = [...(event.clipboardData?.items ?? [])].find((entry) =>
    entry.type.startsWith("image/"),
  );
  const file = item?.getAsFile();
  if (file === undefined || file === null) return;
  event.preventDefault();
  void creativePanel.value?.importFile(file, "paste");
}

// The project watch runs first so the workspace exists before a session
// binds its keep composer to it.
watch(
  () => project,
  (next) => {
    unsubscribeCreative?.();
    void creative.value?.dispose();
    creative.value = openCreativeWorkspace(next);
    unsubscribeCreative = creative.value.subscribe(() => creativeTick.value++);
  },
  { immediate: true },
);
watch(() => resourceKey, open, { immediate: true });
onBeforeUnmount(() => {
  session.value?.close();
  session.value = undefined;
  unsubscribeCreative?.();
  void creative.value?.dispose();
});
</script>

<template>
  <div class="pre" @drop="onDrop" @dragover="(event) => event.preventDefault()" @paste="onPaste">
    <RoomStudio
      v-if="session?.kind === 'picture'"
      :key="session.key"
      :picture-number="session.number"
      :bytes="session.bytes"
      :authored-source="session.authoredSource"
      :profile="session.profile"
      :title
      :base-revision="session.baseRevision"
      :base-authoring="session.baseAuthoring"
      :keep="session.keepPicture"
      :files="session.files"
      :underlay
      @close="close"
      @reopen="reopen"
    />
    <SpriteStudio
      v-else-if="session?.kind === 'view'"
      :key="session.key"
      :view-number="session.number"
      :bytes="session.bytes"
      :profile="session.profile"
      :title
      :base-revision="session.baseRevision"
      :base-authoring="session.baseAuthoring"
      :keep="session.keepView"
      :files="session.files"
      :usage="session.usage"
      @close="close"
      @reopen="reopen"
    />
    <CreativeWorkspace
      v-if="session !== undefined && creative !== undefined"
      v-show="creativeOpen"
      ref="creativePanel"
      class="pre__creative"
      :workspace="creative"
      :resource-kind="session.kind"
      :resource-number="session.number"
      @changed="onCreativeChanged"
      @collapse="creativeOpen = false"
    />
    <button
      v-if="session !== undefined && creative !== undefined && !creativeOpen"
      type="button"
      class="pre__rail"
      aria-label="Open the creative panel"
      data-testid="creative-rail"
      @click="creativeOpen = true"
    >
      Creative
    </button>
  </div>
</template>

<style scoped>
/* The opened resource takes over the whole studio surface: Logic Studio
   stays mounted and suspended behind it (close and dirty guards return
   there unchanged, and dialogs draw on the top layer above this), while
   the art editor and creative dock split the real workspace area instead
   of squeezing under the source/assistant rows. Narrow screens fall back
   to the panel under the art. */
.pre {
  position: absolute;
  inset: 0;
  z-index: 7;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-0);
}
.pre > :first-child {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/* The creative tools float in their own scrollable drawer over the
   studio's inspector column (300px, between the top bar and the status
   row — the same rows the studio grid gives it), so the art stage keeps
   the full workspace width for a usable zoom while every studio control
   stays clickable. The rail folds the drawer away entirely. */
.pre__creative {
  position: absolute;
  top: 52px;
  right: 0;
  bottom: var(--control-h-touch);
  width: 300px;
  min-height: 0;
  border-left: 1px solid var(--hairline);
  box-shadow: var(--shadow-pop);
}
.pre__rail {
  position: absolute;
  top: 52px;
  right: 0;
  bottom: var(--control-h-touch);
  padding: var(--space-2) var(--space-1);
  border: 0;
  border-left: 1px solid var(--hairline);
  background: var(--surface-1);
  color: var(--ink-3);
  font: var(--weight-bold) var(--text-2xs) / 1 var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  writing-mode: vertical-rl;
  cursor: pointer;
}
.pre__rail:hover,
.pre__rail:focus-visible {
  color: var(--ink);
}
.pre__rail:focus-visible {
  outline: 2px solid var(--action-line);
}
@media (max-width: 900px) {
  .pre {
    flex-direction: column;
  }
  /* The native art keeps the larger share; the creative panel takes two
     sevenths and scrolls itself, so the editor is never squeezed to a
     sliver. */
  .pre > :first-child {
    flex: 5 1 0;
  }
  .pre__creative {
    position: static;
    flex: 2 3 0;
    width: auto;
    min-height: 120px;
    border-left: 0;
    border-top: 1px solid var(--hairline);
    box-shadow: none;
  }
  .pre__rail {
    position: static;
    align-self: stretch;
    border-left: 0;
    border-top: 1px solid var(--hairline);
    writing-mode: horizontal-tb;
  }
}
</style>
