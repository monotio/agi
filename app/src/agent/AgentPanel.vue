<script setup lang="ts">
import { documentLabel, numberedLabel } from "../../../src/logic/numberedLabels.ts";
import { STALE_SAVE_MESSAGE, PROJECT_REMOVED_MESSAGE } from "../project/projectTransaction.ts";
import { useProjectLabels } from "../shell/useProjectLabels.ts";
import UiIcon from "../ui/UiIcon.vue";
import {
  computed,
  defineAsyncComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onWatcherCleanup,
  useTemplateRef,
  ref,
  shallowRef,
  watch,
} from "vue";
import PendingReferences from "../references/PendingReferences.vue";
import { pendingReferences, removePendingReference } from "../references/referenceUploadState.ts";
import AgentReply from "./AgentReply.ts";
import AgentResult from "./AgentResult.vue";
import AgentReviewActions from "./AgentReviewActions.vue";
import { borrowWorkspaceAgent, type ReplyFormatter } from "./workspaceAgent.ts";
import { useReadingPosition } from "../shell/useReadingPosition.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useWorkspaceEditor } from "../shell/workspaceEditor.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { useShell } from "../shell/useShell.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { useOptionalCommands } from "../shell/commands/commandContext.ts";
import { VOCABULARY } from "../../../src/vocabulary.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { openContainer } from "../../../src/container/container.ts";
import { readProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { diffProjectDocuments } from "../../../src/authoring/projectContent.ts";
import { sameProjectContent } from "../../../src/authoring/projectContent.ts";
import { compileCapturedResource } from "./agentResultPreview.ts";
import { formatSpent } from "./reportedSpend.ts";
import { resolveAgentTarget } from "./agentNavigation.ts";
import {
  approveCapturedReview,
  captureReviewOwner,
  type ReviewOwner,
} from "./agentRequestOwner.ts";
import type { AgentChat } from "../../../src/agent/chats.ts";
import UiChip from "../ui/UiChip.vue";
import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import AgentTaskControls from "../authoring/AgentTaskControls.vue";
import "./agentPanel.css";
import type { ProjectSession } from "../project/projectSession.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
/**
 * The drawer's panel. With no session prop it works on the running project's
 * session; the blank stage passes its own (home/emptyStageSession.ts).
 */
const props = defineProps<{
  focusRequest: { readonly origin: Element | null } | undefined;
  session?: ProjectSession | null | undefined;
  profileId?: ProfileId | undefined;
}>();
const emit = defineEmits<{ close: [] }>();
const labels = useProjectLabels();
const engine = useEngineApi();
const editor = useWorkspaceEditor();
const settings = useAiSettings();
const bridge = useShellBridge();
const shell = useShell();
const creating = computed(() => props.session !== undefined || shell.mode.value === "create");
// Review rendering stays lazy so Studio never joins the Play boot graph.
const loadResourceReview = () => import("./AgentResourceReview.vue");
const AgentResourceReview = defineAsyncComponent({
  loader: loadResourceReview,
  errorComponent: () =>
    h(
      "p",
      { class: "agent-panel__preview-missing", "data-testid": "agent-preview-missing" },
      "Preview unavailable. Reopen the result to try again.",
    ),
  onError: (_error, retry, fail, attempts) => (attempts <= 2 ? retry() : fail()),
});
watch(
  settings.provider,
  (provider) => {
    if (provider === "openai") void import("openai").catch(() => {});
    else if (provider === "anthropic") void import("@anthropic-ai/sdk").catch(() => {});
  },
  { immediate: true },
);
const agent = shallowRef<ReturnType<typeof borrowWorkspaceAgent>>();
const tick = ref(0);
const input = ref("");
const readOnly = ref(false);
const taskContext = ref("");
const formatReply = shallowRef<ReplyFormatter>();
const composer = useTemplateRef("composer");
let consumedFocusRequest: typeof props.focusRequest;
watch(
  [() => props.focusRequest, agent, composer],
  async ([request, ready, element]) => {
    if (!request || request === consumedFocusRequest || !ready || !element) return;
    consumedFocusRequest = request;
    // The parent drawer's v-show update finishes after this child's post watcher.
    await nextTick();
    if (request !== props.focusRequest) return;
    const origin = request.origin;
    const focused = document.activeElement;
    // Hiding or disabling the opener can return browser focus to the body.
    const openerUnavailable =
      origin &&
      (!origin.isConnected ||
        origin.matches(":disabled") ||
        !origin.getClientRects().length ||
        getComputedStyle(origin).visibility !== "visible");
    if (
      !element.disabled &&
      element.getClientRects().length &&
      (focused === origin || (focused === document.body && openerUnavailable)) &&
      !document.querySelector("dialog[open]")
    )
      element.focus();
  },
  { flush: "post" },
);
watch(
  editor.agentPrefill,
  async (prefill) => {
    if (!prefill) return;
    input.value = prefill.text;
    readOnly.value = prefill.readOnly;
    taskContext.value = prefill.context ?? "";
    formatReply.value = prefill.formatReply;
    editor.agentPrefill.value = null;
    await nextTick();
    composer.value?.focus();
  },
  { immediate: true },
);
const error = ref("");
const chatList = ref(false);
const settingsOpen = ref(false);
const addContext = ref(false);
const contexts = ref<string[]>([]);
const selected = ref<string[]>([]);
const resultMessageId = ref<string>();
const resultResource = ref<string>();
const resultMessage = computed(() =>
  current.value?.messages.find((message) => message.id === resultMessageId.value),
);
const resultProfile = computed(() => {
  const message = resultMessage.value;
  const captured = message?.result?.kind === "resources" ? message.result.profileId : undefined;
  const request = current.value?.messages.find(
    (entry) => entry.request?.id === message?.taskId,
  )?.request;
  return PROFILES[captured ?? request?.profileId ?? profile.value.id]!;
});
const inspection = computed(() =>
  resultMessage.value?.result?.kind === "resources" ? resultMessage.value.result : undefined,
);
const resultReview = computed(() => {
  void tick.value;
  return resultMessageId.value ? agent.value?.reviewFor(resultMessageId.value) : undefined;
});
function openResult(message: AgentChat["messages"][number], resource?: string): void {
  resultMessageId.value = message.id;
  resultResource.value = resource;
}
const resultDocuments = computed(() => {
  const stored = resultReview.value;
  const inspected = inspection.value;
  return {
    before: stored ? readProjectWorkspace(stored.base) : {},
    after: stored
      ? readProjectWorkspace(stored.candidate)
      : inspected?.snapshot
        ? readProjectWorkspace(inspected.snapshot)
        : {},
  };
});
const isolatedResultImages = computed(() => {
  const { before, after } = resultDocuments.value;
  const images: Record<
    string,
    {
      before: ReturnType<typeof compileCapturedResource>;
      after: ReturnType<typeof compileCapturedResource>;
    }
  > = {};
  if (!resultImages.value)
    for (const key of Object.keys(after))
      images[key] = {
        before: compileCapturedResource(before, key, resultProfile.value),
        after: compileCapturedResource(after, key, resultProfile.value),
      };
  return images;
});
const resultImages = computed(() => {
  const stored = resultReview.value;
  const inspected = inspection.value;
  if (!stored && !inspected?.snapshot) return null;
  const session = props.session ?? engine.getProjectSession();
  const image = session?.capture().snapshot.lastAdmissibleBuild;
  const files = image ? Object.fromEntries(image.files()) : engine.getBootedGame()?.files;
  if (!files) return null;
  const beforeDocuments = stored ? readProjectWorkspace(stored.base) : {};
  const afterDocuments = readProjectWorkspace(stored ? stored.candidate : inspected!.snapshot!);
  try {
    const beforeImageDocuments = stored
      ? readProjectWorkspace(stored.baseImage ?? stored.base)
      : afterDocuments;
    const selectedProfile = resultProfile.value;
    return {
      beforeDocuments,
      afterDocuments,
      before: openContainer(
        compileProjectDocuments({
          files,
          profileId: selectedProfile.id,
          documents: beforeImageDocuments,
        }).files(),
        { profile: selectedProfile },
      ),
      after: openContainer(
        compileProjectDocuments({
          files,
          profileId: selectedProfile.id,
          documents: afterDocuments,
        }).files(),
        { profile: selectedProfile },
      ),
    };
  } catch {
    return null;
  }
});
const resultChanges = computed(() => {
  const stored = resultReview.value;
  if (stored)
    return diffProjectDocuments(
      readProjectWorkspace(stored.base),
      readProjectWorkspace(stored.candidate),
    );
  const inspected = inspection.value;
  if (!inspected?.snapshot) return [];
  const documents = readProjectWorkspace(inspected.snapshot);
  return inspected.resources.map((key) => ({ key, content: documents[key] ?? null }));
});
const resultEarlier = computed(() => {
  void tick.value;
  void engine.state.patchTick;
  const message = resultMessage.value;
  if (inspection.value?.snapshot) {
    const session = props.session ?? engine.getProjectSession();
    const currentDocuments = session?.capture().snapshot.documents() ?? {};
    const files =
      session?.capture().snapshot.lastAdmissibleBuild?.files() ??
      new Map(Object.entries(engine.getBootedGame()?.files ?? {}));
    const currentImage = openContainer(files, { profile: resultProfile.value });
    return Object.entries(readProjectWorkspace(inspection.value.snapshot)).some(
      ([key, content]) => {
        if (typeof content === "string" && currentDocuments[key] !== undefined)
          return !sameProjectContent(content, currentDocuments[key]);
        const [kind, number] = key.split(":");
        if (kind === "logic" || kind === "picture" || kind === "view" || kind === "sound") {
          const captured =
            content instanceof Uint8Array
              ? content
              : (resultImages.value?.after ?? isolatedResultImages.value[key]?.after)?.getResource(
                  kind,
                  Number(number),
                );
          return (
            captured !== undefined &&
            !sameProjectContent(captured, currentImage.getResource(kind, Number(number)))
          );
        }
        if (key === "words" || key === "inventory")
          return !sameProjectContent(
            content instanceof Uint8Array
              ? content
              : resultImages.value?.after.files.get(key === "words" ? "WORDS.TOK" : "OBJECT"),
            currentImage.files.get(key === "words" ? "WORDS.TOK" : "OBJECT"),
          );
        if (
          key === "tests" &&
          content instanceof Uint8Array &&
          typeof currentDocuments[key] === "string"
        )
          return !sameProjectContent(content, new TextEncoder().encode(currentDocuments[key]));
        return (
          currentDocuments[key] !== undefined && !sameProjectContent(content, currentDocuments[key])
        );
      },
    );
  }
  const documentId =
    message?.result?.kind === "changes" && message.result.status === "pending"
      ? resultReview.value?.baseDocumentId
      : message?.result && "documentId" in message.result
        ? message.result.documentId
        : undefined;
  return (
    documentId !== undefined &&
    documentId !== (props.session ?? engine.getProjectSession())?.capture().snapshot.documentId
  );
});
async function openResource(
  message: AgentChat["messages"][number],
  resource: string,
  currentVersion = false,
  location?: { loop: number; cel: number },
): Promise<void> {
  const session = props.session ?? engine.getProjectSession();
  const projectId = engine.getBootedGame()?.projectId;
  if (!session || !projectId) return;
  const documentId =
    !currentVersion && message.result && "documentId" in message.result
      ? message.result.documentId
      : session.capture().snapshot.documentId;
  const target = {
    projectId,
    documentId,
    messageId: message.id,
    ...(message.taskId ? { taskId: message.taskId } : {}),
    resource,
    ...location,
  };
  const resolved = resolveAgentTarget(target, {
    projectId,
    documentId: session.capture().snapshot.documentId,
  });
  if (resolved.kind === "earlier") {
    openResult(message, resource);
    return;
  }
  const owner = agent.value;
  const openedResult = resultMessageId.value;
  await action(async () => {
    await editor.openAgentTarget(target);
    if (
      retired ||
      agent.value !== owner ||
      (props.session ?? engine.getProjectSession()) !== session
    )
      throw new Error("The game changed. Reopen the result to navigate.");
    shell.setMode("create");
    if (resultMessageId.value === openedResult) resultMessageId.value = undefined;
    if (window.matchMedia("(max-width: 600px)").matches) close();
  });
}
let off: (() => void) | undefined;
let retired = false;
let attaching = false;
let attachedSession: ProjectSession | null | undefined;
let attachedGame: ReturnType<typeof engine.getBootedGame>;
let previousChat: string | undefined;
async function attach() {
  if (props.session === undefined && engine.state.phase !== "running") return;
  const session = props.session ?? engine.getProjectSession();
  const openedGame = engine.getBootedGame();
  const openedTransition = engine.state.conversationTransitioning;
  const attachingDraft = input.value;
  if (retired || attaching || agent.value || (props.session === null && !session)) return;
  attaching = true;
  off?.();
  try {
    const attached = props.session
      ? borrowWorkspaceAgent({
          session: props.session,
          profileId: props.profileId ?? "2.936",
          config: settings.llmConfig,
          beforeApprove: async () => {
            await editor.flush.value?.();
          },
        })
      : await engine.getConversationAgent();
    const acquiredSession = props.session ?? engine.getProjectSession();
    const acquiredGame = engine.getBootedGame();
    try {
      await acquiredSession?.flush();
    } catch {
      // The owner retains the failed conversation save and its retry action.
    }
    if (
      !attached ||
      retired ||
      (props.session ?? engine.getProjectSession()) !== acquiredSession ||
      engine.getBootedGame() !== acquiredGame
    )
      return;
    agent.value = attached;
    if (
      previousChat !== undefined &&
      attached.current()?.id !== previousChat &&
      input.value === attachingDraft
    ) {
      input.value = "";
      contexts.value = [];
      resultMessageId.value = undefined;
    }
    attachedSession = acquiredSession;
    attachedGame = engine.getBootedGame();
    off = attached.subscribe(() => {
      tick.value++;
    });
    tick.value++;
  } catch (cause) {
    if (!retired) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    attaching = false;
    if (
      !retired &&
      !agent.value &&
      ((props.session ?? engine.getProjectSession()) !== session ||
        engine.getBootedGame() !== openedGame ||
        engine.state.conversationTransitioning !== openedTransition)
    )
      void attach();
  }
}
watch(
  () => [
    engine.state.phase,
    engine.state.patchTick,
    engine.state.conversationTransitioning,
    props.session,
    settings.aiConfigured.value,
  ],
  () => {
    const session = props.session ?? engine.getProjectSession();
    if (agent.value && (session !== attachedSession || engine.getBootedGame() !== attachedGame)) {
      previousChat = agent.value.current()?.id;
      off?.();
      agent.value = undefined;
    }
    if (!agent.value) attach();
  },
  { immediate: true },
);
watch(
  () => editor.selected.value,
  (key) => {
    if (key && !contexts.value.includes(key)) contexts.value.push(key);
  },
  { immediate: true },
);
const review = computed(() => {
  void tick.value;
  return agent.value?.autoApprove && agent.value.busy ? null : agent.value?.pending();
});
watch(review, (value) => {
  selected.value = value?.changes().map((change) => change.key) ?? [];
  if (value) {
    resultMessageId.value = value.messageId;
    resultResource.value = undefined;
  }
});
const current = computed(() => {
  void tick.value;
  return agent.value?.current();
});
const visibleMessages = computed(() => current.value?.messages);
const feed = useTemplateRef("feed");
const { following, readPosition, jumpToLatest, followLatest } = useReadingPosition(feed);
const feedContent = useTemplateRef("feedContent");
watch(
  feedContent,
  (element) => {
    if (!element) return;
    const observer = new ResizeObserver(followLatest);
    observer.observe(element);
    onWatcherCleanup(() => observer.disconnect());
  },
  { flush: "post" },
);

watch([() => current.value?.messages, review], followLatest, { deep: true, flush: "post" });
watch(
  () => current.value?.id,
  () => jumpToLatest(),
  { flush: "post" },
);
const chats = computed(() => {
  void tick.value;
  return agent.value?.chats() ?? [];
});
const busy = computed(() => {
  void tick.value;
  return agent.value?.busy ?? false;
});
const recoveryError = computed(() =>
  engine.state.projectRemoved
    ? PROJECT_REMOVED_MESSAGE
    : engine.state.staleTab
      ? STALE_SAVE_MESSAGE
      : engine.state.powerUp.error,
);
const canSend = computed(() => {
  void tick.value;
  return (
    !!agent.value &&
    !engine.state.conversationTransitioning &&
    (!busy.value || (agent.value.canSteer && !readOnly.value && !formatReply.value))
  );
});
const progress = computed(() => {
  void tick.value;
  return agent.value?.progress ?? [];
});
const task = computed(() => {
  void tick.value;
  return agent.value?.task ?? null;
});
const taskControlsVisible = computed(
  () =>
    !!task.value &&
    (busy.value || task.value.status === "paused" || !!error.value || !!agent.value?.error),
);
const taskRequestId = computed(() => {
  void tick.value;
  return (
    agent.value?.activeRequest?.id ??
    current.value?.messages.findLast((message) => message.request)?.request?.id
  );
});
const autoApprove = computed({
  get() {
    void tick.value;
    return agent.value?.autoApprove ?? false;
  },
  set(value: boolean) {
    if (agent.value) agent.value.autoApprove = value;
  },
});
const approvalMode = computed({
  get: () => (autoApprove.value ? "auto" : "review"),
  set: (value: string) => {
    autoApprove.value = value === "auto";
  },
});
const approvalModes = computed(() => [
  {
    disabled: !agent.value || editor.readOnly.value,
    value: "review",
    label: VOCABULARY.review.label,
    title: VOCABULARY.review.help,
    testid: "agent-review-mode",
  },
  {
    disabled: !agent.value || editor.readOnly.value,
    value: "auto",
    label: VOCABULARY.autoApprove.label,
    title: VOCABULARY.autoApprove.help,
    testid: "agent-auto-approve",
  },
]);
const roomName = computed(() => {
  if (engine.state.phase !== "running") return null;
  const room = engine.roomMap.currentRoom.value ?? 0;
  return numberedLabel("room", room, labels.value);
});
/** The selection the agent is looking at; × dismisses it until it changes. */
const dismissedChip = ref<string>();
const chip = computed(() => {
  const context = editor.agentContext.value;
  return context && context.label !== dismissedChip.value ? context : null;
});
function contextName(key: string): string {
  return documentLabel(key, labels.value);
}
const profile = computed(
  () =>
    PROFILES[
      props.profileId ??
        (engine.state.phase === "running"
          ? engine.roomMap.resources.value.profile?.id
          : undefined) ??
        "2.936"
    ]!,
);
async function action(work: () => unknown) {
  error.value = "";
  try {
    await work();
    tick.value++;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function send() {
  if (!input.value.trim() || !canSend.value || !agent.value) return;
  const request = input.value;
  const owner = agent.value;
  const session = props.session ?? engine.getProjectSession();
  const game = engine.getBootedGame();
  if (busy.value) {
    try {
      await owner.steer(request);
      if (input.value === request) input.value = "";
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
    return;
  }
  const mode = creating.value ? "create" : "play";
  const sentReferenceIds = pendingReferences
    .filter((reference) => reference.project === engine.getBootedGame()?.projectId)
    .map((reference) => reference.id);
  const inspect = readOnly.value;
  const scoped = taskContext.value;
  const replyFormatter = formatReply.value;
  const submittedProfile =
    props.profileId ??
    (engine.state.phase === "running" ? engine.roomMap.resources.value.profile?.id : undefined) ??
    "2.936";
  const context = [
    scoped,
    ...(engine.state.phase === "running"
      ? [`Current room ${engine.roomMap.currentRoom.value ?? 0}`]
      : []),
    ...contexts.value,
    ...(chip.value ? [`Selection: ${chip.value.label}\n${chip.value.text}`] : []),
    ...(contexts.value.includes("Current problems")
      ? (session
          ?.capture()
          .diagnostics.map((entry) => `${entry.document ?? "Project"}: ${entry.message}`) ?? [])
      : []),
  ].join("\n");
  await action(async () => {
    await editor.flush.value?.();
    if (
      retired ||
      agent.value !== owner ||
      (props.session ?? engine.getProjectSession()) !== session ||
      engine.getBootedGame() !== game
    )
      throw new Error("The game changed. Send the request again.");
    const runtime = await engine.getAgentRuntime();
    if (
      retired ||
      agent.value !== owner ||
      (props.session ?? engine.getProjectSession()) !== session ||
      engine.getBootedGame() !== game
    )
      throw new Error("The game changed. Send the request again.");
    const turnContext = {
      profileId: submittedProfile,
      runtime: () => ({
        ...runtime,
        referenceArt: async () => runtime.referenceArt?.(sentReferenceIds),
      }),
    };
    if (input.value === request) {
      input.value = "";
      if (formatReply.value === replyFormatter) formatReply.value = undefined;
      if (taskContext.value === scoped) taskContext.value = "";
      if (readOnly.value === inspect) readOnly.value = false;
    }
    await owner.submit({
      instruction: request,
      context,
      mode,
      readOnly: inspect,
      ...(replyFormatter ? { formatReply: replyFormatter } : {}),
      ...turnContext,
    });
    for (const id of sentReferenceIds) removePendingReference(id);
  });
}
function currentReviewOwner(): ReviewOwner | undefined {
  const owner = agent.value;
  if (!owner || retired) return undefined;
  return captureReviewOwner(
    owner,
    props.session ?? engine.getProjectSession(),
    engine.getBootedGame(),
    creating.value && !editor.readOnly.value,
  );
}
async function approve() {
  const captured = currentReviewOwner();
  if (!captured?.writable || !captured.review) return;
  await action(async () => {
    await approveCapturedReview(captured, currentReviewOwner, async () => {
      await editor.flush.value?.();
    });
    if (agent.value === captured.owner) resultMessageId.value = undefined;
  });
}
function reject(): void {
  if (!creating.value || editor.readOnly.value) return;
  agent.value?.reject();
  resultMessageId.value = undefined;
  tick.value++;
}
function close() {
  engine.closePowerUp();
  emit("close");
  void nextTick().then(() => {
    editor.returnFromAgent.value?.();
    if (!creating.value) bridge.focusGameInput();
  });
}
function useCommand(command: string): void {
  close();
  bridge.fillGameInput(command);
}
function newChat() {
  void action(() => agent.value?.newChat());
  chatList.value = false;
}
// Esc belongs to the panel only while focus is inside it: the game, the
// editors and their popups keep their own Esc.
function onEscapeKey(event: KeyboardEvent) {
  if (document.querySelector("dialog[open]")) return;
  event.preventDefault();
  event.stopPropagation();
  if (resultMessageId.value) {
    resultMessageId.value = undefined;
    return;
  }
  if (chatList.value) {
    chatList.value = false;
    return;
  }
  close();
}
function keys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    onEscapeKey(event);
    return;
  }
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    if (review.value) void approve();
    else void send();
  }
  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    event.stopPropagation();
    newChat();
  }
}
bridge.assistantInputEl = () => composer.value;
const commands = useOptionalCommands();
const offApprove = commands?.register({
  id: "agent.approve",
  title: "Approve changes",
  keys: [{ key: "Mod+Enter", textInput: true }],
  when: (context) => context.agentFocus === true && !context.dialogOpen,
  run: () => {
    if (review.value) void approve();
    else void send();
  },
});
const offNewChat = commands?.register({
  id: "agent.newChat",
  title: "New chat",
  keys: [{ key: "Mod+N", textInput: true }],
  when: (context) => context.agentFocus === true && !context.dialogOpen,
  run: newChat,
});
onBeforeUnmount(() => {
  retired = true;
  off?.();
  offApprove?.();
  offNewChat?.();
});
</script>
<template>
  <section
    class="agent-panel"
    data-testid="workspace-agent-panel"
    aria-label="Agent"
    @keydown="keys"
  >
    <header class="agent-panel__header">
      <h2
        :title="
          creating
            ? 'Ask questions or describe changes to your game.'
            : 'Ask questions or get hints about this game.'
        "
      >
        Agent
      </h2>
      <button class="agent-panel__chat-title" @click="chatList = !chatList" aria-label="Chats">
        <UiIcon name="history" :size="16" /></button
      ><UiIconButton
        icon="settings"
        label="Agent settings"
        size="sm"
        @click="settingsOpen = !settingsOpen"
      />
      <UiIconButton
        icon="x"
        label="Close"
        shortcut="Esc"
        size="sm"
        data-testid="agent-panel-close"
        @click="close"
      />
    </header>
    <div v-if="settingsOpen" class="agent-panel__mode">
      <UiSegmented
        v-if="creating"
        v-model="approvalMode"
        size="sm"
        label="Agent changes"
        :options="approvalModes"
      />
      <button
        @click="settings.openAiSettings($event, 'assistant')"
        class="agent-panel__model"
        :title="settings.aiModelLabel.value"
      >
        {{ settings.aiModelLabel.value }}
      </button>
      <UiButton
        v-if="creating && engine.state.phase === 'running'"
        size="sm"
        variant="ghost"
        data-testid="btn-record-test"
        :disabled="busy || engine.state.recording.active || engine.state.recording.starting"
        title="Record a playtest"
        @click="
          close();
          bridge.startPlaytest();
        "
        >Playtest</UiButton
      >
      <a
        :href="
          task?.usageUrl ??
          (current?.provider === 'anthropic'
            ? 'https://console.anthropic.com/settings/usage'
            : 'https://platform.openai.com/usage')
        "
        target="_blank"
        rel="noopener"
        >Provider usage</a
      >
    </div>
    <nav v-if="chatList" class="agent-panel__chats" aria-label="Chats">
      <UiButton size="sm" variant="ghost" :disabled="busy" @click="newChat" title="New chat (⌘N)"
        >New chat</UiButton
      >
      <div v-for="chat in chats" :key="chat.id">
        <button
          :disabled="busy"
          @click="
            action(() => agent?.resume(chat.id));
            chatList = false;
          "
        >
          {{ chat.title === "New chat" ? "Untitled chat" : chat.title
          }}<span v-if="chat.background"> · Background</span
          ><span v-if="chat.archived"> · Archived</span></button
        ><UiButton
          size="sm"
          variant="ghost"
          :disabled="busy"
          :aria-label="`Delete ${chat.title}`"
          @click="action(() => agent?.deleteChat(chat.id))"
          ><UiIcon name="x" :size="16"
        /></UiButton>
      </div>
    </nav>
    <AgentReviewActions
      v-if="review && !resultMessageId"
      :creating
      :disabled="editor.readOnly.value || busy || !selected.length"
      :stale="review.stale()"
      @apply="approve"
      @reject="reject"
      @create="shell.setMode('create')"
    />
    <div
      ref="feed"
      class="agent-panel__feed"
      data-testid="agent-conversation"
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      @scroll.passive="readPosition"
    >
      <div ref="feedContent">
        <article
          v-for="message in visibleMessages"
          :key="message.id"
          class="agent-panel__message"
          :class="{ 'agent-panel__message--user': message.role === 'user' }"
        >
          <strong>{{ message.role === "user" ? "You" : "Agent" }}</strong>
          <p v-if="message.role === 'user'">{{ message.text }}</p>
          <AgentReply v-else :text="message.text" />
          <span
            v-if="
              message.spend &&
              (!taskControlsVisible || !message.taskId || message.taskId !== taskRequestId)
            "
            class="agent-panel__spend"
            data-testid="agent-spent"
            >{{ formatSpent(message.spend, "compact") }}</span
          >
          <p v-if="message.delivery" class="agent-panel__receipt" data-testid="agent-delivery">
            {{
              message.delivery === "queued"
                ? "Waiting for the current step"
                : message.delivery === "received"
                  ? "Received"
                  : "Not sent"
            }}
          </p>
          <AgentResult
            v-if="message.result"
            :result="message.result"
            @command="useCommand"
            @resource="openResult(message, $event)"
            @review="openResult(message)"
          />
          <details v-if="message.context" class="agent-panel__task-context">
            <summary>Request details</summary>
            <pre>{{ message.context }}</pre>
          </details>
          <UiChip
            v-if="agent?.reviewOutcome(message.id)"
            :tone="message.commit ? 'ok' : 'neutral'"
            data-testid="agent-review-outcome"
            >{{ agent.reviewOutcome(message.id) }}</UiChip
          >
          <div v-if="message.commit && creating" class="agent-panel__checkpoints">
            <UiButton
              size="sm"
              variant="ghost"
              :disabled="!creating || busy || editor.readOnly.value"
              @click="action(() => agent?.undoMessage(message.id))"
              >Undo this</UiButton
            ><UiButton
              size="sm"
              variant="ghost"
              :disabled="!creating || busy || editor.readOnly.value"
              @click="action(() => agent?.restoreBefore(message.id))"
              >Restore to before this</UiButton
            >
          </div>
        </article>
      </div>
    </div>
    <UiButton
      v-if="!following"
      size="sm"
      variant="ghost"
      data-testid="agent-jump-latest"
      @click="jumpToLatest"
      >Jump to latest</UiButton
    >
    <p v-if="!settings.aiConfigured.value" class="agent-panel__intro agent-panel__setup">
      Connect your AI provider in Settings to start a task.
      <UiButton
        size="sm"
        variant="ghost"
        data-testid="agent-open-ai-settings"
        @click="settings.openAiSettings($event, 'assistant')"
        >Connect AI</UiButton
      >
    </p>
    <p
      v-if="error || agent?.error || recoveryError"
      class="agent-panel__error"
      data-testid="agent-error"
      role="alert"
    >
      {{ recoveryError || error || agent?.error }}
    </p>
    <UiButton
      v-if="engine.state.staleTab || engine.state.powerUp.offerReload"
      data-testid="agent-reload"
      @click="engine.reloadFromStorage()"
      >Reload game</UiButton
    >
    <div v-if="agent?.chatSaveError" class="agent-panel__error" role="status">
      <p>{{ agent.chatSaveError }}</p>
      <details v-if="progress.at(-1)">
        <summary>Details</summary>
        <p>{{ progress.at(-1) }}</p>
      </details>
      <UiButton
        size="sm"
        :disabled="busy"
        data-testid="agent-retry-save"
        @click="action(() => agent?.retryChatSave())"
        >Retry save</UiButton
      >
    </div>
    <AgentTaskControls
      v-if="task && taskControlsVisible"
      :task="task"
      :notes="progress"
      @stop="agent?.stop()"
      @resume="agent?.continue($event)"
      @discard="agent?.cancel()"
    />
    <form class="agent-panel__composer" @submit.prevent="send">
      <PendingReferences
        :busy
        :room="engine.state.phase === 'running' ? (engine.roomMap.currentRoom.value ?? 0) : 0"
        :allow-attach="creating && !readOnly"
      />
      <div class="agent-panel__context">
        <span v-if="!creating || readOnly" data-testid="agent-read-only">Read only</span>
        <span v-if="roomName" data-testid="agent-current-room">{{ roomName }}</span
        ><span v-if="chip" class="agent-panel__context-selection" data-testid="agent-context-chip"
          >{{ chip.label
          }}<button
            type="button"
            aria-label="Remove context"
            title="Remove context"
            @click="dismissedChip = chip.label"
          >
            <UiIcon name="x" :size="16" /></button></span
        ><button
          v-for="context in contexts"
          :key="context"
          type="button"
          @click="contexts = contexts.filter((entry) => entry !== context)"
        >
          {{ contextName(context) }} <UiIcon name="x" :size="16" /></button
        ><button type="button" @click="addContext = !addContext">+ Add context</button>
      </div>
      <select
        v-if="addContext"
        aria-label="Add context"
        @change="
          contexts.push(($event.target as HTMLSelectElement).value);
          addContext = false;
        "
      >
        <option value="">Choose a part</option>
        <option v-for="part in editor.parts.value" :key="part.id" :value="part.id">
          {{ part.title }}
        </option>
        <option value="Current problems">Current problems</option></select
      ><textarea
        ref="composer"
        v-model="input"
        aria-label="Agent message"
        :placeholder="creating ? 'Ask or describe a change…' : 'Ask about this game…'"
        data-testid="agent-message"
        :rows="review ? 1 : 3"
        :disabled="!agent && !engine.state.conversationTransitioning"
      ></textarea>
      <div>
        <UiButton
          type="submit"
          size="sm"
          variant="primary"
          :disabled="!canSend || !input.trim() || !settings.aiConfigured.value"
          data-testid="agent-send"
          >{{ busy ? "Send next step" : "Send" }}</UiButton
        ><span>⌘↵</span>
      </div>
    </form>
    <section
      v-if="resultMessage"
      class="agent-panel__result"
      data-testid="agent-result-preview"
      aria-label="Agent result"
    >
      <header>
        <UiButton size="sm" variant="ghost" @click="resultMessageId = undefined"
          >Back to chat</UiButton
        >
        <UiChip v-if="resultEarlier" data-testid="agent-earlier-version">Earlier version</UiChip>
      </header>
      <AgentReviewActions
        v-if="review?.messageId === resultMessage.id"
        :creating
        :disabled="editor.readOnly.value || busy || !selected.length"
        :stale="review.stale()"
        @apply="approve"
        @reject="reject"
        @create="shell.setMode('create')"
      />
      <div class="agent-panel__result-content">
        <h3>{{ resultReview?.label ?? "Result" }}</h3>
        <p
          v-if="review?.messageId === resultMessage.id && review.stale()"
          role="alert"
          data-testid="agent-conflict"
        >
          The game changed. Send a follow-up to revise these changes.
        </p>
        <div
          v-if="resultReview || inspection?.snapshot"
          class="agent-panel__review"
          :data-testid="resultReview ? 'agent-review' : 'agent-resource-preview'"
        >
          <article
            v-for="change in resultChanges.filter(
              (change) => !resultResource || change.key === resultResource,
            )"
            :key="change.key"
            class="agent-panel__resource"
          >
            <header>
              <h4>{{ documentLabel(change.key, labels) }}</h4>
              <UiButton
                v-if="change.content !== null && (props.session || engine.getProjectSession())"
                size="sm"
                variant="ghost"
                @click="openResource(resultMessage, change.key, true)"
                >Open current resource</UiButton
              >
            </header>
            <Suspense>
              <AgentResourceReview
                :document-key="change.key"
                :before="resultDocuments.before[change.key]"
                :before-documents="resultDocuments.before"
                :after-documents="resultDocuments.after"
                :after="change.content"
                :before-image="resultImages?.before ?? isolatedResultImages[change.key]?.before"
                :after-image="resultImages?.after ?? isolatedResultImages[change.key]?.after"
                :profile="resultProfile"
                :inspection="!!inspection"
                :navigation="!!(props.session || engine.getProjectSession())"
                @open="openResource(resultMessage, $event.resource, true, $event)"
              />
              <template #fallback
                ><p role="status" data-testid="agent-review-loading">
                  Preparing the preview…
                </p></template
              >
            </Suspense>
          </article>
        </div>
        <p v-else>Preview unavailable for this result.</p>
      </div>
    </section>
  </section>
</template>
