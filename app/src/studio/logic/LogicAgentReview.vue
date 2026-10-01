<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiDialog from "../../ui/UiDialog.vue";
import type { AgentCandidateDiagnostic } from "../../../../src/authoring/projectAgentCandidate.ts";
import type { ProjectAssistProposal } from "../../agent/projectAssist.ts";
import { LOGIC_LANGUAGE_ID, monaco } from "./monacoLanguage.ts";
import { documentLabel } from "./logicWorkspace.ts";

/**
 * The assistant proposal review: a real Monaco diff per changed document,
 * built only from the opaque handle's own before/after reads — the review
 * never reaches into draft state, so a stale or revoked proposal still shows
 * exactly what it offered. Approve applies the session-checked transaction;
 * Reject releases it; Ask again starts a fresh request on the current draft.
 * For an applied proposal the same diff explains what landed and offers the
 * atomic Undo changes.
 */
const {
  proposal,
  stale,
  applied,
  diagnostics = [],
} = defineProps<{
  readonly proposal: ProjectAssistProposal;
  /** The live draft moved past the proposal's base; Approve stays disabled. */
  readonly stale: boolean;
  /** True when this handle was already applied — the diff is what landed. */
  readonly applied: boolean;
  /** Compile/reference diagnostics the request ended with, if any. */
  readonly diagnostics?: readonly AgentCandidateDiagnostic[];
}>();
const emit = defineEmits<{
  close: [];
  approve: [];
  reject: [];
  "ask-again": [];
  undo: [];
}>();
const open = defineModel<boolean>("open", { required: true });

interface ReviewEntry {
  readonly key: string;
  readonly before: string | Uint8Array | undefined;
  readonly after: string | Uint8Array | null;
}

/** The proposal's exact detached changes; handle reads are review data only. */
const entries = computed<readonly ReviewEntry[]>(() =>
  proposal.changes().map((change) => ({
    key: change.key,
    before: proposal.before(change.key),
    after: change.content,
  })),
);

const activeKey = shallowRef<string | null>(null);
const diffHost = useTemplateRef("diffHost");
let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let attached: monaco.editor.IDiffEditorViewModel | undefined;
const pairPool = new Map<
  string,
  { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }
>();
const active = computed(() => entries.value.find((entry) => entry.key === activeKey.value));
const textDiff = computed(
  () =>
    active.value !== undefined &&
    (active.value.before === undefined || typeof active.value.before === "string") &&
    (active.value.after === null || typeof active.value.after === "string"),
);
const findings = computed(() =>
  diagnostics.filter((entry) => entry.severity === "error" || entry.severity === "warning"),
);

function modelsFor(entry: ReviewEntry): {
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
} {
  const held = pairPool.get(entry.key);
  const before = typeof entry.before === "string" ? entry.before : "";
  const after = typeof entry.after === "string" ? entry.after : "";
  if (held) {
    if (held.original.getValue() !== before) held.original.setValue(before);
    if (held.modified.getValue() !== after) held.modified.setValue(after);
    return held;
  }
  const language = entry.key.startsWith("logic:") ? LOGIC_LANGUAGE_ID : "plaintext";
  const pair = {
    original: monaco.editor.createModel(
      before,
      language,
      monaco.Uri.parse(`agi-logic-agent://review/${encodeURIComponent(entry.key)}/before`),
    ),
    modified: monaco.editor.createModel(
      after,
      language,
      monaco.Uri.parse(`agi-logic-agent://review/${encodeURIComponent(entry.key)}/after`),
    ),
  };
  pairPool.set(entry.key, pair);
  return pair;
}

/** Detach the owned view model before freeing the pooled text mirrors. */
function detach(): void {
  if (!diffEditor) return;
  diffEditor.setModel(null);
  attached?.dispose();
  attached = undefined;
}

function show(entry: ReviewEntry | undefined): void {
  if (!diffEditor) return;
  const pair = entry !== undefined && textDiff.value ? modelsFor(entry) : null;
  const current = attached?.model;
  if (current?.original === pair?.original && current?.modified === pair?.modified) return;
  detach();
  if (pair === null) return;
  attached = diffEditor.createViewModel(pair);
  diffEditor.setModel(attached);
}

watch(
  open,
  async (isOpen) => {
    if (!isOpen) {
      teardown();
      return;
    }
    activeKey.value = entries.value[0]?.key ?? null;
    await nextTick();
    if (!open.value || !diffHost.value) return;
    diffEditor ??= monaco.editor.createDiffEditor(diffHost.value, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: "vs-dark",
      ariaLabel: "Review the proposed changes",
    });
    show(active.value);
  },
  { immediate: true },
);
watch(active, (entry) => show(entry));

function teardown(): void {
  detach();
  diffEditor?.dispose();
  diffEditor = undefined;
  for (const pair of pairPool.values()) {
    pair.original.dispose();
    pair.modified.dispose();
  }
  pairPool.clear();
  activeKey.value = null;
}
onBeforeUnmount(teardown);

function byteCount(content: string | Uint8Array | null | undefined): string {
  if (content === undefined || content === null) return "absent";
  if (typeof content === "string") return `${content.length.toLocaleString()} characters`;
  return `${content.length.toLocaleString()} bytes`;
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    :title="applied ? 'Applied changes' : 'Review the proposal'"
    size="lg"
    data-testid="logic-agent-review"
    @closed="emit('close')"
  >
    <div class="agent-review">
      <p class="agent-review__lead" data-testid="logic-agent-review-lead">
        {{ proposal.label }}: {{ entries.length }}
        {{ entries.length === 1 ? "document" : "documents" }}.
        <template v-if="applied">Already applied as one change.</template>
        <template v-else>Approve applies these changes to your draft.</template>
      </p>
      <div
        v-if="entries.length"
        class="agent-review__nav"
        role="list"
        aria-label="Changed documents"
      >
        <button
          v-for="entry in entries"
          :key="entry.key"
          type="button"
          role="listitem"
          class="agent-review__doc"
          :class="{ 'agent-review__doc--active': entry.key === active?.key }"
          :data-testid="`logic-agent-doc-${entry.key}`"
          @click="activeKey = entry.key"
        >
          {{ documentLabel(entry.key) }}
          <UiChip v-if="entry.before === undefined" tone="ok">New</UiChip>
          <UiChip v-else-if="entry.after === null" tone="danger">Delete</UiChip>
        </button>
      </div>
      <div
        v-show="textDiff && active"
        ref="diffHost"
        class="agent-review__diff"
        data-testid="logic-agent-diff"
      ></div>
      <p v-if="active && !textDiff" class="agent-review__bytes">
        Binary document: {{ byteCount(active.before) }} → {{ byteCount(active.after) }}.
      </p>
      <ul
        v-if="findings.length"
        class="agent-review__diagnostics"
        data-testid="logic-agent-diagnostics"
      >
        <li
          v-for="(entry, index) in findings"
          :key="index"
          :class="`agent-review__diag agent-review__diag--${entry.severity}`"
        >
          {{ entry.key ?? "project" }}: {{ entry.message }}
        </li>
      </ul>
      <p
        v-if="stale && !applied"
        class="agent-review__stale"
        role="alert"
        data-testid="logic-agent-stale"
      >
        You changed the draft while the AI worked. The diff above still shows what it proposed. Ask
        again to get a proposal for the current draft.
      </p>
    </div>
    <template #footer>
      <template v-if="applied">
        <UiButton
          variant="secondary"
          icon="undo"
          data-testid="logic-agent-applied-undo"
          @click="emit('undo')"
        >
          Undo changes
        </UiButton>
      </template>
      <template v-else>
        <UiButton variant="ghost" data-testid="logic-agent-again" @click="emit('ask-again')">
          Ask again…
        </UiButton>
        <UiButton variant="danger" data-testid="logic-agent-reject" @click="emit('reject')">
          Reject
        </UiButton>
        <UiButton
          variant="primary"
          icon="check"
          :disabled="stale"
          :title="stale ? 'The draft changed since this proposal' : 'Apply the proposed changes'"
          data-testid="logic-agent-approve"
          @click="emit('approve')"
        >
          Approve
        </UiButton>
      </template>
    </template>
  </UiDialog>
</template>

<style scoped>
.agent-review {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}
.agent-review__lead {
  margin: 0;
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.agent-review__nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.agent-review__doc {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  background: var(--surface-sunken);
  font: var(--text-xs) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.agent-review__doc--active {
  border-color: var(--action-line);
  color: var(--action);
}
.agent-review__diff {
  height: 320px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.agent-review__bytes {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.agent-review__diagnostics {
  margin: 0;
  padding: 0 0 0 var(--space-4);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.agent-review__diag--error {
  color: var(--danger);
}
.agent-review__diag--warning {
  color: var(--warn);
}
.agent-review__stale {
  margin: 0;
  color: var(--warn);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
</style>
