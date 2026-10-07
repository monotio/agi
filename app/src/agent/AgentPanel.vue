<script setup lang="ts">
import { documentLabel, numberedLabel } from "../../../src/logic/numberedLabels.ts";
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
import { borrowWorkspaceAgent, type ReplyFormatter } from "./workspaceAgent.ts";
import { useReadingPosition } from "../shell/useReadingPosition.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useWorkspaceEditor } from "../shell/workspaceEditor.ts";
import { useShellBridge } from "../shell/shellBridge.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { useOptionalCommands } from "../shell/commands/commandContext.ts";
import { VOCABULARY } from "../../../src/vocabulary.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { openContainer } from "../../../src/container/container.ts";
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
  session?: ProjectSession | null | undefined;
  profileId?: ProfileId | undefined;
}>();
const emit = defineEmits<{ close: [] }>();
const labels = useProjectLabels();
const engine = useEngineApi();
const editor = useWorkspaceEditor();
const settings = useAiSettings();
const bridge = useShellBridge();
// Load the review previews while the panel opens, so a proposal shows at once. A chunk
// that cannot load (offline, or a deploy mid-session) still leaves Approve and Reject.
const loadResourceReview = () => import("./AgentResourceReview.vue");
void loadResourceReview().catch(() => {});
const AgentResourceReview = defineAsyncComponent({
  loader: loadResourceReview,
  errorComponent: () =>
    h(
      "p",
      { class: "agent-panel__preview-missing", "data-testid": "agent-preview-missing" },
      "The preview could not load. You can still approve or reject this change.",
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
const openingFocus = document.activeElement;
watch(
  [agent, composer],
  ([ready, element]) => {
    if (
      ready &&
      element &&
      document.activeElement === openingFocus &&
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
const addContext = ref(false);
const contexts = ref<string[]>([]);
const selected = ref<string[]>([]);
let off: (() => void) | undefined;
let retired = false;
let sentReferenceIds: readonly string[] = [];
async function attach() {
  const session = props.session ?? engine.getProjectSession();
  if (!session) return;
  const runtime = await engine.getAgentRuntime();
  if (retired || (props.session ?? engine.getProjectSession()) !== session || agent.value) return;
  off?.();
  const attached = borrowWorkspaceAgent({
    session,
    profileId:
      props.profileId ??
      (engine.state.phase === "running" ? engine.roomMap.resources.value.profile?.id : undefined) ??
      "2.936",
    config: settings.llmConfig,
    runtime: () => ({
      ...runtime,
      referenceArt: async () => runtime.referenceArt?.(sentReferenceIds),
    }),
    beforeApprove: async () => {
      await editor.flush.value?.();
    },
  });
  // The first chat can create the editable copy. Settle it before accepting input.
  try {
    await session.flush();
  } catch (cause) {
    if (!retired) error.value = cause instanceof Error ? cause.message : String(cause);
    return;
  }
  if (retired || (props.session ?? engine.getProjectSession()) !== session || agent.value) return;
  agent.value = attached;
  off = agent.value.subscribe(() => {
    tick.value++;
  });
  tick.value++;
}
watch(
  () => [engine.state.phase, engine.state.patchTick, props.session],
  () => {
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
});
const current = computed(() => {
  void tick.value;
  return agent.value?.current();
});
watch(
  current,
  (chat) => {
    editor.agentMessages.value = chat?.messages.slice() ?? [];
  },
  { immediate: true, deep: true },
);
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
const progress = computed(() => {
  void tick.value;
  return agent.value?.progress ?? [];
});
const task = computed(() => {
  void tick.value;
  return agent.value?.task ?? null;
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
const images = computed(() => {
  const proposal = review.value?.proposal;
  if (!proposal) return null;
  const files = Object.fromEntries(proposal.base.lastAdmissibleBuild!.files());
  const beforeDocuments = proposal.base.documents();
  const afterDocuments = proposal.documents();
  try {
    return {
      beforeDocuments,
      afterDocuments,
      before: openContainer(new Map(Object.entries(files)), { profile: profile.value }),
      after: openContainer(
        compileProjectDocuments({
          files,
          profileId: profile.value.id,
          documents: afterDocuments,
        }).files(),
        { profile: profile.value },
      ),
    };
  } catch {
    return null;
  }
});
async function action(work: () => unknown) {
  if (editor.readOnly.value) return;
  error.value = "";
  try {
    await work();
    tick.value++;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function send() {
  if (!input.value.trim() || busy.value || editor.readOnly.value) return;
  const request = input.value;
  sentReferenceIds = pendingReferences
    .filter((reference) => reference.project === engine.getBootedGame()?.projectId)
    .map((reference) => reference.id);
  const inspect = readOnly.value;
  const scoped = taskContext.value;
  const replyFormatter = formatReply.value;
  formatReply.value = undefined;
  taskContext.value = "";
  readOnly.value = false;
  input.value = "";
  await action(async () => {
    await editor.flush.value?.();
    const context = [
      scoped,
      ...(engine.state.phase === "running"
        ? [`Current room ${engine.roomMap.currentRoom.value ?? 0}`]
        : []),
      ...contexts.value,
      ...(chip.value ? [`Selection: ${chip.value.label}\n${chip.value.text}`] : []),
      ...(contexts.value.includes("Current problems")
        ? (engine
            .getProjectSession()
            ?.capture()
            .diagnostics.map((entry) => `${entry.document ?? "Project"}: ${entry.message}`) ?? [])
        : []),
    ].join("\n");
    if (inspect) await agent.value?.ask(request, context, replyFormatter);
    else await agent.value?.send(request, context);
    for (const id of sentReferenceIds) removePendingReference(id);
  });
}
async function approve() {
  if (editor.readOnly.value) return;
  await action(() => agent.value?.approve(selected.value));
}
function close() {
  engine.closePowerUp();
  emit("close");
  void nextTick().then(() => {
    editor.returnFromAgent.value?.();
  });
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
const chatTitle = computed(() => {
  const title = current.value?.title;
  return title && title !== "New chat" ? title : "Chats";
});
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
      <button class="agent-panel__chat-title" @click="chatList = !chatList" aria-label="Chats">
        {{ chatTitle }} <UiIcon name="chevron-down" :size="16" /></button
      ><UiButton
        size="sm"
        variant="ghost"
        :disabled="busy || editor.readOnly.value"
        @click="newChat"
        title="New chat (⌘N)"
        >New chat</UiButton
      ><UiButton
        v-if="engine.state.phase === 'running'"
        size="sm"
        variant="ghost"
        data-testid="btn-record-test"
        :disabled="busy || engine.state.recording.active || engine.state.recording.starting"
        @click="
          engine.closePowerUp();
          bridge.focusGameInput();
          bridge.startPlaytest();
        "
        >Playtest</UiButton
      ><UiIconButton
        icon="x"
        label="Close"
        shortcut="Esc"
        size="sm"
        data-testid="agent-panel-close"
        @click="close"
      />
    </header>
    <div class="agent-panel__mode">
      <UiSegmented
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
    </div>
    <nav v-if="chatList" class="agent-panel__chats" aria-label="Chats">
      <div v-for="chat in chats" :key="chat.id">
        <button
          :disabled="busy || editor.readOnly.value"
          @click="
            action(() => agent?.resume(chat.id));
            chatList = false;
          "
        >
          {{ chat.title }}<span v-if="chat.background"> · Background</span
          ><span v-if="chat.archived"> · Archived</span></button
        ><UiButton
          size="sm"
          variant="ghost"
          :disabled="busy || editor.readOnly.value"
          :aria-label="`Delete ${chat.title}`"
          @click="action(() => agent?.deleteChat(chat.id))"
          ><UiIcon name="x" :size="16"
        /></UiButton>
      </div>
    </nav>
    <div
      v-if="review"
      :key="review.messageId"
      class="agent-panel__review-actions"
      role="group"
      aria-label="Review changes"
    >
      <UiButton
        size="sm"
        :disabled="editor.readOnly.value || busy || review.stale() || !selected.length"
        variant="primary"
        data-testid="agent-approve"
        @click="approve"
        >Approve <kbd>⌘↵</kbd></UiButton
      ><UiButton
        size="sm"
        variant="ghost"
        :disabled="busy || editor.readOnly.value"
        data-testid="agent-reject"
        @click="
          agent?.reject();
          tick++;
        "
        >Reject</UiButton
      >
    </div>
    <div ref="feed" class="agent-panel__feed" aria-live="polite" @scroll.passive="readPosition">
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
          <details v-if="message.context" class="agent-panel__task-context">
            <summary>Context</summary>
            <pre>{{ message.context }}</pre>
          </details>
          <UiChip
            v-if="agent?.reviewOutcome(message.id)"
            :tone="message.commit ? 'ok' : 'neutral'"
            data-testid="agent-review-outcome"
            >{{ agent.reviewOutcome(message.id) }}</UiChip
          >
          <div v-if="message.commit" class="agent-panel__checkpoints">
            <UiButton
              size="sm"
              variant="ghost"
              :disabled="busy || editor.readOnly.value"
              @click="action(() => agent?.undoMessage(message.id))"
              >Undo this</UiButton
            ><UiButton
              size="sm"
              variant="ghost"
              :disabled="busy || editor.readOnly.value"
              @click="action(() => agent?.restoreBefore(message.id))"
              >Restore to before this</UiButton
            >
          </div>
        </article>
        <details v-if="progress.length && !review" class="agent-panel__progress" :open="busy">
          <summary>{{ busy ? "Working…" : "Steps" }}</summary>
          <p v-for="(note, index) in progress" :key="index">{{ note }}</p>
        </details>
        <section
          v-if="review"
          :key="review.messageId"
          class="agent-panel__review"
          data-testid="agent-review"
        >
          <header>
            <h3>{{ review.proposal.label }}</h3>
          </header>
          <p v-if="review.stale()" role="alert" data-testid="agent-conflict">
            The project changed while the agent worked. Send a follow-up to revise these changes.
          </p>
          <article
            v-for="change in review.changes()"
            :key="change.key"
            class="agent-panel__resource"
          >
            <label
              ><input type="checkbox" :value="change.key" v-model="selected" />{{
                documentLabel(change.key, labels)
              }}</label
            >
            <Suspense v-if="images">
              <AgentResourceReview
                :document-key="change.key"
                :before="review.proposal.base.read(change.key)?.content"
                :before-documents="images.beforeDocuments"
                :after-documents="images.afterDocuments"
                :after="change.content"
                :before-image="images.before"
                :after-image="images.after"
                :profile="profile"
              />
              <template #fallback>
                <p
                  class="agent-panel__review-loading"
                  role="status"
                  data-testid="agent-review-loading"
                >
                  Preparing the preview…
                </p>
              </template>
            </Suspense>
            <p v-else class="agent-panel__preview-missing" data-testid="agent-preview-missing">
              The preview could not load. You can still approve or reject this change.
            </p>
          </article>
        </section>
        <details v-if="review && progress.length" class="agent-panel__progress">
          <summary>Steps</summary>
          <p v-for="(note, index) in progress" :key="index">{{ note }}</p>
        </details>
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
        >Open AI settings</UiButton
      >
    </p>
    <p v-if="error" class="agent-panel__error" role="alert">{{ error }}</p>
    <AgentTaskControls
      v-if="task"
      :task="task"
      @stop="agent?.stop()"
      @resume="agent?.continue($event)"
      @discard="agent?.cancel()"
    />
    <form class="agent-panel__composer" @submit.prevent="send">
      <PendingReferences
        :busy
        :room="engine.state.phase === 'running' ? (engine.roomMap.currentRoom.value ?? 0) : 0"
        :allow-attach="!readOnly"
      />
      <div class="agent-panel__context">
        <span v-if="roomName">{{ roomName }}</span
        ><span v-if="chip" class="agent-panel__context-selection" data-testid="agent-context-chip"
          >{{ chip.label
          }}<button
            type="button"
            aria-label="Ask about the whole game"
            title="Ask about the whole game"
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
        placeholder="Describe a change…"
        data-testid="agent-message"
        :rows="review ? 1 : 3"
        :disabled="!agent || busy || editor.readOnly.value"
      ></textarea>
      <div>
        <UiButton
          type="submit"
          size="sm"
          variant="primary"
          :disabled="
            editor.readOnly.value || busy || !input.trim() || !agent || !settings.aiConfigured.value
          "
          >Send</UiButton
        ><span>⌘↵</span>
      </div>
    </form>
  </section>
</template>
