<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  useTemplateRef,
  ref,
  shallowRef,
  watch,
} from "vue";
import { borrowWorkspaceAgent } from "./workspaceAgent.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import { useWorkspaceEditor } from "../shell/workspaceEditor.ts";
import { useAiSettings } from "../settings/useAiSettings.ts";
import { useOptionalCommands } from "../shell/commands/commandContext.ts";
import { VOCABULARY } from "../../../src/vocabulary.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { openContainer } from "../../../src/container/container.ts";
import UiButton from "../ui/UiButton.vue";
import UiSegmented from "../ui/UiSegmented.vue";
import UiExplain from "../ui/UiExplain.vue";
import AgentTaskControls from "../authoring/AgentTaskControls.vue";
import "./agentPanel.css";
const engine = useEngineApi();
const editor = useWorkspaceEditor();
const settings = useAiSettings();
const AgentResourceReview = defineAsyncComponent(() => import("./AgentResourceReview.vue"));
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
const composer = useTemplateRef("composer");
onMounted(() => composer.value?.focus());
watch(
  editor.agentPrefill,
  async (prefill) => {
    if (!prefill) return;
    input.value = prefill.text;
    readOnly.value = prefill.readOnly;
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
async function attach() {
  const session = engine.getProjectSession();
  if (!session) return;
  const runtime = await engine.getAgentRuntime();
  if (retired || engine.getProjectSession() !== session || agent.value) return;
  off?.();
  agent.value = borrowWorkspaceAgent({
    session,
    profileId: engine.roomMap.resources.value.profile?.id ?? "2.936",
    config: settings.llmConfig,
    runtime: () => runtime,
  });
  off = agent.value.subscribe(() => {
    tick.value++;
  });
  tick.value++;
}
watch(
  () => [engine.state.phase, engine.state.patchTick],
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
const visibleMessages = computed(() => (review.value ? [] : current.value?.messages));
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
const approvalModes = [
  { value: "review", label: VOCABULARY.review.label, testid: "agent-review-mode" },
  { value: "auto", label: VOCABULARY.autoApprove.label, testid: "agent-auto-approve" },
];
const roomName = computed(() => {
  const room = engine.roomMap.currentRoom.value ?? 0;
  return (
    engine.roomMap.graph.value.nodes.find((node) => node.room === room)?.title ||
    editor.parts.value.find((part) => part.id === `logic:${room}`)?.title.split(" · ROOM ")[0] ||
    `ROOM ${room}`
  );
});
function contextName(key: string): string {
  const name = editor.parts.value.find((part) => part.id === key)?.title;
  if (name && !name.includes(" · ROOM ") && !name.startsWith("ROOM ")) return name;
  return key === "inventory" ? "OBJECT" : key.replace(":", " ").toUpperCase();
}
const profile = computed(() => PROFILES[engine.roomMap.resources.value.profile?.id ?? "2.936"]!);
const images = computed(() => {
  const proposal = review.value?.proposal;
  if (!proposal) return null;
  const files = Object.fromEntries(proposal.base.lastAdmissibleBuild!.files());
  try {
    return {
      before: openContainer(new Map(Object.entries(files)), { profile: profile.value }),
      after: openContainer(
        compileProjectDocuments({
          files,
          profileId: profile.value.id,
          documents: proposal.documents(),
        }).files(),
        { profile: profile.value },
      ),
    };
  } catch {
    return null;
  }
});
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
  if (!input.value.trim() || busy.value) return;
  const request = input.value;
  const inspect = readOnly.value;
  readOnly.value = false;
  input.value = "";
  await action(async () => {
    await editor.flush.value?.();
    const context = [
      `Current room ${engine.roomMap.currentRoom.value ?? 0}`,
      ...contexts.value,
      ...(editor.agentContext.value
        ? [`Selection: ${editor.agentContext.value.label}\n${editor.agentContext.value.text}`]
        : []),
      ...(contexts.value.includes("Current problems")
        ? (engine
            .getProjectSession()
            ?.capture()
            .diagnostics.map((entry) => `${entry.document ?? "Project"}: ${entry.message}`) ?? [])
        : []),
    ].join("\n");
    if (inspect) await agent.value?.ask(request, context);
    else await agent.value?.send(request, context);
  });
}
async function approve() {
  await action(async () => {
    await editor.flush.value?.();
    await agent.value?.approve(selected.value);
  });
}
function newChat() {
  void action(() => agent.value?.newChat());
  chatList.value = false;
}
function keys(event: KeyboardEvent) {
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
        {{ current?.title ?? "Agent" }} ▾</button
      ><UiButton size="sm" variant="ghost" :disabled="busy" @click="newChat" title="New chat (⌘N)"
        >New chat</UiButton
      >
    </header>
    <div class="agent-panel__mode">
      <UiSegmented
        v-model="approvalMode"
        size="sm"
        label="Agent changes"
        :options="approvalModes"
      />
      <UiExplain
        question
        term="agent-auto-approve"
        :name="VOCABULARY.autoApprove.label"
        :says="VOCABULARY.autoApprove.help"
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
          :disabled="busy"
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
          :disabled="busy"
          :aria-label="`Delete ${chat.title}`"
          @click="action(() => agent?.deleteChat(chat.id))"
          >×</UiButton
        >
      </div>
    </nav>
    <div class="agent-panel__feed" aria-live="polite">
      <p v-if="!current?.messages.length" class="agent-panel__intro">{{ VOCABULARY.agent.help }}</p>
      <article
        v-for="message in visibleMessages"
        :key="message.id"
        class="agent-panel__message"
        :class="{ 'agent-panel__message--user': message.role === 'user' }"
      >
        <strong>{{ message.role === "user" ? "You" : "Agent" }}</strong>
        <p>{{ message.text }}</p>
        <div v-if="message.commit" class="agent-panel__checkpoints">
          <UiButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="action(() => agent?.undoMessage(message.id))"
            >Undo this</UiButton
          ><UiButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="action(() => agent?.restoreBefore(message.id))"
            >Restore to before this</UiButton
          >
        </div>
      </article>
      <details v-if="progress.length && !review" class="agent-panel__progress" :open="busy">
        <summary>{{ busy ? "Working…" : "Steps" }}</summary>
        <p v-for="(note, index) in progress" :key="index">{{ note }}</p>
      </details>
      <section v-if="review && images" class="agent-panel__review" data-testid="agent-review">
        <header>
          <h3>{{ review.proposal.label }}</h3>
          <span class="agent-panel__preview" title="Approve applies this preview to the game."
            >Card preview</span
          >
        </header>
        <p v-if="review.stale()" role="alert" data-testid="agent-conflict">
          The project changed while the agent worked. Send a follow-up to revise these changes.
        </p>
        <article v-for="change in review.changes()" :key="change.key" class="agent-panel__resource">
          <label
            ><input type="checkbox" :value="change.key" v-model="selected" />{{
              change.key === "inventory" ? "OBJECT" : change.key.replace(":", " ").toUpperCase()
            }}</label
          ><AgentResourceReview
            :document-key="change.key"
            :before="review.proposal.base.read(change.key)?.content"
            :after="change.content"
            :before-image="images.before"
            :after-image="images.after"
            :profile="profile"
          />
        </article>
        <footer>
          <UiButton
            size="sm"
            :disabled="busy || review.stale() || !selected.length"
            variant="primary"
            data-testid="agent-approve"
            @click="approve"
            >Approve <kbd>⌘↵</kbd></UiButton
          ><UiButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            data-testid="agent-reject"
            @click="
              agent?.reject();
              tick++;
            "
            >Reject</UiButton
          >
        </footer>
      </section>
      <details v-if="review && progress.length" class="agent-panel__progress">
        <summary>Steps</summary>
        <p v-for="(note, index) in progress" :key="index">{{ note }}</p>
      </details>
    </div>
    <p v-if="!settings.aiConfigured.value" class="agent-panel__intro">
      Connect your AI provider in Settings to start a task.
    </p>
    <p v-if="error" class="agent-panel__error" role="alert">{{ error }}</p>
    <AgentTaskControls
      v-if="task && busy"
      :task="task"
      @stop="agent?.stop()"
      @resume="agent?.continue($event)"
      @discard="agent?.cancel()"
    />
    <form class="agent-panel__composer" @submit.prevent="send">
      <div class="agent-panel__context">
        <span>{{ roomName }}</span
        ><span v-if="editor.agentContext.value">{{ editor.agentContext.value.label }}</span
        ><button
          v-for="context in contexts"
          :key="context"
          type="button"
          @click="contexts = contexts.filter((entry) => entry !== context)"
        >
          {{ contextName(context) }} ×</button
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
        :disabled="busy"
      ></textarea>
      <div>
        <UiButton
          type="submit"
          size="sm"
          variant="primary"
          :disabled="busy || !input.trim() || !agent || !settings.aiConfigured.value"
          >Send</UiButton
        ><span>⌘↵</span>
      </div>
    </form>
  </section>
</template>
