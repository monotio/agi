<script setup lang="ts">
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import "./workspace.css";
import { onBeforeUnmount, ref } from "vue";
import { emptyStageSession, openPlayableProject } from "../../home/emptyStageSession.ts";
import { useOpenAgent } from "../../agent/openAgent.ts";
import { emptyWorkspaceChanges } from "./emptyWorkspace.ts";
import { useGameLibrary } from "../../library/useGameLibrary.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useShellBridge } from "../../shell/shellBridge.ts";
import { useShell } from "../../shell/useShell.ts";
import PartsList from "./PartsList.vue";
import { workspaceParts } from "../host/workspaceParts.ts";
import UiChip from "../../ui/UiChip.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import UiIconButton from "../../ui/UiIconButton.vue";
import UiButton from "../../ui/UiButton.vue";
import { emptyProject } from "../../home/emptyProjectRoute.ts";
import type { CachedGameData } from "../../project/gameTypes.ts";
const { project } = defineProps<{ project: CachedGameData }>();
const engine = useEngineApi();
const shell = useShell();
const bridge = useShellBridge();
const library = useGameLibrary();
const mode = ref("create");
const groups = workspaceParts({ keys: [], rooms: [], currentRoom: null });
const busy = ref(false);
const error = ref("");
let active = true;
const openAgent = useOpenAgent();
async function start(action: "room" | "boilerplate"): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const session = await emptyStageSession(project);
    if (!session || !active) return;
    const changes = emptyWorkspaceChanges(action);
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
</script>

<template>
  <section class="empty-project" aria-label="Create" data-testid="empty-project-stage">
    <header>
      <UiIconButton icon="chevron-left" label="Back to library" @click="goHome" />
      <h1>{{ project.title }}</h1>
      <UiChip tone="ok" dot :title="VOCABULARY.saved.help">Saved</UiChip>
      <UiSegmented
        v-model="mode"
        label="Mode"
        :options="[
          { value: 'play', label: 'Play', disabled: true },
          { value: 'create', label: 'Create' },
        ]"
      />
      <UiIconButton icon="undo" label="Undo" :title="VOCABULARY.undo.help" disabled />
      <UiIconButton icon="redo" label="Redo" :title="VOCABULARY.redo.help" disabled />
      <UiButton icon="sparkles" variant="ghost" :title="VOCABULARY.agent.help" @click="openAgent()"
        >Agent</UiButton
      >
      <UiIconButton icon="help" label="Help" @click="bridge.openHelp()" />
      <UiIconButton
        icon="settings"
        label="Settings"
        @click="bridge.openSettings($event.currentTarget as HTMLElement)"
      />
    </header>
    <div class="empty-workspace">
      <PartsList
        :groups="groups"
        :selected="undefined"
        :thumbnails="{}"
        :add-groups="['ROOMS']"
        @add="start('room')"
      />
      <div class="empty-stage">
        <div>
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
  </section>
</template>

<style scoped>
.empty-project {
  width: 100%;
  height: 100dvh;
  display: flex;
  flex-direction: column;
}
header {
  display: flex;
  align-items: center;
  min-height: var(--shell-bar-h);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--hairline);
  gap: var(--space-5);
}
header span {
  color: var(--ink-2);
  font-size: var(--text-sm);
}
h1 {
  margin: 0;
  font-size: var(--text-md);
  flex: 1;
}
.empty-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
}
.empty-stage {
  display: grid;
  place-items: center;
  flex: 1;
  color: var(--ink-2);
  background: var(--surface-0);
  text-align: center;
  padding: var(--space-7);
}
.empty-actions {
  display: flex;
  justify-content: center;
  gap: var(--space-3);
}
</style>
