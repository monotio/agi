<script setup lang="ts">
/**
 * The Logic Studio debugger dock: one isolated Test session over the real
 * draft. The execution strip drives the workspace view model — Test,
 * Continue, Pause, statement/call steps, one cycle, run-to-cursor, restart,
 * end — while the game preview composites the run's own frame stream and
 * the inspector reads the worker's published state. A live game parks under
 * the injected pause lease for the run's lifetime; ending the test releases
 * only that hold.
 *
 * Keyboard: F5 continue (pause while running — it also bubbles up from an
 * open prompt dialog, which is the only route to a held stop while a host
 * request is outstanding), F6 next cycle, F10 next statement, F11 step
 * into, Shift+F11 step out. Gutter clicks and F9 breakpoints live in the
 * editor; run-to-cursor is on the strip and the editor's context menu.
 *
 * `start="play"` mounts the preview lane instead: the draft builds and runs
 * immediately (the workspace's `play()`), with no authored specs armed and
 * no entry stop. A refused rebuild keeps the previous run alive and the
 * strip labels it an older build.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import UiButton from "../../../ui/UiButton.vue";
import UiChip from "../../../ui/UiChip.vue";
import UiDialog from "../../../ui/UiDialog.vue";
import UiIconButton from "../../../ui/UiIconButton.vue";
import { AgiAudio } from "../../../audio/AgiAudio.ts";
import type { TestPauseLease } from "./testSession.ts";
import { createDebugPresentation } from "./debugPresentation.ts";
import { createDebugWorkspace, type DebugDraftSource } from "./logicDebugWorkspace.ts";
import DebugGame from "./DebugGame.vue";
import DebugInspector from "./DebugInspector.vue";
import DebugSourceDiff from "./DebugSourceDiff.vue";

const props = defineProps<{
  draft: DebugDraftSource;
  /** Parks the live game for a run's lifetime; absent = no live game. */
  acquirePauseLease?: (() => TestPauseLease | Promise<TestPauseLease>) | undefined;
  /** Reveal a source line in the editor. */
  navigate?: ((target: { key: string; line: number; column?: number }) => void) | undefined;
  /** The editor's active document key — run-to-cursor and the diff target. */
  activeKey?: string | null;
  /** The editor's caret line in the active document — run-to-cursor's target. */
  cursorLine?: (() => number | null) | undefined;
  /** A document's live draft text — the diff's right side. */
  readCurrent?: ((key: string) => string | null) | undefined;
  /**
   * Which lane mounts on open: "test" (default) latches the entry stop with
   * the authored configuration; "play" runs the draft immediately.
   */
  start?: "test" | "play";
  /**
   * "dock" (default) is the bottom strip beside the editor's column; "side"
   * is the full-height pane a host mounts next to editing.
   */
  placement?: "dock" | "side";
  /** Hand keyboard focus back to the editor — Escape stays game input. */
  returnFocus?: (() => void) | undefined;
}>();

const emit = defineEmits<{
  /** The created view model, or null on teardown. */
  register: [workspace: import("./logicDebugWorkspace.ts").DebugWorkspace | null];
  close: [];
}>();

/* --- bridge and workspace ------------------------------------------------ */

const gameEl = useTemplateRef("game");

const bridge = createDebugPresentation({
  present: (frame) => gameEl.value?.present(frame),
  createAudio: () => new AgiAudio({ mode: "tandy" }),
});

const workspace = createDebugWorkspace({
  draft: props.draft,
  ...(props.acquirePauseLease ? { acquirePauseLease: props.acquirePauseLease } : {}),
  onPresentation: (message) => bridge.handle(message),
  onReset: () => bridge.reset(),
  onEnded: () => bridge.releaseAudio(),
  ...(props.navigate ? { navigate: props.navigate } : {}),
});
const state = workspace.state;

onMounted(() => {
  emit("register", workspace);
  void (props.start === "play" ? workspace.play() : workspace.test()).catch(() => undefined);
});

onBeforeUnmount(() => {
  emit("register", null);
  bridge.dispose();
  workspace.dispose();
});

/* --- execution strip ------------------------------------------------------ */

const busy = ref(false);

async function run(action: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await action();
  } catch {
    // The workspace surfaces refusals on state.error/state.configError.
  } finally {
    busy.value = false;
  }
}

const live = computed(() => state.phase === "running" || state.phase === "stopped");
const stopped = computed(() => state.phase === "stopped");

/**
 * The run's private save slots — session-local, never the live game's store.
 * The workspace mirrors the count as writes land between key waits.
 */
const saveCount = computed(() => state.saves);

const phaseChip = computed(() => {
  if (state.phase === "idle") return { tone: "neutral" as const, label: "Idle" };
  if (state.phase === "building" || state.phase === "starting")
    return { tone: "action" as const, label: "Starting…" };
  if (state.phase === "running")
    return { tone: "ok" as const, label: state.waiting ? `Waiting: ${state.waiting}` : "Running" };
  if (state.phase === "stopped") return { tone: "warn" as const, label: "Stopped" };
  return { tone: "neutral" as const, label: "Ended" };
});

/**
 * The play lane's live-update state — only ever rendered while a run is
 * live and the workspace reported a real status. A "pending" chip names a
 * proposal on the wire, never a commit.
 */
const updateChip = computed(() => {
  switch (state.update.status) {
    case "pending":
      return { tone: "action" as const, label: "Updating…" };
    case "waiting":
      return { tone: "warn" as const, label: "Update waiting" };
    case "blocked":
      return { tone: "warn" as const, label: "Update blocked" };
    case "indeterminate":
      return { tone: "warn" as const, label: "Update unknown" };
    default:
      return { tone: "neutral" as const, label: "" };
  }
});

async function testLatest(): Promise<void> {
  await run(() => workspace.test());
}

/** Ordinary playtesting on the latest draft — runs immediately. */
async function playLatest(): Promise<void> {
  await run(() => workspace.play());
}

/**
 * The strip's Restart keeps the run's lane: a play run replays the latest
 * draft unpaused; a debug run re-arms and re-latches the entry stop.
 */
async function restartLatest(): Promise<void> {
  await run(() => (state.runKind === "play" ? workspace.play() : workspace.test()));
}

/** Back to the code: the parent names the focus target, else the dock. */
const dockEl = useTemplateRef("dock");
function backToEditor(): void {
  if (props.returnFocus) props.returnFocus();
  else dockEl.value?.focus();
}

async function step(action: "into" | "over" | "out" | "cycle"): Promise<void> {
  await run(() => workspace.step(action));
}

const runToVerdict = ref<string>();
async function runToCursor(): Promise<void> {
  runToVerdict.value = undefined;
  const key = props.activeKey;
  if (!key?.startsWith("logic:")) {
    runToVerdict.value = "Open a LOGIC document to run to its cursor line.";
    return;
  }
  // The workspace resolves the pc against the frozen build's own source map.
  const line = props.cursorLine?.() ?? null;
  if (line === null) {
    runToVerdict.value = "No cursor position in the editor.";
    return;
  }
  const verdict = await workspace.runToCursor(key, line);
  if (!verdict.ok) runToVerdict.value = verdict.error;
}

function navigateToStop(): void {
  workspace.navigateToStop();
}

/* --- keyboard -------------------------------------------------------------- */

function onKeydown(ev: KeyboardEvent): void {
  if (!live.value) return;
  switch (ev.key) {
    case "F5":
      ev.preventDefault();
      if (stopped.value) void run(() => workspace.continueRun());
      else if (state.phase === "running") void run(() => workspace.pauseRun());
      return;
    case "F6":
      ev.preventDefault();
      if (stopped.value) void step("cycle");
      return;
    case "F10":
      ev.preventDefault();
      if (stopped.value) void step("over");
      return;
    case "F11":
      ev.preventDefault();
      if (stopped.value) void step(ev.shiftKey ? "out" : "into");
      return;
  }
}

/* --- prompts --------------------------------------------------------------- */

const promptText = ref("");
watch(
  () => state.prompt,
  (prompt) => {
    promptText.value = prompt?.initial ?? "";
  },
);

const promptOpen = computed({
  get: () => state.prompt !== null,
  set: (open) => {
    if (!open) workspace.cancelPrompt();
  },
});

function submitPrompt(): void {
  workspace.submitPrompt(promptText.value);
  promptText.value = "";
}

/* --- running-source diff ----------------------------------------------------- */

const diffOpen = ref(false);
const diffToggle = useTemplateRef("diffToggle");
const diffView = useTemplateRef("diffView");
const diffKey = computed(() => props.activeKey ?? null);
const diffRunning = computed(() => {
  void state.draftTick;
  const key = diffKey.value;
  return key === null ? null : workspace.frozenSource(key);
});
const diffDraft = computed(() => {
  void state.draftTick;
  const key = diffKey.value;
  return key === null ? null : (props.readCurrent?.(key) ?? null);
});

/**
 * Explicit opens reveal the comparison in the dock's scroll region and land
 * focus on its heading; draft edits alone never steal either. Closing hands
 * focus back to the toggle.
 */
async function toggleDiff(): Promise<void> {
  if (diffOpen.value) {
    diffOpen.value = false;
    (diffToggle.value?.$el as HTMLElement | undefined)?.focus();
    return;
  }
  diffOpen.value = true;
  await nextTick();
  (diffView.value?.$el as HTMLElement | undefined)?.scrollIntoView({ block: "start" });
  diffView.value?.focusHeading();
}

/* --- build diagnostics ------------------------------------------------------ */

/** Errors refuse the test and stay loud; notes fold behind a count. */
const diagnosticErrors = computed(() => state.diagnostics.filter((d) => d.severity === "error"));
const diagnosticNotes = computed(() => state.diagnostics.filter((d) => d.severity !== "error"));

/* --- teardown on the engine ending itself ---------------------------------- */
</script>

<template>
  <section
    ref="dock"
    class="debug-dock"
    :class="`debug-dock--${placement ?? 'dock'}`"
    aria-label="Test debugger"
    data-testid="debug-test-dock"
    :data-epoch="state.epoch"
    :data-run="state.runSeq"
    :data-kind="state.runKind ?? undefined"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <header class="debug-dock__strip">
      <template v-if="!live && state.phase !== 'building' && state.phase !== 'starting'">
        <UiButton
          variant="primary"
          size="sm"
          icon="play"
          title="Play the complete current draft isolated, running immediately"
          data-testid="debug-play"
          @click="playLatest"
        >
          Play
        </UiButton>
        <UiButton
          variant="secondary"
          size="sm"
          icon="bug"
          title="Run the current draft in a test game (F5)"
          data-testid="debug-test"
          @click="testLatest"
        >
          Test
        </UiButton>
      </template>
      <template v-else>
        <UiIconButton
          v-if="stopped"
          icon="play"
          label="Continue"
          size="sm"
          shortcut="F5"
          data-testid="debug-continue"
          @click="run(() => workspace.continueRun())"
        />
        <UiIconButton
          v-else
          icon="pause"
          label="Pause"
          size="sm"
          data-testid="debug-pause"
          :disabled="!live || busy"
          @click="run(() => workspace.pauseRun())"
        />
        <UiIconButton
          icon="redo"
          label="Next statement"
          size="sm"
          shortcut="F10"
          :disabled="!stopped || busy"
          data-testid="debug-step-over"
          @click="step('over')"
        />
        <UiIconButton
          icon="footprints"
          label="Step into call"
          size="sm"
          shortcut="F11"
          :disabled="!stopped || busy"
          data-testid="debug-step-into"
          @click="step('into')"
        />
        <UiIconButton
          icon="exit"
          label="Finish call"
          size="sm"
          shortcut="Shift+F11"
          :disabled="!stopped || busy"
          data-testid="debug-step-out"
          @click="step('out')"
        />
        <UiIconButton
          icon="film"
          label="Next cycle"
          size="sm"
          shortcut="F6"
          :disabled="!stopped || busy"
          data-testid="debug-step-cycle"
          @click="step('cycle')"
        />
        <UiIconButton
          icon="select"
          label="Run to cursor"
          size="sm"
          :disabled="!stopped || busy"
          data-testid="debug-run-cursor"
          @click="runToCursor"
        />
        <UiIconButton
          icon="rewind"
          :label="
            state.runKind === 'play'
              ? 'Play the latest draft again'
              : 'Restart test with the latest draft'
          "
          size="sm"
          :disabled="busy"
          data-testid="debug-restart"
          @click="restartLatest"
        />
        <UiIconButton
          icon="history"
          label="Restart this build; test save slots are kept"
          size="sm"
          :disabled="!live || busy"
          data-testid="debug-replay"
          @click="run(() => workspace.restartRun())"
        />
        <UiIconButton
          icon="x"
          label="End test"
          size="sm"
          data-testid="debug-end"
          @click="workspace.endTest()"
        />
      </template>

      <UiChip :tone="phaseChip.tone" dot data-testid="debug-phase">{{ phaseChip.label }}</UiChip>
      <UiChip v-if="state.runKind !== null" tone="neutral" data-testid="debug-kind">
        {{ state.runKind === "play" ? "Play" : "Debug" }}
      </UiChip>
      <UiChip v-if="state.stale" tone="warn" data-testid="debug-stale">Draft changed</UiChip>
      <UiChip v-if="state.buildFailed && live" tone="warn" data-testid="debug-older-build">
        Older build
      </UiChip>
      <UiChip
        v-if="state.update.status !== 'idle' && live"
        :tone="updateChip.tone"
        data-testid="debug-update"
      >
        {{ updateChip.label }}
      </UiChip>
      <UiChip v-if="state.modified" tone="warn" data-testid="debug-modified-chip">Modified</UiChip>
      <UiChip v-if="state.answersReady > 0" tone="warn" data-testid="debug-answers">
        {{ state.answersReady }} answer{{ state.answersReady === 1 ? "" : "s" }} queued
      </UiChip>
      <UiChip v-if="saveCount > 0" tone="neutral" data-testid="debug-saves">
        {{ saveCount }} save{{ saveCount === 1 ? "" : "s" }} in test
      </UiChip>
      <UiChip v-if="state.audioPaused" tone="neutral" data-testid="debug-audio-held">
        Audio held
      </UiChip>
      <select
        class="debug-dock__granularity"
        :value="state.granularity"
        aria-label="Step granularity"
        data-testid="debug-granularity"
        @change="
          state.granularity = ($event.target as HTMLSelectElement).value as
            'statement' | 'instruction'
        "
      >
        <option value="statement">statement</option>
        <option value="instruction">instruction</option>
      </select>
      <UiButton
        v-if="diffRunning !== null && diffDraft !== null"
        ref="diffToggle"
        variant="ghost"
        size="sm"
        title="Compare the frozen running source with the current draft"
        :aria-expanded="diffOpen"
        data-testid="debug-diff-toggle"
        @click="toggleDiff"
      >
        Running source
      </UiButton>
      <span class="debug-dock__spacer" />
      <UiIconButton
        icon="pencil"
        label="Back to the editor"
        size="sm"
        data-testid="debug-return-focus"
        @click="backToEditor"
      />
      <UiIconButton
        icon="x"
        label="Close debugger"
        size="sm"
        data-testid="debug-close"
        @click="emit('close')"
      />
    </header>

    <div class="debug-dock__scroll">
      <p
        v-if="runToVerdict"
        class="debug-dock__alert"
        role="alert"
        data-testid="debug-runto-verdict"
      >
        {{ runToVerdict }}
      </p>
      <p v-if="state.error" class="debug-dock__alert" role="alert" data-testid="debug-error">
        {{ state.error }}
      </p>
      <p
        v-if="state.buildFailed && live"
        class="debug-dock__note"
        role="status"
        data-testid="debug-older-note"
      >
        The latest draft did not build. The preview is still running the older build.
      </p>
      <p
        v-if="state.update.status !== 'idle' && state.update.reason && live"
        class="debug-dock__note"
        role="status"
        data-testid="debug-update-reason"
      >
        {{ state.update.reason }}
        <UiButton
          v-if="state.update.restartable"
          variant="ghost"
          size="sm"
          data-testid="debug-update-restart"
          @click="restartLatest"
        >
          Restart with the latest draft
        </UiButton>
      </p>
      <ul
        v-if="diagnosticErrors.length"
        class="debug-dock__diagnostics"
        data-testid="debug-diagnostics"
      >
        <li
          v-for="(d, index) in diagnosticErrors"
          :key="index"
          class="debug-dock__diagnostic--error"
        >
          {{ d.document }}: {{ d.message }}
        </li>
      </ul>
      <details v-if="diagnosticNotes.length" class="debug-dock__notes" data-testid="debug-notes">
        <summary class="debug-dock__notes-summary">
          {{ diagnosticNotes.length }} analysis note{{ diagnosticNotes.length === 1 ? "" : "s" }}
        </summary>
        <ul class="debug-dock__diagnostics debug-dock__diagnostics--notes">
          <li
            v-for="(d, index) in diagnosticNotes"
            :key="index"
            :class="`debug-dock__diagnostic--${d.severity}`"
          >
            {{ d.severity }} · {{ d.document }}: {{ d.message }}
          </li>
        </ul>
      </details>

      <div class="debug-dock__body">
        <div class="debug-dock__game">
          <DebugGame ref="game" :workspace :bridge />
        </div>
        <DebugInspector class="debug-dock__inspector" :workspace @navigate="navigateToStop" />
      </div>

      <div v-if="diffOpen && diffRunning !== null && diffDraft !== null" class="debug-dock__diff">
        <DebugSourceDiff
          ref="diffView"
          :running="diffRunning"
          :draft="diffDraft"
          :stop-line="state.stopLocation?.line ?? null"
        />
      </div>
    </div>

    <UiDialog
      v-model:open="promptOpen"
      title="Test prompt"
      size="sm"
      :description="state.prompt?.prompt ?? 'The test game asks for input.'"
      data-testid="debug-prompt"
    >
      <form @submit.prevent="submitPrompt">
        <input
          v-model="promptText"
          class="debug-dock__prompt-input"
          :inputmode="state.prompt?.kind === 'number' ? 'numeric' : 'text'"
          :maxlength="state.prompt?.maxLen ?? 40"
          aria-label="Answer"
          data-testid="debug-prompt-input"
          autocomplete="off"
        />
      </form>
      <template #footer>
        <UiButton
          variant="ghost"
          data-testid="debug-prompt-cancel"
          @click="workspace.cancelPrompt()"
        >
          Cancel
        </UiButton>
        <UiButton variant="primary" data-testid="debug-prompt-submit" @click="submitPrompt">
          Answer
        </UiButton>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.debug-dock {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* On a laptop the dock shares the column with the source editor: it keeps
     a bounded share and scrolls its body rather than starving the code. */
  max-height: 46vh;
  overflow: hidden;
  border-top: 1px solid var(--hairline-strong);
  background: var(--surface-1);
}
/* The beside-the-editor pane a sibling-nav host mounts: full height, the
   game on top and the inspector folding under it. */
.debug-dock--side {
  height: 100%;
  max-height: none;
  border-top: none;
  border-left: 1px solid var(--hairline-strong);
}
.debug-dock--side .debug-dock__body {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  height: auto;
  flex: 1;
}
.debug-dock--side .debug-dock__game {
  border-right: none;
  border-bottom: 1px solid var(--hairline-strong);
}
.debug-dock__strip {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--hairline-strong);
}
.debug-dock__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.debug-dock__spacer {
  flex: 1;
}
.debug-dock__granularity {
  padding: var(--space-0) var(--space-1);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink-2);
  background: var(--surface-0);
  font: var(--text-2xs) / var(--leading) var(--font-sans);
}
.debug-dock__alert {
  margin: 0;
  padding: var(--space-1) var(--space-3);
  color: var(--danger);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.debug-dock__note {
  margin: 0;
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.debug-dock__diagnostics {
  margin: 0;
  max-height: 5.5em;
  overflow-y: auto;
  padding: var(--space-1) var(--space-3);
  list-style: none;
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.debug-dock__diagnostic--error {
  color: var(--danger);
}
.debug-dock__diagnostic--warning {
  color: var(--warn);
}
.debug-dock__notes {
  padding: 0 var(--space-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.debug-dock__notes-summary {
  padding: var(--space-1) 0;
  color: var(--ink-3);
  cursor: pointer;
}
.debug-dock__notes-summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.debug-dock__diagnostics--notes {
  max-height: 5.5em;
  padding: 0;
}
.debug-dock__body {
  flex: none;
  display: grid;
  grid-template-columns: minmax(200px, 320px) minmax(0, 1fr);
  min-height: 0;
  height: 300px;
}
.debug-dock__game {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--hairline-strong);
}
.debug-dock__inspector {
  min-height: 0;
}
.debug-dock__diff {
  flex: none;
  height: 220px;
  border-top: 1px solid var(--hairline-strong);
}
.debug-dock__prompt-input {
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-sm) / var(--leading) var(--font-mono);
}
@media (max-width: 900px) {
  .debug-dock__body {
    grid-template-columns: minmax(160px, 240px) minmax(0, 1fr);
    height: 240px;
  }
}
</style>
