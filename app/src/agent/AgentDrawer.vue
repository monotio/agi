<script setup lang="ts">
/**
 * The agent drawer: one right-side overlay over the workspace in both Create
 * arrangements, over the blank stage, and full width on phones. It never
 * takes a grid column, so the editor keeps its width. Play keeps its own
 * drawer (the aside in App.vue).
 */
import { computed, onBeforeUnmount, shallowRef, watch } from "vue";
import AgentPanel from "./AgentPanel.vue";
import { blankAgentOpen } from "./openAgent.ts";
import { emptyProject } from "../home/emptyProjectRoute.ts";
import {
  closeEmptyStageSession,
  emptyStageSession,
  openPlayableProject,
} from "../home/emptyStageSession.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useShell } from "../shell/useShell.ts";
import { useGameLibrary } from "../library/useGameLibrary.ts";
import type { ProjectSession } from "../project/projectSession.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

const engine = useEngineApi();
const shell = useShell();
const library = useGameLibrary();

const creating = computed(() => engine.state.phase === "running" && shell.mode.value === "create");
const onBlankStage = computed(() => emptyProject.value !== null);
const visible = computed(
  () =>
    (creating.value && engine.state.powerUp.open) || (onBlankStage.value && blankAgentOpen.value),
);

const blankSession = shallowRef<ProjectSession | null>(null);
const blankProfile = computed<ProfileId>(() => emptyProject.value?.library?.profile ?? "2.936");
let offSession: (() => void) | undefined;
let booting = false;

watch(
  [onBlankStage, blankAgentOpen],
  async ([stage, open]) => {
    offSession?.();
    offSession = undefined;
    if (!stage) {
      blankSession.value = null;
      closeEmptyStageSession();
      return;
    }
    if (!open || blankSession.value) return;
    const project = emptyProject.value;
    if (!project) return;
    const session = await emptyStageSession(project);
    if (!session || emptyProject.value !== project || !blankAgentOpen.value) return;
    blankSession.value = session;
    // The agent's commit can add the boot LOGIC: the project then opens in
    // the real Create workspace, like the stage's own Add a room does.
    offSession = session.subscribe(() => {
      if (booting || session.model.capture().documents()["logic:0"] === undefined) return;
      booting = true;
      void (async () => {
        await session.flush();
        if (session.saveStatus().state === "saved")
          await openPlayableProject({
            engine,
            library,
            shell,
            projectId: project.projectId,
          });
      })().finally(() => {
        booting = false;
      });
    });
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  offSession?.();
  if (onBlankStage.value) closeEmptyStageSession();
});
</script>

<template>
  <aside
    v-if="visible"
    class="agent-drawer"
    :class="{ 'agent-drawer--stage': onBlankStage }"
    aria-label="Agent"
    data-shell-keys
    data-testid="agent-drawer"
  >
    <div class="assistant-host">
      <!-- Mounted through the turn, so it sees the drawer open and close. -->
      <AgentPanel
        :session="onBlankStage ? blankSession : undefined"
        :profile-id="onBlankStage ? blankProfile : undefined"
        @close="blankAgentOpen = false"
      />
    </div>
  </aside>
</template>
