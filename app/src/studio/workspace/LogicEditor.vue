<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch, ref, computed } from "vue";
import type { BindingInfo } from "../../../../src/logic/projectNames.ts";
import BindingDetails from "../../shell/BindingDetails.vue";
import { parseWordsTok } from "../../../../src/logic/words.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { readInventoryObjects } from "../../../../src/authoring/inventory.ts";
import { PROFILES } from "../../../../src/runtime/profile.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { offsetAt } from "../../../../src/logic/lspTypes.ts";
import type { WorkspaceEdit } from "../../../../src/logic/lspTypes.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { LogicAnalysisClient } from "../logic/analysisClient.ts";
import { monaco, LOGIC_LANGUAGE_ID, registerLogicModel } from "../logic/monacoLanguage.ts";
const props = defineProps<{
  readOnly?: boolean;
  documentKey: string;
  source: string;
  snapshot: ProjectSnapshot;
  profileId: ProfileId;
  active: boolean;
  breakpoints?: readonly number[] | undefined;
  stoppedLine?: number | undefined;
  runningSource?: string | undefined;
  location?: { line: number; serial: number } | undefined;
}>();
const emit = defineEmits<{
  edit: [source: string];
  breakpoint: [line: number];
  selection: [context: { label: string; text: string } | null];
}>();
const binding = ref<BindingInfo>();
const renameBinding = ref(false);
function onBinding(info: BindingInfo, action: "open" | "rename"): void {
  if (action === "open" && ["sound", "picture", "view", "logic"].includes(info.kind)) {
    workspace.open(`${info.kind}:${info.num}`, true);
    return;
  }
  renameBinding.value = action === "rename";
  binding.value = info;
}
const showRunning = ref(false);
const differs = computed(
  () => props.runningSource !== undefined && props.runningSource !== props.source,
);
const root = useTemplateRef("root");
const client = new LogicAnalysisClient();
const engine = useEngineApi();
const workspace = useWorkspaceEditor();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let language: ReturnType<typeof registerLogicModel> | undefined;
let observer: ResizeObserver | undefined;
let syncing = false;
let layoutFrame = 0;
let decorations: monaco.editor.IEditorDecorationsCollection | undefined;
let editView: monaco.editor.ICodeEditorViewState | null = null;
function decorate(): void {
  if (!editor || !model) return;
  const exact = props.runningSource === undefined || model.getValue() === props.runningSource;
  const rows: monaco.editor.IModelDeltaDecoration[] = exact
    ? (props.breakpoints ?? []).map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          glyphMarginClassName: "workspace-breakpoint",
          glyphMarginHoverMessage: { value: VOCABULARY.breakpoint.help },
        },
      }))
    : [];
  if (exact && props.stoppedLine)
    rows.push({
      range: new monaco.Range(props.stoppedLine, 1, props.stoppedLine, 1),
      options: {
        isWholeLine: true,
        className: "workspace-stopped-line",
        glyphMarginClassName: "workspace-stop-arrow",
      },
    });
  decorations?.set(rows);
}
function navigate(line: number): void {
  editor?.setPosition({ lineNumber: line, column: 1 });
  editor?.revealLineInCenterIfOutsideViewport(line);
}
function syncSource(source: string): void {
  if (!model || model.getValue() === source) {
    decorate();
    return;
  }
  syncing = true;
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: source }], () => null);
  syncing = false;
  decorate();
}
function layout(): void {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    editor?.layout();
    const position = editor?.getPosition();
    if (props.active && editor?.hasTextFocus() && position)
      editor.revealPositionInCenterIfOutsideViewport(position);
    if (props.active && props.stoppedLine && model?.getValue() === props.runningSource)
      editor?.revealLineInCenterIfOutsideViewport(props.stoppedLine);
  });
}
function analysis(): void {
  if (!model) return;
  const documents: Record<string, { version: number; source: string }> = {};
  for (const key of props.snapshot.keys) {
    const doc = props.snapshot.read(key);
    if (key.startsWith("logic:") && typeof doc?.content === "string")
      documents[key] = { version: doc.version, source: doc.content };
  }
  documents[props.documentKey] = { version: model.getVersionId(), source: model.getValue() };
  let objects: string[] = [];
  let words: [string, number][] = [];
  let bindings: Record<string, { num: number }> = {};
  try {
    const text = props.snapshot.read("words")?.content;
    if (typeof text === "string") words = JSON.parse(text) as [string, number][];
    else if (text) words = parseWordsTok(text).map(({ word, id }) => [word, id]);
    const inventory = props.snapshot.read("inventory")?.content;
    if (typeof inventory === "string")
      objects = (JSON.parse(inventory) as { name: string }[]).map((item) => item.name);
    else if (inventory instanceof Uint8Array)
      objects = readInventoryObjects(inventory, PROFILES[props.profileId]).map((item) => item.name);
    const names = props.snapshot.read("bindings")?.content;
    if (typeof names === "string") bindings = readBindingsDocument(names);
  } catch {
    client.invalidateContext("Fix the WORDS or names document to restore code intelligence.");
    return;
  }
  const changed = client.setProject({
    revision: props.snapshot.revision,
    profileId: props.profileId,
    words,
    objects,
    bindings,
    bindingDocument: {
      uri: "agi-project:///bindings.json",
      source: (props.snapshot.read("bindings")?.content as string | undefined) ?? "{}",
    },
    documents,
  });
  if (changed) void language?.refreshDiagnostics();
}
async function applyProjectEdit(edit: WorkspaceEdit, label: string): Promise<void> {
  const revision = props.snapshot.revision;
  await workspace.flush.value?.();
  const session = engine.getProjectSession();
  const base = session?.model.capture();
  if (!session || !base || base.revision !== revision)
    throw new Error("The project changed. Retry the rename.");
  const changes = edit.documentChanges.map((change) => {
    const key =
      change.textDocument.uri === "agi-project:///bindings.json"
        ? "bindings"
        : base.keys.find(
            (key) => key.startsWith("logic:") && client.uri(key) === change.textDocument.uri,
          );
    const source = key ? base.read(key)?.content : undefined;
    if (!key || typeof source !== "string")
      throw new Error("The source changed. Retry the rename.");
    if (key === props.documentKey && source !== model?.getValue())
      throw new Error("The source changed. Retry the rename.");
    const edits = change.edits
      .map((entry) => ({
        start: offsetAt(source, entry.range.start),
        end: offsetAt(source, entry.range.end),
        text: entry.newText,
      }))
      .sort((a, b) => b.start - a.start);
    let content = source;
    for (const entry of edits)
      content = content.slice(0, entry.start) + entry.text + content.slice(entry.end);
    return { key, content };
  });
  const outcome = await session.submit({
    proposal: session.model.propose(base, label, changes),
    label,
    origin: "logic",
    author: "creator",
  });
  if (
    !["committed", "unchanged", "diagnostics", "restartRequired", "deferred"].includes(
      outcome.status,
    )
  )
    throw new Error("The project could not apply this rename. Retry at a safe game boundary.");
}
onMounted(() => {
  model = monaco.editor.createModel(
    props.source,
    LOGIC_LANGUAGE_ID,
    monaco.Uri.parse(`agi-workspace://${crypto.randomUUID()}/${props.documentKey}`),
  );
  language = registerLogicModel(model, {
    client,
    documentKey: props.documentKey,
    applyProjectEdit,
    onBinding,
  });
  editor = monaco.editor.create(root.value!, {
    readOnly: props.readOnly,
    domReadOnly: props.readOnly,
    model,
    theme: "vs-dark",
    "semanticHighlighting.enabled": true,
    automaticLayout: false,
    editContext: false,
    autoIndent: "none",
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: "on",
    glyphMargin: true,
    scrollBeyondLastLine: false,
    wordWrap: "on",
    tabSize: 2,
    padding: { top: 16, bottom: 16 },
  });
  decorations = editor.createDecorationsCollection();
  editor.onMouseDown((event) => {
    if (
      event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
      event.target.position
    )
      emit("breakpoint", event.target.position.lineNumber);
  });
  editor.onDidChangeCursorSelection(({ selection }) => {
    emit(
      "selection",
      selection.isEmpty()
        ? null
        : {
            label: `${props.documentKey.replace(":", " ").toUpperCase()} lines ${selection.startLineNumber}–${selection.endLineNumber}`,
            text: model!.getValueInRange(selection),
          },
    );
  });
  model.onDidChangeContent(() => {
    if (!syncing && model) {
      emit("edit", model.getValue());
      analysis();
      decorate();
    }
  });
  observer = new ResizeObserver(layout);
  observer.observe(root.value!);
  analysis();
  decorate();
  revealLocation();
  revealName();
});
watch(
  () => props.source,
  (source) => {
    if (showRunning.value) return;
    const state = editor?.saveViewState();
    syncSource(source);
    if (state) editor?.restoreViewState(state);
    analysis();
  },
);
watch(
  () => props.readOnly,
  (readOnly) => {
    editor?.updateOptions({
      readOnly: readOnly || showRunning.value,
      domReadOnly: readOnly || showRunning.value,
    });
  },
);
watch(showRunning, (show) => {
  if (show) editView = editor?.saveViewState() ?? null;
  editor?.updateOptions({ readOnly: show || props.readOnly, domReadOnly: show || props.readOnly });
  syncSource(show ? (props.runningSource ?? props.source) : props.source);
  if (show && props.stoppedLine) navigate(props.stoppedLine);
  else if (editView) editor?.restoreViewState(editView);
});
watch(
  () => [props.breakpoints, props.stoppedLine, props.runningSource],
  () => {
    if (showRunning.value) syncSource(props.runningSource ?? props.source);
    decorate();
  },
);
watch(() => props.snapshot, analysis);
function revealLocation(): void {
  if (!props.location || !editor) return;
  editor.setPosition({ lineNumber: props.location.line, column: 1 });
  editor.revealLineInCenter(props.location.line);
  editor.focus();
}
watch(() => props.location, revealLocation);
function revealName(): void {
  const location = workspace.nameLocation.value;
  if (!props.active || location?.key !== props.documentKey) return;
  navigate(location.line);
  editor?.focus();
}
watch(() => [workspace.nameLocation.value, props.active], revealName, { flush: "post" });
watch(
  () => props.active,
  (active) => {
    if (active) layout();
  },
);
onBeforeUnmount(() => {
  cancelAnimationFrame(layoutFrame);
  observer?.disconnect();
  // Model-change listeners cancel their work before markers and providers retire.
  editor?.setModel(null);
  editor?.dispose();
  language?.dispose();
  model?.dispose();
  client.dispose();
});
defineExpose({
  cursor: () => editor?.getSelection()?.getStartPosition() ?? editor?.getPosition(),
  displayedSource: () => model?.getValue(),
  focus: () => editor?.focus(),
  navigate,
});
</script>
<template>
  <div class="workspace-logic-surface">
    <div v-if="differs || showRunning" class="workspace-running-source">
      <span>{{ showRunning ? "Running source" : "The game is running an earlier build." }}</span>
      <button v-if="!showRunning" @click="showRunning = true">Show running source</button>
      <button v-else @click="showRunning = false">Return to editing</button>
    </div>
    <BindingDetails
      v-if="binding"
      :info="binding"
      :rename="renameBinding"
      @close="binding = undefined"
      @renamed="
        binding = $event;
        renameBinding = false;
      "
    />
    <div ref="root" class="workspace-monaco" data-testid="workspace-logic-editor"></div>
  </div>
</template>
<style scoped>
.workspace-logic-surface {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.workspace-running-source {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-2);
  background: var(--surface-1);
  font-size: var(--text-sm);
}
.workspace-running-source button {
  font: inherit;
  color: var(--action);
  background: transparent;
  border: 0;
  cursor: pointer;
}
:deep(.workspace-breakpoint) {
  background: var(--danger);
  border-radius: 50%;
  transform: scale(0.55);
}
:deep(.workspace-stopped-line) {
  background: color-mix(in srgb, var(--action) 20%, transparent);
}
:deep(.workspace-stop-arrow)::after {
  content: "➜";
  color: var(--action);
}
.workspace-monaco {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--surface-0);
}
</style>
