<script setup lang="ts">
/**
 * A stored game with no start-up LOGIC yet. It cannot run, so Create shows
 * its frame around an empty game screen: the same bar, parts list, game
 * area and editor side as a game with rooms, with the first steps inside
 * the screen.
 */
import "./workspace.css";
import { onBeforeUnmount, ref } from "vue";
import { emptyStageSession, openPlayableProject } from "../../home/emptyStageSession.ts";
import { useOpenAgent } from "../../agent/openAgent.ts";
import { emptyWorkspaceChanges } from "./emptyWorkspace.ts";
import { useGameLibrary } from "../../library/useGameLibrary.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useShellBridge } from "../../shell/shellBridge.ts";
import { useShell } from "../../shell/useShell.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import PlayBar from "../../shell/PlayBar.vue";
import PartsList from "./PartsList.vue";
import { workspaceParts } from "../host/workspaceParts.ts";
import UiButton from "../../ui/UiButton.vue";
import { emptyProject } from "../../home/emptyProjectRoute.ts";
import type { CachedGameData } from "../../project/gameTypes.ts";
const { project } = defineProps<{ project: CachedGameData }>();
const engine = useEngineApi();
const shell = useShell();
const bridge = useShellBridge();
const library = useGameLibrary();
const editor = useWorkspaceEditor();
const groups = workspaceParts({ keys: [], rooms: [], currentRoom: null });
const busy = ref(false);
const error = ref("");
let active = true;
const openAgent = useOpenAgent();
/** The tab each section's + lands on once the first room exists. */
const OPEN_TAB: Record<string, string> = {
  "GAME STATE": "state",
  "SHARED LOGIC": "logic:0",
  PICTURES: "picture:1",
  OBJECTS: "inventory",
  WORDS: "words",
};
async function start(
  action: "room" | "boilerplate",
  openKey?: string,
  named?: { kind: "flag" | "variable"; num: number; name: string },
): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const openTab = openKey ?? (action === "room" ? "picture:1" : undefined);
    if (openTab) {
      localStorage.setItem(
        `monotio_agi.workspaceTabs.${project.projectId}`,
        JSON.stringify({ tabs: [openTab], selected: openTab }),
      );
    }
    if (action === "room")
      localStorage.setItem(`monotio_agi.workspaceRename.${project.projectId}`, "1");
    const session = await emptyStageSession(project);
    if (!session || !active) return;
    const changes = [...emptyWorkspaceChanges(action)];
    if (named) {
      const at = changes.findIndex((change) => change.key === "bindings");
      const content = changes[at]?.content;
      if (at >= 0 && typeof content === "string") {
        const bindings = JSON.parse(content) as Record<string, unknown>;
        bindings[named.name] = { kind: named.kind, num: named.num };
        changes[at] = { key: "bindings", content: JSON.stringify(bindings) };
      }
    }
    const result = await session.submit({
      proposal: session.model.propose(session.model.capture(), "Added a room", changes),
      label: action === "room" ? "Added a room" : "Used Boilerplate",
      origin: "template",
      author: "creator",
    });
    if (result.status !== "committed")
      throw new Error("The first room could not build. Retry to add it.");
    await session.flush();
    if (session.saveStatus().state !== "saved") throw new Error(session.saveStatus().message);
    await openPlayableProject({ engine, library, shell, projectId: project.projectId });
  } catch (cause) {
    error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => {
  active = false;
});
function goHome(): void {
  emptyProject.value = null;
  history.pushState(null, "", location.pathname + location.search);
}
/** The splitter moves the shared split, so the first room opens at the same size. */
function resize(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement;
  const area = target.parentElement!.getBoundingClientRect();
  const left =
    target.parentElement!.querySelector(".parts-list")?.getBoundingClientRect().width ?? 0;
  target.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) =>
    editor.resize(
      editor.stackedLayout.value
        ? (100 * (e.clientY - area.top)) / area.height
        : (100 * (e.clientX - area.left - left)) / (area.width - left),
    );
  const stop = () => target.removeEventListener("pointermove", move);
  target.addEventListener("pointermove", move);
  target.addEventListener("lostpointercapture", stop, { once: true });
}
</script>

<template>
  <section class="empty-project" aria-label="Create" data-testid="empty-project-stage">
    <PlayBar
      :blank="project.title"
      :settings-open="false"
      @exit="goHome"
      @agent="openAgent()"
      @help-guide="bridge.openHelp()"
      @keyboard-shortcuts="bridge.openHelp('shortcuts')"
      @settings="bridge.openSettings"
    />
    <div
      class="shell-body shell-body--workspace shell-body--create"
      :class="{
        'shell-body--stacked': editor.stackedLayout.value,
        'shell-body--no-editor': editor.phoneFrame.value,
      }"
      :style="{
        '--workspace-game': `minmax(0, ${editor.effectiveSplit.value}fr)`,
        '--workspace-edit': `minmax(0, ${100 - editor.effectiveSplit.value}fr)`,
      }"
    >
      <PartsList
        :class="{ 'parts-list--open': editor.partsOpen.value }"
        :groups="groups"
        :selected="undefined"
        :thumbnails="{}"
        @open="(key) => start('room', key)"
        @add="(label) => start('room', OPEN_TAB[label])"
        @name-state="(kind, num, name) => start('room', 'state', { kind, num, name })"
      />
      <div class="play-area">
        <div class="stage">
          <div class="screen">
            <div class="empty-start">
              <p role="status">Nothing to play yet.</p>
              <div class="empty-actions">
                <UiButton
                  variant="primary"
                  :disabled="busy"
                  data-testid="empty-add-room"
                  @click="start('room')"
                  >Add a room</UiButton
                ><UiButton
                  :disabled="busy"
                  data-testid="empty-boilerplate"
                  @click="start('boilerplate')"
                  >Use Boilerplate</UiButton
                >
              </div>
              <p v-if="error" role="alert">{{ error }}</p>
            </div>
          </div>
        </div>
        <div class="workspace-game-bar"></div>
      </div>
      <template v-if="!editor.phoneFrame.value">
        <div
          class="workspace-splitter"
          role="separator"
          :aria-label="editor.stackedLayout.value ? 'Editor height' : 'Editor width'"
          :aria-orientation="editor.stackedLayout.value ? 'horizontal' : 'vertical'"
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
        <section class="workspace-editor" aria-label="Editor">
          <header class="workspace-editor__header"></header>
          <div class="workspace-editor__surface"></div>
          <footer class="workspace-status"></footer>
        </section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.empty-project {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: var(--layout-height, 100dvh);
}
.empty-project > .shell-body {
  display: grid;
  flex: 1;
  min-height: 0;
}
/* The game screen's place and size, as PlayArea.vue fits it; nothing runs on it. */
.play-area {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.stage {
  container-type: size;
  position: relative;
  display: grid;
  place-items: center;
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.screen {
  display: grid;
  place-items: center;
  width: min(100cqw, 100cqh * var(--game-ratio));
  aspect-ratio: var(--game-aspect);
  box-sizing: border-box;
  padding: var(--space-4);
  overflow: auto;
  background: var(--agi-0);
  box-shadow: 0 0 0 1px var(--hairline);
  color: var(--ink-2);
  text-align: center;
  font: var(--text-sm) / var(--leading) var(--font-sans);
}
.empty-start p {
  margin: 0 0 var(--space-4);
}
.empty-start p[role="alert"] {
  margin: var(--space-4) 0 0;
  color: var(--warn);
}
.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-3);
}
/* Phones hold the screen at the top with a gutter, as a phone game shows it. */
@media (max-width: 600px) {
  .stage {
    align-items: start;
    padding: var(--space-3) var(--space-5) 0;
  }
}
/* The bar under the screen keeps its height with nothing in it yet. */
.workspace-game-bar {
  min-height: 35px;
  box-sizing: border-box;
}
</style>
