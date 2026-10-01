<script setup lang="ts">
/**
 * The running-source comparison: the frozen build's exact authored text on
 * the left, the live draft on the right. Read-only both ways — the frozen
 * side is what the stopped PC's source position names, and a moved-on draft
 * never inherits it.
 */
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue";
import { LOGIC_LANGUAGE_ID, monaco } from "../monacoLanguage.ts";

const props = defineProps<{
  /** The frozen build's authored source — what the test run executes. */
  running: string;
  /** The draft's current text. */
  draft: string;
  /** The held stop's authored line in the running source, if any. */
  stopLine?: number | null;
}>();

const heading = useTemplateRef("heading");
const host = useTemplateRef("host");
let diffEditor: monaco.editor.IStandaloneDiffEditor | undefined;
let attached: monaco.editor.IDiffEditorViewModel | undefined;
let pair: { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | undefined;
let stopDecorations: monaco.editor.IEditorDecorationsCollection | undefined;

function detach(): void {
  if (!diffEditor) return;
  diffEditor.setModel(null);
  attached?.dispose();
  attached = undefined;
}

function buildPair(): void {
  pair ??= {
    original: monaco.editor.createModel(
      "",
      LOGIC_LANGUAGE_ID,
      monaco.Uri.parse(`agi-debug-diff://running/${Math.random().toString(36).slice(2)}`),
    ),
    modified: monaco.editor.createModel(
      "",
      LOGIC_LANGUAGE_ID,
      monaco.Uri.parse(`agi-debug-diff://draft/${Math.random().toString(36).slice(2)}`),
    ),
  };
  if (pair.original.getValue() !== props.running) pair.original.setValue(props.running);
  if (pair.modified.getValue() !== props.draft) pair.modified.setValue(props.draft);
  if (!diffEditor) return;
  if (attached === undefined) {
    attached = diffEditor.createViewModel(pair);
    diffEditor.setModel(attached);
  }
  paintStopLine();
}

/** The frozen side's executing line — the draft side never takes it. */
function paintStopLine(): void {
  const original = pair?.original;
  if (!original || !diffEditor) return;
  stopDecorations ??= diffEditor.getOriginalEditor().createDecorationsCollection();
  const line = props.stopLine;
  if (line === null || line === undefined || line < 1 || line > original.getLineCount()) {
    stopDecorations.set([]);
    return;
  }
  stopDecorations.set([
    {
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: "debug-diff__stop",
        glyphMarginClassName: "debug-glyph-stop",
      },
    },
  ]);
}

onMounted(() => {
  const el = host.value;
  if (!el) return;
  diffEditor = monaco.editor.createDiffEditor(el, {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    theme: "vs-dark",
    ariaLabel: "Compare the running source with the draft",
  });
  buildPair();
});

watch(() => [props.running, props.draft], buildPair);
watch(() => props.stopLine, paintStopLine);

onBeforeUnmount(() => {
  detach();
  stopDecorations?.clear();
  diffEditor?.dispose();
  diffEditor = undefined;
  pair?.original.dispose();
  pair?.modified.dispose();
  pair = undefined;
});

/** The dock moves focus here when the comparison is opened on purpose. */
function focusHeading(): void {
  heading.value?.focus();
}

defineExpose({ focusHeading });
</script>

<template>
  <div
    class="debug-diff"
    role="region"
    aria-labelledby="debug-diff-heading"
    data-testid="debug-diff-view"
  >
    <h3 id="debug-diff-heading" ref="heading" class="debug-diff__heading" tabindex="-1">
      Source comparison
    </h3>
    <p class="debug-diff__labels">
      <span>Running source (frozen)</span>
      <span>Draft (current)</span>
    </p>
    <div ref="host" class="debug-diff__host" />
  </div>
</template>

<style scoped>
.debug-diff {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.debug-diff__heading {
  margin: 0;
  padding: var(--space-1) var(--space-3) 0;
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.debug-diff__heading:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.debug-diff__labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 0;
  padding: var(--space-1) var(--space-3);
  color: var(--ink-3);
  font: var(--weight-semibold) var(--text-2xs) / var(--leading) var(--font-sans);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.debug-diff__host {
  flex: 1;
  min-height: 0;
}
/* Monaco renders its DOM inside the host — reach through it. */
.debug-diff__host :deep(.debug-diff__stop) {
  background: color-mix(in srgb, var(--warn) 22%, transparent);
}
.debug-diff__host :deep(.debug-glyph-stop) {
  cursor: default;
}
.debug-diff__host :deep(.debug-glyph-stop)::before {
  content: "▶";
  color: var(--warn);
  font-size: var(--text-2xs);
}
</style>
