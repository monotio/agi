<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import CreativeWorkspacePanel from "./CreativeWorkspace.vue";
import { openCreativeWorkspace, type CreativeMaterialWorkspace } from "./creativeWorkspace.ts";
import { openEditableProject } from "../../project/editableProject.ts";
import type { EditableProject } from "../../project/editableProject.ts";
import type { ProjectId } from "../../project/gameTypes.ts";
import type { StudioRequest } from "../../shell/useCreateWorkspace.ts";

/**
 * The direct studio's creative dock: "Import image…" in Room or Sprite
 * Studio opens the project's creative workspace beside it, bound to the
 * booted game's authored project — the same EditableProject authority the
 * Library editors keep through. Games without a project (imports) offer no
 * launch: nothing can keep their creative work. The whole dock — its
 * editable project machinery included — lives in this lazy Studio chunk,
 * off the Play boot path.
 */
const props = defineProps<{
  studio: StudioRequest;
  /** The running game's authored project, or null for an imported game. */
  projectId: ProjectId | null;
}>();

const dock = shallowRef<{
  project: EditableProject;
  workspace: CreativeMaterialWorkspace;
}>();
const open = ref(false);
const error = ref("");
const panel = useTemplateRef("panel");
/** The dock's controller mutates in place; subscribe to re-read it. */
const tick = ref(0);
/**
 * Lifecycle authority for an open in flight: the epoch moves on every open
 * attempt and every release/unmount, so a project open that resolves late
 * is dropped instead of adopting into a moved, released or dead host. Two
 * races this closes: an unmount during the await used to adopt anyway, and
 * two overlapping opens used to adopt two workspaces.
 */
let epoch = 0;
let disposed = false;

async function openDock(): Promise<void> {
  const projectId = props.projectId;
  if (projectId === null || disposed) return;
  error.value = "";
  if (dock.value === undefined) {
    const intent = ++epoch;
    const stagedStudio = props.studio;
    try {
      const project = await openEditableProject(projectId);
      // A release, a project/studio swap or an unmount during the open
      // abandons the result — nothing adopts it, and a request that left
      // and came back restarts under a new epoch instead of reviving this.
      if (
        disposed ||
        epoch !== intent ||
        props.projectId !== projectId ||
        props.studio !== stagedStudio
      )
        return;
      if (dock.value === undefined) {
        const workspace = openCreativeWorkspace(project);
        workspace.subscribe(() => tick.value++);
        dock.value = { project, workspace };
      }
    } catch (caught) {
      // Only the still-current intent may surface its failure — a late
      // failure from a moved or dead open must not error a successor.
      if (
        !disposed &&
        epoch === intent &&
        props.projectId === projectId &&
        props.studio === stagedStudio
      )
        error.value = caught instanceof Error ? caught.message : String(caught);
      return;
    }
  }
  open.value = true;
}
const launch = computed(() => (props.projectId !== null && !disposed ? openDock : undefined));

function release(): void {
  // Orphan any open still in flight before dropping the adoption; the
  // released workspace saves its own recovery, a successor is untouched.
  epoch++;
  open.value = false;
  error.value = "";
  const held = dock.value;
  dock.value = undefined;
  if (held !== undefined) void held.workspace.dispose();
}
watch(
  () => props.projectId,
  () => {
    // A game swap releases the dock: its recovery stays durable in
    // storage for the next open.
    if (props.projectId !== dock.value?.project.projectId) release();
  },
);
onUnmounted(() => {
  disposed = true;
  release();
});

/** The underlay the direct Room Studio draws over its art pane. */
const underlay = computed(() => {
  const _t = tick.value;
  const held = dock.value;
  if (!open.value || held === undefined) return null;
  const job = held.workspace.underlay;
  if (
    props.studio.kind !== "picture" ||
    job === null ||
    job.resourceId !== props.studio.pictureNumber
  )
    return null;
  try {
    const prepared = held.workspace.underlayPreview();
    return prepared === null ? null : { pixels: prepared.rgba, opacity: prepared.opacity };
  } catch {
    return null;
  }
});

/**
 * A gesture staged while the dock opens. The file, its provenance (drop or
 * paste) and the studio/project it was offered to are captured once at
 * accept time — no later open, gesture or callback may rewrite or consume
 * them. A single shared slot let an older open's callback read the newer
 * file or attach the older `via` to it; each accepted gesture owns an
 * immutable entry instead.
 */
interface StagedIntake {
  readonly file: File;
  readonly via: "import" | "paste";
  readonly studio: StudioRequest;
  readonly projectId: ProjectId | null;
}
const pendingIntakes: StagedIntake[] = [];
let intakeDraining = false;
/**
 * Counts accepted gestures. A drain that has to stop early (refused or dead
 * open, released dock) must not resume on its own — only a gesture that
 * arrived while it ran may restart it, so a refused open never retries
 * storage in a loop and never re-clears the published error.
 */
let intakeSeq = 0;

/**
 * Drop or paste on the studio imports into the dock — opening it first when
 * a project can serve it, so the gesture itself is the entry point.
 */
function onFile(files: FileList | undefined, via: "import" | "paste"): void {
  const file = files?.[0];
  if (file === undefined || !file.type.startsWith("image/")) return;
  if (panel.value !== null && panel.value !== undefined) {
    void panel.value.importFile(file, via);
    return;
  }
  if (launch.value === undefined || disposed) return;
  pendingIntakes.push({
    file,
    via,
    studio: props.studio,
    projectId: props.projectId,
  });
  intakeSeq++;
  void drainIntakes();
}

/**
 * Deliver staged gestures oldest-first, each with its own file and `via`,
 * to the panel of the live dock. An entry offered to a studio/project that
 * has since moved on is discarded alone — it never crosses into a successor
 * panel; entries offered to the current incarnation wait for their open and
 * land in order, so a newer paste keeps its file and origin.
 */
async function drainIntakes(): Promise<void> {
  if (intakeDraining) return;
  intakeDraining = true;
  const startedAt = intakeSeq;
  try {
    while (!disposed && pendingIntakes.length > 0) {
      const staged = pendingIntakes[0]!;
      if (staged.studio !== props.studio || staged.projectId !== props.projectId) {
        pendingIntakes.shift();
        continue;
      }
      await openDock();
      const adopted = dock.value;
      await nextTick();
      const livePanel = panel.value;
      if (disposed) return;
      // The incarnation is re-checked after both awaits: a studio or project
      // that moved while the open settled must not bind this gesture's file
      // to whatever dock now stands there. Only the stale entry drops.
      if (staged.studio !== props.studio || staged.projectId !== props.projectId) {
        pendingIntakes.shift();
        continue;
      }
      // A dead open, a released dock or an unmounted panel has no receiver:
      // the entry stays staged and can only ever bind this same incarnation.
      if (adopted === undefined || dock.value !== adopted || livePanel == null) return;
      pendingIntakes.shift();
      await livePanel.importFile(staged.file, staged.via);
    }
  } finally {
    intakeDraining = false;
    // A gesture that landed while this drain was awaiting is an explicit
    // request worth one resumption; an unchanged sequence means the stop was
    // a refused or dead open, which waits for the next gesture.
    if (intakeSeq !== startedAt && pendingIntakes.length > 0 && !disposed) void drainIntakes();
  }
}
</script>

<template>
  <div
    class="studio-host"
    @drop.prevent="onFile($event.dataTransfer?.files, 'import')"
    @paste="(event) => onFile(event.clipboardData?.files, 'paste')"
  >
    <div class="studio-host__editor">
      <slot :launch="launch" :underlay="underlay" />
    </div>
    <CreativeWorkspacePanel
      v-if="open && dock !== undefined"
      ref="panel"
      class="studio-host__creative"
      :workspace="dock.workspace"
      :resource-kind="studio.kind === 'picture' ? 'picture' : 'view'"
      :resource-number="studio.kind === 'picture' ? studio.pictureNumber : studio.viewNumber"
      @collapse="open = false"
    />
    <button
      v-else-if="dock !== undefined"
      type="button"
      class="studio-host__rail"
      aria-label="Open the creative panel"
      data-testid="creative-rail"
      @click="open = true"
    >
      Creative
    </button>
    <p v-if="error" class="studio-host__error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
/* The editor keeps a full pane, the dock scrolls itself, and a narrow
   screen stacks them. */
.studio-host {
  position: relative;
  display: flex;
  overflow: hidden;
}
.studio-host__editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.studio-host__rail {
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
.studio-host__rail:hover {
  color: var(--ink);
}
.studio-host__error {
  flex: none;
  align-self: flex-start;
  margin: var(--space-3);
  color: var(--danger);
  font-size: var(--text-xs);
}
@media (max-width: 900px) {
  .studio-host {
    flex-direction: column;
  }
  .studio-host__editor {
    flex: 5 1 0;
  }
  .studio-host__rail {
    position: static;
    align-self: stretch;
    border-left: 0;
    border-top: 1px solid var(--hairline);
    writing-mode: horizontal-tb;
  }
}
</style>
