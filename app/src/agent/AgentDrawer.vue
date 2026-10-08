<script setup lang="ts">
/**
 * The agent drawer: one right-side overlay over the workspace in both Create
 * arrangements, over the blank stage, and full width on phones. It never
 * takes a grid column, so the editor keeps its width. Its one panel remains
 * mounted across mode changes and closing to preserve the conversation draft.
 */
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue";
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
import type { CachedGameData } from "../project/gameTypes.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

// The conversation loads on demand in either mode; its resource previews stay lazy.
const AgentPanel = defineAsyncComponent(() => import("./AgentPanel.vue"));
const engine = useEngineApi();
const shell = useShell();
const library = useGameLibrary();

const onBlankStage = computed(() => emptyProject.value !== null);
const visible = computed(
  () =>
    (engine.state.phase === "running" && engine.state.powerUp.open) ||
    (onBlankStage.value && blankAgentOpen.value),
);
const mounted = ref(false);
const focusRequest = shallowRef<{ readonly origin: Element | null }>();
watch(
  visible,
  (open) => {
    if (open) {
      focusRequest.value = { origin: document.activeElement };
      mounted.value = true;
    }
  },
  { immediate: true },
);
watch(
  () => engine.state.phase,
  (phase) => {
    if (phase === "idle" && !onBlankStage.value) mounted.value = false;
  },
);

const blankSession = shallowRef<ProjectSession | null>(null);
const blankProfile = computed<ProfileId>(() => emptyProject.value?.library?.profile ?? "2.936");
let offSession: (() => void) | undefined;
let blankOwner: CachedGameData | null = null;
let loadingSession: CachedGameData | null = null;
let bootingSession: ProjectSession | null = null;

watch(
  [emptyProject, blankAgentOpen],
  async ([project, open]) => {
    if (project !== blankOwner) {
      offSession?.();
      offSession = undefined;
      blankSession.value = null;
      closeEmptyStageSession();
      blankOwner = project;
    }
    if (!project || !open || blankSession.value || loadingSession === project) return;
    loadingSession = project;
    const session = await emptyStageSession(project).finally(() => {
      if (loadingSession === project) loadingSession = null;
    });
    if (!session || emptyProject.value !== project) return;
    blankSession.value = session;
    // The agent's commit can add the boot LOGIC: the project then opens in
    // the real Create workspace, like the stage's own Add a room does.
    offSession = session.subscribe(() => {
      const isCurrent = () => emptyProject.value === project && blankSession.value === session;
      if (
        !isCurrent() ||
        bootingSession === session ||
        session.model.capture().documents()["logic:0"] === undefined
      )
        return;
      bootingSession = session;
      void (async () => {
        try {
          await session.flush();
        } catch {
          // The retained session exposes its storage failure and retry action.
          return;
        }
        if (isCurrent() && session.saveStatus().state === "saved")
          await openPlayableProject({
            engine,
            library,
            shell,
            projectId: project.projectId,
          });
      })().finally(() => {
        if (bootingSession === session) bootingSession = null;
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
    v-if="mounted"
    v-show="visible"
    class="agent-drawer"
    :class="{
      'agent-drawer--stage': onBlankStage,
      'agent-drawer--play': !onBlankStage && shell.mode.value === 'play',
      'shell-side': !onBlankStage && shell.mode.value === 'play',
    }"
    aria-label="Agent"
    data-shell-keys
    data-testid="agent-drawer"
  >
    <div class="assistant-host">
      <!-- Mounted through the turn, so it sees the drawer open and close. -->
      <AgentPanel
        :focus-request
        :session="onBlankStage ? blankSession : undefined"
        :profile-id="onBlankStage ? blankProfile : undefined"
        @close="blankAgentOpen = false"
      />
    </div>
  </aside>
</template>
