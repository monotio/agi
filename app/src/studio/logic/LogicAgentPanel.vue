<script setup lang="ts">
import { computed, inject, nextTick, ref, shallowRef, useId, useTemplateRef } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSegmented from "../../ui/UiSegmented.vue";
import { aiSettingsKey } from "../../settings/useAiSettings.ts";
import type { ProjectAssistProposal } from "../../agent/projectAssist.ts";
import { documentLabel } from "./logicWorkspace.ts";
import LogicAgentReview from "./LogicAgentReview.vue";
import type { LogicProjectAssist } from "./useLogicProjectAssist.ts";

/**
 * The Logic Studio assistant panel: Ask over the open project's captured
 * draft. A saved provider binds locally at mount (connect() makes no request;
 * only Ask talks to the provider). Proposals are reviewed as real diffs and
 * applied as one atomic transaction the panel can Undo changes on; manual
 * editing works whether or not AI is connected. The panel never Keeps,
 * installs, or touches a running game.
 */
const { assist, activeKey } = defineProps<{
  assist: LogicProjectAssist;
  /** The open document's key — the offered auto-apply scope. */
  activeKey: string | null;
}>();

const ai = inject(aiSettingsKey, null);
const headingId = useId();
const staleId = useId();
const input = useTemplateRef("input");
const text = ref("");
const reviewOpen = ref(false);
const reviewing = shallowRef<{
  readonly handle: ProjectAssistProposal;
  readonly applied: boolean;
} | null>(null);

const connected = computed(() => assist.connected.value);
const configured = computed(() => ai?.aiConfigured.value ?? false);
const pendingSummary = computed(() => assist.state.value.pendingProposal);
const result = computed(() => assist.lastResult.value);

/** The explicit auto-apply offer: only the open document's exact key. */
const autoScopeLabel = computed(() =>
  activeKey ? `Apply to ${documentLabel(activeKey)}` : "Apply automatically",
);
const approvalMode = computed<"review" | "auto">({
  get: () => assist.state.value.approval.mode,
  set: (value) => {
    if (value === "auto" && activeKey) assist.setApproval({ mode: "auto", scope: [activeKey] });
    else assist.setApproval({ mode: "review" });
  },
});
const approvalNote = computed(() => {
  const approval = assist.state.value.approval;
  if (approval.mode === "auto")
    return `Automatically applies changes within ${approval.scope
      .map((key) => documentLabel(key))
      .join(", ")}. Deletions require review.`;
  return "Every proposal waits for your review.";
});

const sendBlocked = computed(() => {
  if (!connected.value) return "Connect AI first";
  if (assist.running.value) return "A request is running";
  return text.value.trim() ? undefined : "Type what should change";
});

/** Steps for the request plus a refusal line when the last result refused. */
const refusedDiagnostics = computed(() =>
  result.value?.outcome === "refused" ? result.value.diagnostics : [],
);

function submit(): void {
  const asked = text.value;
  if (!asked.trim() || sendBlocked.value !== undefined) return;
  text.value = "";
  void assist.ask(asked);
}

function openReview(handle: ProjectAssistProposal, applied: boolean): void {
  reviewing.value = { handle, applied };
  reviewOpen.value = true;
}

function approve(): void {
  if (assist.accept()) reviewOpen.value = false;
}

function reject(): void {
  assist.reject();
  reviewOpen.value = false;
}

function askAgain(): void {
  reviewOpen.value = false;
  void nextTick(() => input.value?.focus());
}

function undoFromReview(): void {
  if (assist.undoChanges()) reviewOpen.value = false;
}

/** What the live region announces: progress, the proposal, or how it ended. */
const spoken = computed(() => {
  if (assist.phase.value === "running" || assist.phase.value === "paused")
    return assist.status.value;
  if (assist.error.value) return assist.error.value;
  const held = result.value;
  if (!held) return "";
  switch (held.outcome) {
    case "review":
      return `Proposal ready: ${held.label ?? ""} (${held.keys.map(documentLabel).join(", ")}).`;
    case "applied":
      return `Applied: ${held.label ?? ""}.`;
    case "stale":
      return "The draft changed while the AI worked; the proposal is stale.";
    case "refused":
      return `Refused: ${held.text}`;
    case "cancelled":
      return "Cancelled.";
    default:
      return held.text;
  }
});
const requestLimit = ref(5);
</script>

<template>
  <section class="lagent" :aria-labelledby="headingId" data-testid="logic-assistant">
    <h2 class="lagent__title">
      <span :id="headingId">Assistant</span>
      <UiChip
        v-if="connected"
        :tone="assist.state.value.approval.mode === 'auto' ? 'warn' : 'neutral'"
        data-testid="logic-assistant-mode-chip"
      >
        {{ assist.state.value.approval.mode === "auto" ? "Auto" : "Review" }}
      </UiChip>
      <span class="lagent__ai" aria-hidden="true">AI</span>
    </h2>

    <div v-if="!connected" class="lagent__connect">
      <template v-if="configured">
        <p class="lagent__note">
          Connect {{ ai?.aiModelLabel.value ?? "your provider" }} to ask for changes.
        </p>
        <UiButton size="sm" data-testid="logic-assistant-connect" @click="assist.connectNow()">
          Connect
        </UiButton>
      </template>
      <template v-else>
        <p class="lagent__note">Connect an AI provider to ask for changes.</p>
        <UiButton
          size="sm"
          data-testid="logic-assistant-connect"
          :disabled="ai?.aiSettingsUnavailable.value ?? true"
          :title="
            (ai?.aiSettingsUnavailable.value ?? true) ? 'AI settings are unavailable here' : ''
          "
          @click="ai?.openAiSettings($event, 'assistant')"
        >
          Connect AI
        </UiButton>
      </template>
    </div>

    <template v-else>
      <div class="lagent__provider" data-testid="logic-assistant-provider">
        <span class="lagent__model"
          >{{ assist.state.value.provider }} ·
          {{ assist.state.value.model ?? ai?.aiModelLabel.value }}</span
        >
        <UiButton
          variant="ghost"
          size="sm"
          data-testid="logic-assistant-disconnect"
          @click="assist.disconnectNow()"
        >
          Disconnect
        </UiButton>
      </div>

      <UiSegmented
        v-model="approvalMode"
        label="Approval mode"
        size="sm"
        :options="[
          {
            value: 'review',
            label: 'Review',
            title: 'Every proposal waits for your review',
            testid: 'logic-agent-mode-review',
          },
          {
            value: 'auto',
            label: autoScopeLabel,
            title:
              activeKey && assist.autoEligible.value
                ? `Automatically apply changes to ${documentLabel(activeKey)}`
                : 'Open a document to name the auto-apply scope',
            disabled: !activeKey || !assist.autoEligible.value,
            testid: 'logic-agent-mode-auto',
          },
        ]"
      />
      <p class="lagent__scope" data-testid="logic-assistant-scope">{{ approvalNote }}</p>

      <ol
        v-if="assist.turns.value.length"
        class="lagent__thread"
        aria-label="Conversation"
        data-testid="logic-assistant-thread"
      >
        <li v-for="(turn, index) in assist.turns.value" :key="index" :class="`is-${turn.role}`">
          <span class="lagent__who">{{ turn.role === "creator" ? "You" : "AI" }}</span>
          {{ turn.text }}
        </li>
      </ol>

      <div
        v-if="assist.phase.value === 'running' || assist.phase.value === 'paused'"
        class="lagent__run"
        data-testid="logic-assistant-running"
      >
        <ol
          v-if="assist.steps.value.length"
          class="lagent__steps"
          data-testid="logic-assistant-steps"
        >
          <li v-for="(step, index) in assist.steps.value" :key="index">{{ step }}</li>
        </ol>
        <p class="lagent__status" data-testid="logic-assistant-status">
          <UiIcon name="sparkles" :size="12" />{{ assist.status.value || "Working…" }}
        </p>
        <template v-if="assist.state.value.run?.status === 'paused'">
          <p class="lagent__warn" data-testid="logic-assistant-paused">
            {{ assist.state.value.run.reason }}
          </p>
          <label v-if="!assist.state.value.run?.priceKnown">
            Requests
            <input v-model.number="requestLimit" type="number" min="1" step="1" />
          </label>
          <div class="lagent__actions">
            <UiButton
              size="sm"
              variant="primary"
              data-testid="logic-assistant-continue"
              @click="assist.resume(assist.state.value.run?.priceKnown ? undefined : requestLimit)"
            >
              Continue
            </UiButton>
            <UiButton
              size="sm"
              variant="danger"
              data-testid="logic-assistant-cancel"
              @click="assist.cancel()"
            >
              Cancel
            </UiButton>
          </div>
        </template>
        <div v-else class="lagent__row">
          <span class="lagent__budget" data-testid="logic-assistant-budget">{{
            assist.budget.value
          }}</span>
          <UiButton size="sm" data-testid="logic-assistant-stop" @click="assist.stop()">
            Stop
          </UiButton>
        </div>
      </div>

      <div
        v-else-if="assist.pending.value"
        class="lagent__proposal"
        data-testid="logic-assistant-proposal"
      >
        <p class="lagent__summary" data-testid="logic-assistant-summary">
          {{ pendingSummary?.label ?? "Proposal" }}
        </p>
        <p class="lagent__keys" data-testid="logic-assistant-keys">
          {{ assist.pending.value.keys.map(documentLabel).join(", ") }}
          <template v-if="assist.pending.value.deletions.length">
            — deletes {{ assist.pending.value.deletions.map(documentLabel).join(", ") }}
          </template>
        </p>
        <p
          v-if="assist.pendingStale.value"
          :id="staleId"
          class="lagent__warn"
          role="alert"
          data-testid="logic-assistant-stale"
        >
          The draft changed while the AI worked. Approve is off until you ask again.
        </p>
        <p
          v-if="assist.acceptNote.value"
          class="lagent__warn"
          role="alert"
          data-testid="logic-assistant-refusal"
        >
          {{ assist.acceptNote.value }}
        </p>
        <div class="lagent__actions">
          <UiButton
            size="sm"
            variant="primary"
            data-testid="logic-assistant-review"
            @click="openReview(assist.pending.value!, false)"
          >
            Review changes
          </UiButton>
          <UiButton
            size="sm"
            variant="danger"
            data-testid="logic-assistant-reject"
            @click="reject()"
          >
            Reject
          </UiButton>
        </div>
      </div>

      <div
        v-else-if="assist.applied.value"
        class="lagent__proposal"
        data-testid="logic-assistant-applied"
      >
        <p class="lagent__summary">
          Applied: {{ assist.applied.value.label }} ({{
            assist.applied.value.keys.map(documentLabel).join(", ")
          }}). One change; use Keep when ready.
        </p>
        <p
          v-if="assist.undoNote.value"
          class="lagent__warn"
          role="alert"
          data-testid="logic-assistant-undo-note"
        >
          {{ assist.undoNote.value }}
        </p>
        <div class="lagent__actions">
          <UiButton
            size="sm"
            data-testid="logic-assistant-view-applied"
            @click="openReview(assist.applied.value!.handle, true)"
          >
            View changes
          </UiButton>
          <UiButton
            v-if="!assist.lastTransaction.value?.undone"
            size="sm"
            icon="undo"
            data-testid="logic-assistant-undo"
            :disabled="assist.undoNote.value !== undefined"
            title="Undo the assistant's change across every document it touched"
            @click="assist.undoChanges()"
          >
            Undo changes
          </UiButton>
          <UiButton
            v-else
            size="sm"
            icon="redo"
            data-testid="logic-assistant-redo"
            title="Redo the assistant's change"
            @click="assist.redoChanges()"
          >
            Redo changes
          </UiButton>
        </div>
      </div>

      <ul
        v-if="refusedDiagnostics.length"
        class="lagent__diagnostics"
        data-testid="logic-assistant-diagnostics"
      >
        <li
          v-for="(diag, index) in refusedDiagnostics"
          :key="index"
          :class="`lagent__diag lagent__diag--${diag.severity}`"
        >
          {{ diag.key ?? "project" }}: {{ diag.message }}
        </li>
      </ul>
      <p
        v-if="assist.error.value"
        class="lagent__warn"
        role="alert"
        data-testid="logic-assistant-error"
      >
        {{ assist.error.value }}
      </p>

      <form v-if="!assist.running.value" class="lagent__form" @submit.prevent="submit">
        <textarea
          ref="input"
          v-model="text"
          class="lagent__input"
          rows="3"
          :aria-labelledby="headingId"
          placeholder="What should change in this project?"
          data-testid="logic-assistant-input"
          @keydown.enter.exact.prevent="submit"
        ></textarea>
        <div class="lagent__row">
          <span class="lagent__hint">Enter asks</span>
          <UiButton
            type="submit"
            size="sm"
            icon="sparkles"
            :disabled="sendBlocked !== undefined"
            :title="sendBlocked"
            data-testid="logic-assistant-ask"
          >
            Ask
          </UiButton>
        </div>
      </form>
    </template>

    <LogicAgentReview
      v-if="reviewing"
      v-model:open="reviewOpen"
      :proposal="reviewing.handle"
      :stale="!reviewing.applied && assist.pendingStale.value"
      :applied="reviewing.applied"
      :diagnostics="result?.diagnostics ?? []"
      @approve="approve"
      @reject="reject"
      @ask-again="askAgain"
      @undo="undoFromReview"
      @close="reviewing = null"
    />
    <p class="lagent__sr" aria-live="polite" data-testid="logic-assistant-live">{{ spoken }}</p>
  </section>
</template>

<style scoped>
.lagent {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.lagent__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.lagent__ai {
  margin-left: auto;
  letter-spacing: 0;
  text-transform: none;
}
.lagent__connect,
.lagent__provider {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.lagent__connect {
  justify-content: flex-start;
}
.lagent__note {
  margin: 0;
  flex-basis: 100%;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.lagent__model {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.lagent__scope {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-2xs);
}
.lagent__thread {
  display: grid;
  gap: var(--space-1);
  max-height: 140px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  font-size: var(--text-xs);
}
.lagent__thread li {
  color: var(--ink-2);
}
.lagent__thread li.is-ai {
  color: var(--ink);
}
.lagent__who {
  margin-right: var(--space-1);
  color: var(--ink-3);
  font-weight: var(--weight-semibold);
}
.lagent__run,
.lagent__proposal {
  display: grid;
  gap: var(--space-2);
}
.lagent__steps {
  display: grid;
  gap: var(--space-0);
  margin: 0;
  padding: 0 0 0 var(--space-4);
  color: var(--ink-2);
  font: var(--text-2xs) / var(--leading) var(--font-mono);
}
.lagent__status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--action);
  font-size: var(--text-xs);
}
.lagent__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.lagent__budget,
.lagent__hint {
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.lagent__summary {
  margin: 0;
  color: var(--ink);
  font-size: var(--text-xs);
}
.lagent__keys {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-2xs) var(--font-mono);
}
.lagent__warn {
  margin: 0;
  color: var(--warn);
  font-size: var(--text-xs);
}
.lagent__diagnostics {
  margin: 0;
  padding: 0 0 0 var(--space-4);
  color: var(--ink-2);
  font-size: var(--text-2xs);
}
.lagent__diag--error {
  color: var(--danger);
}
.lagent__diag--warning {
  color: var(--warn);
}
.lagent__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.lagent__form {
  display: grid;
  gap: var(--space-2);
}
.lagent__input {
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
.lagent__input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.lagent__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
