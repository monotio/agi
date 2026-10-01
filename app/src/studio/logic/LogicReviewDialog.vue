<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, useTemplateRef, watch } from "vue";
import UiButton from "../../ui/UiButton.vue";
import UiChip from "../../ui/UiChip.vue";
import UiDialog from "../../ui/UiDialog.vue";
import { LOGIC_LANGUAGE_ID, monaco } from "./monacoLanguage.ts";
import { documentLabel } from "./logicWorkspace.ts";
import type { EditableCandidate } from "../../project/editableProject.ts";

/**
 * The immutable build review: the compiled candidate's selected documents
 * diffed against their kept baseline, the reference diagnostics on the built
 * image, and Keep — which admits exactly this candidate or nothing.
 */
export interface LogicReviewEntry {
  readonly key: string;
  readonly before: string | Uint8Array | undefined;
  readonly after: string | Uint8Array | undefined;
}

const { candidate, entries, dirty, selected, keeping, error } = defineProps<{
  /** Undefined when the current selection failed to build — the error explains. */
  readonly candidate: EditableCandidate | undefined;
  readonly entries: readonly LogicReviewEntry[];
  /** Every dirty document; the checked subset becomes the build's roots. */
  readonly dirty: readonly string[];
  /** The dirty roots this candidate (or failed build) was made from. */
  readonly selected: readonly string[];
  readonly keeping: boolean;
  readonly error: string | undefined;
}>();
const emit = defineEmits<{ keep: []; toggle: [key: string] }>();
const open = defineModel<boolean>("open", { required: true });

const activeKey = shallowRef<string | null>(null);
const diffHost = useTemplateRef("diffHost");
let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let attached: monaco.editor.IDiffEditorViewModel | undefined;
const pairPool = new Map<
  string,
  { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }
>();
const active = computed(() => entries.find((entry) => entry.key === activeKey.value) ?? entries[0]);
const textDiff = computed(
  () =>
    active.value !== undefined &&
    typeof active.value.before === "string" &&
    typeof active.value.after === "string",
);
const problems = computed(
  () =>
    candidate?.diagnostics.filter(
      (entry) => entry.severity === "error" || entry.severity === "warning",
    ) ?? [],
);

/** True when this candidate actually changed the document — new or edited bytes. */
function entryChanged(entry: LogicReviewEntry): boolean {
  const { before, after } = entry;
  if (before === undefined || after === undefined) return before !== after;
  if (typeof before === "string" || typeof after === "string") return before !== after;
  if (before.length !== after.length) return true;
  return before.some((byte, index) => byte !== after[index]);
}

function modelsFor(entry: LogicReviewEntry): {
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
} {
  const before = typeof entry.before === "string" ? entry.before : "";
  const after = typeof entry.after === "string" ? entry.after : "";
  const held = pairPool.get(entry.key);
  if (held) {
    // A rebuilt candidate recaptures the same keys: refresh the pooled pair
    // so the diff can never stand in for this entry's actual bytes.
    if (held.original.getValue() !== before) held.original.setValue(before);
    if (held.modified.getValue() !== after) held.modified.setValue(after);
    return held;
  }
  const language = entry.key.startsWith("logic:") ? LOGIC_LANGUAGE_ID : "plaintext";
  const pair = {
    original: monaco.editor.createModel(
      before,
      language,
      monaco.Uri.parse(`agi-logic-review://review/${encodeURIComponent(entry.key)}/before`),
    ),
    modified: monaco.editor.createModel(
      after,
      language,
      monaco.Uri.parse(`agi-logic-review://review/${encodeURIComponent(entry.key)}/after`),
    ),
  };
  pairPool.set(entry.key, pair);
  return pair;
}

/**
 * Detach the diff binding. The view model we own must be disposed while the
 * editor still references real text: disposing it cancels its pending worker
 * diff synchronously, and the pooled text models are only freed afterwards so
 * an in-flight computation can never resolve against a removed mirror.
 */
function detach(): void {
  if (!diffEditor) return;
  diffEditor.setModel(null);
  attached?.dispose();
  attached = undefined;
}

function show(entry: LogicReviewEntry | undefined): void {
  if (!diffEditor) return;
  const pair =
    entry !== undefined && typeof entry.before === "string" && typeof entry.after === "string"
      ? modelsFor(entry)
      : null;
  // A rebuilt candidate refreshes the pooled models in place; the owned view
  // model already covers that pair and recomputes from the content change.
  const current = attached?.model;
  if (current?.original === pair?.original && current?.modified === pair?.modified) return;
  detach();
  if (pair === null || !diffEditor) return;
  attached = diffEditor.createViewModel(pair);
  diffEditor.setModel(attached);
}

watch(
  [open, () => entries],
  async ([isOpen], previous) => {
    if (!isOpen) return;
    // Focus a document the candidate actually changed; an unchanged document
    // pulled in by the dependency closure stays listed but passive. A still
    // listed selection survives a candidate rebuild.
    const wasOpen = previous?.[0] === true;
    if (!wasOpen || !entries.some((entry) => entry.key === activeKey.value)) {
      activeKey.value = (entries.find(entryChanged) ?? entries[0])?.key ?? null;
    }
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
      ariaLabel: "Review the built changes",
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
watch(open, (isOpen) => {
  if (!isOpen) teardown();
});
onBeforeUnmount(teardown);

function byteCount(content: string | Uint8Array | undefined): string {
  if (content === undefined) return "absent";
  if (typeof content === "string") return `${content.length.toLocaleString()} characters`;
  return `${content.length.toLocaleString()} bytes`;
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    title="Review the build"
    size="lg"
    data-testid="logic-review-dialog"
  >
    <div class="logic-review">
      <p class="logic-review__lead">Keep saves the selected documents to your game.</p>
      <div
        v-if="dirty.length"
        class="logic-review__select"
        role="group"
        aria-label="Include in this Keep"
      >
        <label
          v-for="key in dirty"
          :key="key"
          class="logic-review__include"
          :data-testid="`logic-review-include-${key}`"
        >
          <input
            type="checkbox"
            :checked="selected.includes(key)"
            :disabled="keeping"
            @change="emit('toggle', key)"
          />
          {{ documentLabel(key) }}
        </label>
      </div>
      <div
        v-if="entries.length"
        class="logic-review__nav"
        role="list"
        aria-label="Changed documents"
      >
        <button
          v-for="entry in entries"
          :key="entry.key"
          type="button"
          role="listitem"
          class="logic-review__doc"
          :class="{ 'logic-review__doc--active': entry.key === active?.key }"
          :data-testid="`logic-review-doc-${entry.key}`"
          @click="activeKey = entry.key"
        >
          {{ documentLabel(entry.key) }}
          <UiChip v-if="entry.before === undefined" tone="ok">New</UiChip>
        </button>
      </div>
      <div
        v-show="textDiff"
        ref="diffHost"
        class="logic-review__diff"
        data-testid="logic-review-diff"
      ></div>
      <p v-if="!textDiff && active" class="logic-review__bytes">
        {{ byteCount(active.before) }} → {{ byteCount(active.after) }}. Byte diffs have no text view
        here.
      </p>
      <ul
        v-if="problems.length"
        class="logic-review__diagnostics"
        data-testid="logic-review-diagnostics"
      >
        <li
          v-for="(entry, index) in problems"
          :key="index"
          :class="`logic-review__diag logic-review__diag--${entry.severity}`"
        >
          {{ entry.document }}: {{ entry.message }}
        </li>
      </ul>
      <p v-if="error" class="logic-review__error" role="alert" data-testid="logic-review-error">
        {{ error }}
      </p>
    </div>
    <template #footer>
      <UiButton variant="ghost" data-testid="logic-review-cancel" @click="open = false">
        Cancel
      </UiButton>
      <UiButton
        variant="primary"
        :disabled="keeping || candidate === undefined"
        :title="candidate === undefined ? 'Select documents that build cleanly first' : undefined"
        data-testid="logic-keep-confirm"
        @click="emit('keep')"
      >
        {{ keeping ? "Keeping…" : "Keep" }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.logic-review {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
}
.logic-review__lead {
  margin: 0;
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-review__select {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
}
.logic-review__include {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
  cursor: pointer;
}
.logic-review__nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.logic-review__doc {
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
.logic-review__doc--active {
  border-color: var(--action-line);
  color: var(--action);
}
.logic-review__diff {
  height: 320px;
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.logic-review__bytes {
  margin: 0;
  color: var(--ink-3);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-review__diagnostics {
  margin: 0;
  padding: 0 0 0 var(--space-4);
  color: var(--ink-2);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
.logic-review__diag--error {
  color: var(--danger);
}
.logic-review__diag--warning {
  color: var(--warn);
}
.logic-review__error {
  margin: 0;
  color: var(--danger);
  font: var(--text-xs) / var(--leading) var(--font-sans);
}
</style>
