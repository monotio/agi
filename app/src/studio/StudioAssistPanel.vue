<script setup lang="ts">
import { computed, inject, nextTick, ref, useId, useTemplateRef, watch } from "vue";
import UiButton from "../ui/UiButton.vue";
import UiExplain from "../ui/UiExplain.vue";
import UiIcon from "../ui/UiIcon.vue";
import { aiSettingsKey } from "../settings/useAiSettings.ts";
import StudioReferenceAttach, { type AttachedReference } from "./StudioReferenceAttach.vue";
import { walkableWords, type ScopeChip } from "./studioAssistText.ts";
import { explain } from "./studioTerms.ts";
import { STALE_TEXT, STALE_VIEW_TEXT, type StudioAssist } from "./useStudioAssist.ts";

/**
 * Ask: the scope chips the request is held to (the `scope` slot adds the
 * Studio's own: the lock chip, or Cel / Loop), the box, the request's compact
 * activity with its budget and Stop, and the candidate's verdict (Accept as
 * one undo step, Reject, Ask again…). The candidate itself is previewed on
 * the Studio's canvas. Without a connected provider the box offers Connect;
 * while the draft is frozen it is off. With a `referenceTarget`, reference
 * art can ride the request (StudioReferenceAttach): picked, dropped on the
 * section, or chosen from the art the game holds for that room or view; it
 * travels as handles and leaves the box when the request is sent. Studios
 * mount it only where the game's AI can run (not in the harness).
 */
const {
  assist,
  chips,
  changes = null,
  also = null,
  noun,
  empty,
  collapsible = false,
  referenceTarget = null,
} = defineProps<{
  assist: StudioAssist;
  chips: readonly ScopeChip[];
  /** What the candidate changes, counted on decoded pixels. */
  changes?: string | null;
  /** The other items it changes too (its side effects), by name. */
  also?: string | null;
  /** "picture" or "view", for the words. */
  noun: "picture" | "view";
  /** What to select first, when nothing is. */
  empty: string;
  /** Folded to its heading until opened, `/` pressed or a request is under way (a tight panel). */
  collapsible?: boolean;
  /** The room or view a reference attached here is for; none offers no attach control. */
  referenceTarget?: { readonly kind: "room" | "view"; readonly num: number } | null;
}>();

const emit = defineEmits<{
  /** The request failed behind a newer save: reload the game from storage. */
  reload: [];
}>();

const ai = inject(aiSettingsKey, null);
const headingId = useId();
const input = useTemplateRef("input");
const text = ref("");
/** "Ask again…" opened the box under a candidate. */
const refining = ref(false);
/** The creator unfolded a collapsible box. */
const unfolded = ref(false);
const bodyId = useId();
const staleId = useId();
/** Reference art attached to the next request. */
const attachedRefs = ref<AttachedReference[]>([]);
const references = useTemplateRef("references");
/** A file is dragged over the section: it can be dropped as a reference. */
const dropping = ref(false);
/** Why Ask is off, on its tooltip. */
const SEND_BLOCKED: Record<"unavailable" | "connect" | "frozen" | "selection", string> = {
  unavailable: "An AI model is required. Choose a model in Settings.",
  connect: "Connect AI first",
  frozen: "Editing waits for a Save or a reload",
  selection: "The selection is empty. Select an item or cel first.",
};
const sendBlocked = computed(() =>
  blocked.value !== null
    ? SEND_BLOCKED[blocked.value]
    : text.value.trim()
      ? undefined
      : "Type what should change",
);
const expanded = computed(
  () =>
    !collapsible ||
    unfolded.value ||
    ["running", "candidate", "declined", "failed"].includes(assist.phase.value),
);

const phase = computed(() => assist.phase.value);
const blocked = computed(() => assist.blocked.value);
const showInput = computed(
  () =>
    blocked.value !== "unavailable" &&
    blocked.value !== "connect" &&
    phase.value !== "running" &&
    (phase.value !== "candidate" || refining.value),
);
const staleText = computed(() => (noun === "picture" ? STALE_TEXT : STALE_VIEW_TEXT));
/** What the Studio edits, as the sentences name it. */
const thing = computed(() => (noun === "picture" ? "picture" : "character"));
/** A Walk lens candidate's walkable estimate, as the model was told it. */
const walkable = computed(() => {
  const candidate = assist.candidate.value;
  const scope = assist.asked.value?.scope;
  return candidate?.kind === "picture" &&
    candidate.walkable &&
    scope?.kind === "picture" &&
    scope.lens === "walk"
    ? walkableWords(candidate.walkable)
    : null;
});
const OUTCOMES: Partial<Record<string, string>> = {
  accepted: "Approved as one undo step. Undo takes it back.",
  rejected: "Rejected. The draft is unchanged.",
  stopped: "Stopped. The draft is unchanged.",
};
/** What the live region says: progress, the proposal, or how it ended. */
const spoken = computed(() => {
  const candidate = assist.candidate.value;
  switch (phase.value) {
    case "running":
      return assist.status.value;
    case "candidate":
      return assist.stale.value
        ? staleText.value
        : `Changes ready: ${candidate?.summary ?? ""} ${changes ?? ""} ${also ?? ""}`.trim();
    case "declined":
      return `The AI left the ${thing.value} as it was: ${assist.reply.value}`;
    case "failed":
      return assist.error.value;
    default:
      return OUTCOMES[phase.value] ?? "";
  }
});

async function submit(): Promise<void> {
  const asked = text.value;
  if (!asked.trim() || blocked.value !== null) return;
  text.value = "";
  refining.value = false;
  const referenceIds = attachedRefs.value.map((reference) => reference.id);
  attachedRefs.value = [];
  await assist.ask(asked, referenceIds);
}

const carriesFiles = (event: DragEvent): boolean =>
  referenceTarget !== null && (event.dataTransfer?.types.includes("Files") ?? false);
function onDragOver(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dropping.value = true;
}
function onDrop(event: DragEvent): void {
  dropping.value = false;
  if (!carriesFiles(event)) return;
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) void references.value?.attachFile(file);
}

/** Focus the box (the `/` key, the options bar's Ask); false when it cannot take focus. */
function focus(): boolean {
  unfolded.value = true;
  if (phase.value === "candidate") refining.value = true;
  void nextTick(() => input.value?.focus());
  return blocked.value !== "unavailable";
}

function again(): void {
  refining.value = true;
  void nextTick(() => input.value?.focus());
}

function accept(): void {
  if (assist.accept()) refining.value = false;
}

function reject(): void {
  assist.reject();
  refining.value = false;
}

// A side panel can hold the box below the fold: a proposal's verdict comes
// into view when it arrives, so Accept and Reject are never off-screen.
const verdict = useTemplateRef("verdict");
watch(phase, async (next) => {
  if (next !== "candidate") return;
  await nextTick();
  verdict.value?.scrollIntoView({ block: "nearest" });
});

const requestLimit = ref(5);
defineExpose({ focus });
</script>

<template>
  <section
    class="assist"
    :class="{ 'is-dropping': dropping }"
    :aria-labelledby="headingId"
    data-testid="studio-assist"
    @dragover="onDragOver"
    @dragleave="dropping = false"
    @drop="onDrop"
  >
    <h3 class="assist__title">
      <button
        v-if="collapsible"
        :id="headingId"
        type="button"
        class="assist__fold"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        data-testid="assist-fold"
        @click="unfolded = !expanded"
      >
        <UiIcon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="14" />Agent
      </button>
      <span v-else :id="headingId">Agent</span>
      <UiExplain v-bind="explain(noun === 'picture' ? 'ask-scope' : 'ask-cels')" />
      <span class="assist__ai" aria-hidden="true">AI</span>
    </h3>
    <div v-if="blocked !== 'unavailable' && expanded" :id="bodyId" class="assist__body">
      <div
        v-if="blocked !== 'selection' && chips.length > 0"
        class="assist__scope"
        aria-label="Scope"
        role="group"
      >
        <ul class="assist__chips">
          <li
            v-for="chip in chips"
            :key="chip.text"
            :class="{ 'is-lock': chip.lock }"
            :title="chip.title"
            data-testid="assist-chip"
          >
            <UiIcon v-if="chip.lock" name="lock" :size="12" />{{ chip.text }}
          </li>
        </ul>
        <slot name="scope" />
      </div>
      <p v-else class="assist__note">{{ empty }}</p>

      <div v-if="blocked === 'connect'" class="assist__connect">
        <p>Choose an AI model in Settings to request changes.</p>
        <UiButton
          size="sm"
          data-testid="assist-connect"
          :disabled="ai?.aiSettingsUnavailable.value ?? true"
          :title="
            (ai?.aiSettingsUnavailable.value ?? true)
              ? 'AI settings open once the running request finishes'
              : undefined
          "
          @click="ai?.openAiSettings($event, 'create')"
        >
          Connect
        </UiButton>
      </div>
      <p
        v-else-if="blocked === 'frozen' && phase !== 'running'"
        class="assist__note assist__frozen"
      >
        This {{ thing }} is read-only. <UiExplain v-bind="explain('view-only')" />
      </p>

      <ol v-if="assist.thread.value.length" class="assist__thread" aria-label="Conversation">
        <li
          v-for="(turn, index) in assist.thread.value"
          :key="index"
          :class="`is-${turn.role}`"
          data-testid="assist-turn"
        >
          <span class="assist__who">{{ turn.role === "creator" ? "You" : "AI" }}</span>
          {{ turn.text }}
        </li>
      </ol>

      <div v-if="phase === 'running'" class="assist__run" data-testid="assist-running">
        <ol v-if="assist.steps.value.length" class="assist__steps" data-testid="assist-steps">
          <li v-for="(step, index) in assist.steps.value" :key="index">{{ step }}</li>
        </ol>
        <p class="assist__status" data-testid="assist-status">
          <UiIcon name="sparkles" :size="12" />{{ assist.status.value }}
        </p>
        <template v-if="assist.task.value?.status === 'paused'">
          <p class="assist__warn">{{ assist.task.value.reason }}</p>
          <label v-if="!assist.task.value?.priceKnown">
            Requests
            <input v-model.number="requestLimit" type="number" min="1" step="1" />
          </label>
          <div class="assist__actions">
            <UiButton
              size="sm"
              variant="primary"
              @click="assist.resume(assist.task.value?.priceKnown ? undefined : requestLimit)"
              >Continue</UiButton
            >
            <UiButton size="sm" variant="danger" @click="assist.stop()">Discard</UiButton>
          </div>
        </template>
        <div v-else class="assist__row">
          <span class="assist__budget" data-testid="assist-budget">{{ assist.budget.value }}</span>
          <UiButton size="sm" data-testid="assist-stop" @click="assist.stop()">Stop</UiButton>
        </div>
      </div>

      <div
        v-else-if="phase === 'candidate' && assist.candidate.value"
        class="assist__candidate"
        data-testid="assist-candidate"
      >
        <p class="assist__summary" data-testid="assist-summary">
          {{ assist.candidate.value.summary }}
        </p>
        <p v-if="changes" class="assist__changes" data-testid="assist-changes">
          <UiIcon name="circle-check" :size="12" />{{ changes }}
        </p>
        <p v-if="also" class="assist__also" data-testid="assist-also">
          <UiIcon name="warning" :size="12" />{{ also }}
        </p>
        <template v-if="walkable">
          <p class="assist__walkable" data-testid="assist-walkable">{{ walkable.line }}</p>
          <p
            v-if="walkable.unchanged"
            class="assist__walkable is-muted"
            data-testid="assist-walkable-unchanged"
          >
            <UiIcon name="warning" :size="12" />{{ walkable.unchanged }}
          </p>
        </template>
        <ol class="assist__steps" data-testid="assist-steps">
          <li v-for="(step, index) in assist.steps.value" :key="index">{{ step }}</li>
        </ol>
        <p
          v-if="assist.stale.value"
          :id="staleId"
          class="assist__warn"
          role="alert"
          data-testid="assist-stale"
        >
          {{ staleText }}
        </p>
        <p
          v-else-if="assist.error.value"
          class="assist__warn"
          role="alert"
          data-testid="assist-error"
        >
          {{ assist.error.value }}
        </p>
        <div ref="verdict" class="assist__actions">
          <UiButton
            size="sm"
            variant="primary"
            icon="check"
            data-testid="assist-accept"
            :disabled="assist.stale.value"
            :aria-describedby="assist.stale.value ? staleId : undefined"
            @click="accept"
          >
            Approve
          </UiButton>
          <UiButton size="sm" icon="x" data-testid="assist-reject" @click="reject">
            Reject
          </UiButton>
          <UiButton size="sm" variant="ghost" @click="again">Follow up…</UiButton>
        </div>
      </div>

      <div v-else-if="phase === 'declined'" class="assist__declined" data-testid="assist-declined">
        <p>
          <strong>The AI left the {{ thing }} as it was:</strong>
          {{ assist.reply.value }}
        </p>
        <ol v-if="assist.steps.value.length" class="assist__steps" data-testid="assist-steps">
          <li v-for="(step, index) in assist.steps.value" :key="index">{{ step }}</li>
        </ol>
      </div>
      <template v-else-if="phase === 'failed'">
        <p class="assist__warn" role="alert" data-testid="assist-error">
          {{ assist.error.value }}
        </p>
        <div v-if="assist.behindStorage.value" class="assist__actions">
          <UiButton size="sm" data-testid="assist-reload" @click="emit('reload')">
            Reload game
          </UiButton>
        </div>
      </template>
      <p v-else-if="OUTCOMES[phase]" class="assist__note" data-testid="assist-outcome">
        {{ OUTCOMES[phase] }}
      </p>

      <form v-if="showInput" class="assist__form" @submit.prevent="submit">
        <textarea
          ref="input"
          v-model="text"
          class="assist__input"
          rows="3"
          :aria-labelledby="headingId"
          :placeholder="
            phase === 'candidate' || phase === 'declined'
              ? 'Follow up: what should change?'
              : 'What should change?'
          "
          :disabled="blocked !== null"
          data-testid="assist-input"
          @keydown.enter.exact.prevent="submit"
        ></textarea>
        <StudioReferenceAttach
          v-if="referenceTarget"
          ref="references"
          v-model="attachedRefs"
          :target="referenceTarget"
          :disabled="blocked !== null"
        />
        <div class="assist__row">
          <span class="assist__keys">/ focuses · Enter submits</span>
          <UiButton
            type="submit"
            size="sm"
            icon="sparkles"
            :disabled="blocked !== null || !text.trim()"
            :title="sendBlocked"
          >
            {{ phase === "candidate" ? "Follow up" : "Agent" }}
          </UiButton>
        </div>
      </form>
    </div>
    <p class="assist__sr" aria-live="polite" data-testid="assist-live">{{ spoken }}</p>
  </section>
</template>

<style scoped>
.assist {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--hairline);
}
.assist.is-dropping {
  outline: 2px dashed var(--action-line);
  outline-offset: -4px;
}
.assist__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.assist__ai {
  margin-left: auto;
  letter-spacing: 0;
  text-transform: none;
}
.assist__scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.assist__frozen {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.assist__body {
  display: grid;
  gap: var(--space-3);
}
.assist__fold {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  color: inherit;
  background: none;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  cursor: pointer;
}
.assist__fold:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.assist__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.assist__chips li {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 24px;
  box-sizing: border-box;
  padding: 0 var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-pill);
  color: var(--ink-2);
  background: var(--surface-2);
  font-size: var(--text-xs);
}
.assist__chips li.is-lock {
  border-color: var(--warn-line);
  color: var(--warn);
  background: var(--warn-soft);
}
.assist__note,
.assist__connect p,
.assist__declined p {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.assist__connect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.assist__declined p {
  color: var(--ink);
  font-size: var(--text-xs);
}
.assist__thread {
  display: grid;
  gap: var(--space-1);
  max-height: 160px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  font-size: var(--text-xs);
}
.assist__thread li {
  color: var(--ink-2);
}
.assist__thread li.is-ai {
  color: var(--ink);
}
.assist__who {
  margin-right: var(--space-1);
  color: var(--ink-3);
  font-weight: var(--weight-semibold);
}
.assist__steps {
  display: grid;
  gap: var(--space-0);
  margin: 0;
  padding: 0 0 0 var(--space-4);
  color: var(--ink-2);
  font: var(--text-2xs) / var(--leading) var(--font-mono);
}
.assist__status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--action);
  font-size: var(--text-xs);
}
.assist__run,
.assist__candidate {
  display: grid;
  gap: var(--space-2);
}
.assist__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.assist__budget,
.assist__keys {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.assist__summary {
  margin: 0;
  color: var(--ink);
  font-size: var(--text-xs);
}
.assist__changes {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--ok);
  font-size: var(--text-2xs);
}
.assist__also {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--warn);
  font-size: var(--text-2xs);
}
.assist__walkable {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-2xs);
}
.assist__walkable.is-muted {
  color: var(--ink-3);
}
.assist__warn {
  margin: 0;
  color: var(--warn);
  font-size: var(--text-xs);
}
.assist__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.assist__form {
  display: grid;
  gap: var(--space-2);
}
.assist__input {
  box-sizing: border-box;
  width: 100%;
  min-height: 56px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius);
  color: var(--ink);
  background: var(--surface-0);
  font: var(--text-xs) / var(--leading) var(--font-sans);
  resize: vertical;
}
.assist__input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.assist__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
