<script setup lang="ts">
import { documentLabel } from "../../../../src/logic/numberedLabels.ts";
import { layoutDragging } from "../../play/layoutDrag.ts";
import {
  onMounted,
  nextTick,
  onBeforeUnmount,
  onWatcherCleanup,
  useTemplateRef,
  watch,
  ref,
  computed,
} from "vue";
import type { WorkspaceDebug } from "./workspaceDebug.ts";
import type { LogicDebugValue } from "../../../../src/logic/lspTypes.ts";
import type { PausedLogicState } from "../logic/monacoLanguage.ts";
import type { BindingInfo } from "../../../../src/logic/projectNames.ts";
import BindingDetails from "../../shell/BindingDetails.vue";
import { parseWordsTok } from "../../../../src/logic/words.ts";
import { VOCABULARY } from "../../../../src/vocabulary.ts";
import { readInventoryObjects } from "../../../../src/authoring/inventory.ts";
import { PROFILES } from "../../../../src/runtime/profile.ts";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import {
  sameProjectContent,
  type ProjectContent,
} from "../../../../src/authoring/projectContent.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { offsetAt } from "../../../../src/logic/lspTypes.ts";
import type { WorkspaceEdit } from "../../../../src/logic/lspTypes.ts";
import { useEngineApi } from "../../engine/engineContext.ts";
import { useWorkspaceEditor } from "../../shell/workspaceEditor.ts";
import { workspaceReferenceAt, workspaceReferenceInfo } from "../../shell/workspaceNames.ts";
import { LogicAnalysisClient } from "../logic/analysisClient.ts";
import {
  monaco,
  LOGIC_LANGUAGE_ID,
  registerLogicModel,
  registerLogicContextMenu,
} from "../logic/monacoLanguage.ts";
import { useOptionalCommands } from "../../shell/commands/commandContext.ts";
import { useLogicFormatSettings } from "../../settings/logicFormat.ts";
import { formatLogic } from "../../../../src/logic/format.ts";
import { expandProjectLogic } from "../../../../src/authoring/projectLogic.ts";
import { systemBindings } from "../../../../src/logic/systemNames.ts";
import { logicKeySheet } from "../studioHelp.ts";
const props = defineProps<{
  readOnly?: boolean;
  documentKey: string;
  source: string;
  snapshot: ProjectSnapshot;
  profileId: ProfileId;
  active: boolean;
  breakpoints?: readonly number[] | undefined;
  stoppedLine?: number | undefined;
  debug?: WorkspaceDebug | undefined;
  runningSource?: string | undefined;
  location?: { line: number; serial: number } | undefined;
}>();
const emit = defineEmits<{
  edit: [source: string];
  typingEnd: [];
  breakpoint: [line: number];
  selection: [context: { label: string; text: string } | null];
  problems: [entries: readonly { message: string; line: number }[]];
}>();
const binding = ref<BindingInfo>();
const renameBinding = ref(false);
async function findReferences(): Promise<void> {
  const position = editor?.getPosition();
  if (!position || !model) return;
  const queriedModel = model;
  const version = model.getVersionId();
  const params = { position: { line: position.lineNumber - 1, character: position.column - 1 } };
  try {
    const info =
      (await client.request(props.documentKey, "agi/bindingInfo", params)) ??
      workspaceReferenceAt(
        {
          keys: props.snapshot.keys,
          read: (key) =>
            key === props.documentKey
              ? { key, content: queriedModel.getValue(), version }
              : props.snapshot.read(key),
          version: (key) => (key === props.documentKey ? version : props.snapshot.version(key)),
        },
        props.profileId,
        props.documentKey,
        params.position,
      );
    const references = info
      ? null
      : await client.request(props.documentKey, "textDocument/references", params);
    if (queriedModel.isDisposed() || queriedModel.getVersionId() !== version) return;
    binding.value = undefined;
    workspace.findReferences(
      info ?? {
        name: model.getWordAtPosition(position)?.word ?? "References",
        kind: "symbol",
        num: 0,
        uses: (references ?? []).flatMap((use) => {
          const key = props.snapshot.keys.find((key) => client.uri(key) === use.uri);
          return key
            ? [{ key, uri: use.uri, range: use.range, role: "Used" as const, text: "" }]
            : [];
        }),
      },
    );
  } catch (cause) {
    if (queriedModel.isDisposed() || queriedModel.getVersionId() !== version) return;
    workspace.error.value = `Could not find references: ${cause instanceof Error ? cause.message : String(cause)}. Try again.`;
  }
}
function onBinding(info: BindingInfo, action: "open" | "rename"): void {
  // Close the focused hover before the form opens: its close restores editor focus.
  editor
    ?.getContribution<monaco.editor.IEditorContribution & { hideContentHover(): void }>(
      "editor.contrib.contentHover",
    )
    ?.hideContentHover();
  if (action === "open" && ["sound", "picture", "view", "logic"].includes(info.kind)) {
    workspace.open(`${info.kind}:${info.num}`);
    return;
  }
  if (action === "open") {
    binding.value = undefined;
    workspace.findReferences(info);
    return;
  }
  renameBinding.value = true;
  binding.value = workspaceReferenceInfo(props.snapshot, props.profileId, info);
}
const showRunning = ref(false);
const differs = computed(
  () => props.runningSource !== undefined && props.runningSource !== props.source,
);
const root = useTemplateRef("root");
const client = new LogicAnalysisClient();
const engine = useEngineApi();
const workspace = useWorkspaceEditor();
const { formatOnLeaving } = useLogicFormatSettings();
const commands = useOptionalCommands();
watch(
  () => props.active,
  (active) => {
    if (!active || !commands) return;
    onWatcherCleanup(
      commands.register({
        id: `logic.format.${props.documentKey}`,
        title: "Format document",
        keys: [{ key: "Shift+Alt+F", textInput: true }],
        when: (context) =>
          props.active && !props.readOnly && !showRunning.value && !context.dialogOpen,
        run: () => editor?.getAction("editor.action.formatDocument")?.run(),
      }),
    );
  },
  { immediate: true },
);
let formatting = false;
function beginFormatting(): void {
  emit("typingEnd");
  formatting = true;
}
/** Synchronous at the leaving boundary so a closing tab emits its draft before disposal. */
function formatOnLeave(): void {
  if (!formatOnLeaving.value || props.readOnly || showRunning.value || !model || !editor) return;
  const source = model.getValue();
  const bindings = contextCache?.bindings ?? {};
  const edits = formatLogic(source, {
    prelude: expandProjectLogic(source, bindings, true).prelude,
    builtins: systemBindings(bindings),
  });
  if (!edits.length) return;
  beginFormatting();
  editor.pushUndoStop();
  editor.executeEdits(
    "agi.formatOnLeave",
    edits.map((edit) => ({ range: model!.getFullModelRange(), text: edit.newText })),
  );
  editor.pushUndoStop();
}
function leaveEditor(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && root.value?.contains(event.relatedTarget)) return;
  formatOnLeave();
  emit("typingEnd");
}
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let language: ReturnType<typeof registerLogicModel> | undefined;
const valueEditor = ref<{
  slot: number;
  value: number;
  paused: PausedLogicState;
  position: monaco.IPosition;
  left: number;
  top: number;
}>();
const valuePanel = useTemplateRef("valuePanel");
const valueInput = useTemplateRef("valueInput");
function hideHover(): void {
  editor
    ?.getContribution<monaco.editor.IEditorContribution & { hideContentHover(): void }>(
      "editor.contrib.contentHover",
    )
    ?.hideContentHover();
}
function showValueHover(position: monaco.IPosition): void {
  editor?.setPosition(position);
  editor?.trigger("agi-logic", "editor.action.showHover", { focus: true });
}
function closeValue(): void {
  valueEditor.value = undefined;
  editor?.focus();
}
function outsideValue(event: PointerEvent): void {
  if (
    valueEditor.value &&
    event.target instanceof Node &&
    !valuePanel.value?.contains(event.target)
  )
    closeValue();
}
function pausedState(): PausedLogicState | undefined {
  return model
    ? props.debug?.logicState(Number(props.documentKey.slice(6)), model.getValue())
    : undefined;
}
function sameStop(paused: PausedLogicState): boolean {
  const current = pausedState();
  return current?.epoch === paused.epoch && current.stopId === paused.stopId;
}
async function onDebugValue(
  value: LogicDebugValue,
  paused: PausedLogicState,
  position: monaco.IPosition,
): Promise<void> {
  if (!sameStop(paused) || !props.debug || props.debug.state.busy) return;
  hideHover();
  if (value.kind === "flag") {
    await props.debug.run(() =>
      props.debug!.setValue("flag", value.slot, paused.flags[value.slot] ? 0 : 1),
    );
    if (pausedState()) showValueHover(position);
    return;
  }
  const at = editor?.getScrolledVisiblePosition(position);
  valueEditor.value = {
    slot: value.slot,
    value: paused.vars[value.slot]!,
    paused,
    position,
    left: Math.max(0, Math.min(at?.left ?? 0, (root.value?.clientWidth ?? 240) - 240)),
    top: (at?.top ?? 0) + (at?.height ?? 20) + (root.value?.offsetTop ?? 0),
  };
  await nextTick();
  const entry = valueEditor.value;
  const panel = valuePanel.value;
  const surface = root.value;
  if (entry && panel && surface) {
    const bounds = surface.getBoundingClientRect();
    const host = panel.offsetParent!.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const left = bounds.left - host.left;
    const top = bounds.top - host.top;
    entry.left = Math.max(left, Math.min(entry.left, left + bounds.width - size.width));
    entry.top = Math.max(top, Math.min(entry.top, top + bounds.height - size.height));
    await nextTick();
  }
  valueInput.value?.focus();
  valueInput.value?.select();
}
async function setHoverValue(): Promise<void> {
  const entry = valueEditor.value;
  if (!entry || !sameStop(entry.paused) || !props.debug) {
    closeValue();
    return;
  }
  const value = Number(entry.value);
  if (!Number.isInteger(value) || value < 0 || value > 255) return;
  await props.debug.run(() => props.debug!.setValue("variable", entry.slot, value));
  valueEditor.value = undefined;
  if (pausedState()) showValueHover(entry.position);
}
watch(
  () => props.debug?.stopped.value,
  () => {
    valueEditor.value = undefined;
    hideHover();
    language?.refreshDebug();
  },
);
let observer: ResizeObserver | undefined;
let syncing = false;
let layoutFrame = 0;
let decorations: monaco.editor.IEditorDecorationsCollection | undefined;
/** The dot left of a line number under the pointer: where a click sets a breakpoint. */
let breakpointHint: monaco.editor.IEditorDecorationsCollection | undefined;
function hintBreakpoint(line: number | undefined): void {
  breakpointHint?.set(
    line === undefined || props.breakpoints?.includes(line)
      ? []
      : [
          {
            range: new monaco.Range(line, 1, line, 1),
            options: {
              glyphMarginClassName: "workspace-breakpoint-hint",
              glyphMarginHoverMessage: { value: "Click to stop the game here (F9)" },
            },
          },
        ],
  );
}
let editView: monaco.editor.ICodeEditorViewState | null = null;
let contextMenu: monaco.IDisposable | undefined;
let markerSubscription: monaco.IDisposable | undefined;
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
watch(layoutDragging, (dragging) => {
  if (!dragging) layout();
});
function layout(): void {
  if (layoutDragging.value) return;
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
let contextCache:
  | {
      profile: string;
      inputs: readonly (ProjectContent | undefined)[];
      words: [string, number][];
      objects: string[];
      inventory: { name: string; startingRoom: number }[];
      bindings: Record<string, { num: number }>;
      bindingSource: string;
    }
  | undefined;
function analysis(): void {
  if (!model) return;
  const documents: Record<string, { version: number; source: string }> = {};
  for (const key of props.snapshot.keys) {
    const doc = props.snapshot.read(key);
    if (key.startsWith("logic:") && typeof doc?.content === "string")
      documents[key] = { version: doc.version, source: doc.content };
  }
  documents[props.documentKey] = { version: model.getVersionId(), source: model.getValue() };
  const inputs = ["words", "inventory", "bindings"].map((key) => props.snapshot.read(key)?.content);
  if (
    contextCache?.profile !== props.profileId ||
    inputs.some((value, index) => !sameProjectContent(value, contextCache?.inputs[index]))
  ) {
    let items: { name: string; startingRoom: number }[] = [];
    let words: [string, number][] = [];
    let bindings: Record<string, { num: number }> = {};
    let bindingSource = "{}";
    try {
      const text = props.snapshot.read("words")?.content;
      if (typeof text === "string") words = JSON.parse(text) as [string, number][];
      else if (text) words = parseWordsTok(text).map(({ word, id }) => [word, id]);
      const inventory = props.snapshot.read("inventory")?.content;
      if (typeof inventory === "string")
        items = JSON.parse(inventory) as { name: string; startingRoom: number }[];
      else if (inventory instanceof Uint8Array)
        items = readInventoryObjects(inventory, PROFILES[props.profileId]);
      const objects = items.map((item) => item.name);
      const names = props.snapshot.read("bindings")?.content;
      if (typeof names === "string") {
        bindingSource = names;
        bindings = readBindingsDocument(names);
      }
      contextCache = {
        profile: props.profileId,
        inputs,
        words,
        objects,
        inventory: items,
        bindings,
        bindingSource,
      };
    } catch {
      contextCache = undefined;
      client.invalidateContext("Fix the WORDS or names document to restore code intelligence.");
      return;
    }
  }
  const { words, objects, inventory, bindings, bindingSource } = contextCache;
  client.setProject({
    revision: props.snapshot.revision,
    profileId: props.profileId,
    words,
    objects,
    inventory,
    resources: Object.fromEntries(
      props.snapshot.keys
        .filter((key) => /^(logic|picture|view|sound):/.test(key))
        .map((key) => [key, { uri: `agi-resource:///${key.replace(":", "/")}` }]),
    ),
    bindings,
    bindingDocument: {
      uri: "agi-project:///bindings.json",
      source: bindingSource,
    },
    documents,
  });
}
async function applyProjectEdit(edit: WorkspaceEdit, _label: string): Promise<void> {
  const revision = props.snapshot.revision;
  const expected = new Map(
    edit.documentChanges.map((change) => [
      change.textDocument.uri,
      client.documentSource(change.textDocument.uri),
    ]),
  );
  await workspace.flush.value?.();
  const session = engine.getProjectSession();
  const base = session?.workingSnapshot();
  if (!session || !base || base.revision !== revision)
    throw new Error("The project changed. Retry the edit.");
  const changes = edit.documentChanges.map((change) => {
    const key =
      change.textDocument.uri === "agi-project:///bindings.json"
        ? "bindings"
        : base.keys.find(
            (key) => key.startsWith("logic:") && client.uri(key) === change.textDocument.uri,
          );
    const source = key ? base.read(key)?.content : undefined;
    if (!key || typeof source !== "string") throw new Error("The source changed. Retry the edit.");
    if (source !== expected.get(change.textDocument.uri))
      throw new Error("The source changed. Retry the edit.");
    if (key === props.documentKey && source !== model?.getValue())
      throw new Error("The source changed. Retry the edit.");
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
  const outcome = await session.stage(changes);
  if (
    !["committed", "unchanged", "draft", "diagnostics", "restartRequired", "deferred"].includes(
      outcome.status,
    )
  )
    throw new Error("The project could not apply this edit. Retry at a safe game boundary.");
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
    onFormat: beginFormatting,
    debugState: pausedState,
    onDebugValue,
    onBinding,
    onResource: (key) => workspace.open(key),
  });
  editor = monaco.editor.create(root.value!, {
    readOnly: props.readOnly,
    domReadOnly: props.readOnly,
    model,
    theme: "vs-dark",
    // Suggestions and hovers draw above the tabs instead of being cut off at the editor's edge.
    fixedOverflowWidgets: true,
    "semanticHighlighting.enabled": true,
    automaticLayout: false,
    editContext: false,
    autoIndent: "full",
    insertSpaces: true,
    detectIndentation: false,
    minimap: { enabled: false },
    hover: { above: false },
    fontSize: 13,
    lineNumbers: "on",
    glyphMargin: true,
    scrollBeyondLastLine: false,
    wordWrap: "on",
    tabSize: 2,
    padding: { top: 16, bottom: 16 },
  });
  document.addEventListener("pointerdown", outsideValue, true);
  editor.onDidScrollChange(() => {
    valueEditor.value = undefined;
  });
  contextMenu = registerLogicContextMenu(editor, findReferences);
  decorations = editor.createDecorationsCollection();
  breakpointHint = editor.createDecorationsCollection();
  editor.onMouseMove((event) =>
    hintBreakpoint(
      event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
        ? event.target.position?.lineNumber
        : undefined,
    ),
  );
  editor.onMouseLeave(() => hintBreakpoint(undefined));
  markerSubscription = monaco.editor.onDidChangeMarkers((uris) => {
    if (!model || !uris.some((uri) => uri.toString() === model!.uri.toString())) return;
    emit(
      "problems",
      monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((entry) => entry.severity === monaco.MarkerSeverity.Error)
        .map((entry) => ({ message: entry.message, line: entry.startLineNumber })),
    );
  });
  editor.onMouseDown((event) => {
    if (
      event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
      event.target.position
    ) {
      hintBreakpoint(undefined);
      emit("breakpoint", event.target.position.lineNumber);
    }
  });
  editor.onDidChangeCursorSelection(({ selection }) => {
    const name = documentLabel(props.documentKey);
    emit(
      "selection",
      selection.isEmpty()
        ? {
            label: `${name} · line ${selection.startLineNumber}`,
            text: model!.getLineContent(selection.startLineNumber),
          }
        : {
            label: `${name} · lines ${selection.startLineNumber}–${selection.endLineNumber}`,
            text: model!.getValueInRange(selection),
          },
    );
  });
  model.onDidChangeContent(() => {
    if (!syncing && model) {
      emit("edit", model.getValue());
      if (formatting) {
        formatting = false;
        emit("typingEnd");
      }
      client.changeDocument(props.documentKey, model.getVersionId(), model.getValue());
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
    if (model) client.changeDocument(props.documentKey, model.getVersionId(), model.getValue());
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
  if (model) client.changeDocument(props.documentKey, model.getVersionId(), model.getValue());
  if (show && props.stoppedLine) navigate(props.stoppedLine);
  else if (editView) editor?.restoreViewState(editView);
});
watch(
  () => [props.breakpoints, props.stoppedLine, props.runningSource],
  () => {
    if (showRunning.value) {
      syncSource(props.runningSource ?? props.source);
      if (model) client.changeDocument(props.documentKey, model.getVersionId(), model.getValue());
    }
    decorate();
    language?.refreshDebug();
  },
);
watch(() => [props.snapshot, props.profileId], analysis);
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
    else {
      formatOnLeave();
      emit("typingEnd");
    }
  },
);
onBeforeUnmount(() => {
  formatOnLeave();
  emit("typingEnd");
  document.removeEventListener("pointerdown", outsideValue, true);
  cancelAnimationFrame(layoutFrame);
  observer?.disconnect();
  // Model-change listeners cancel their work before markers and providers retire.
  editor?.setModel(null);
  contextMenu?.dispose();
  editor?.dispose();
  markerSubscription?.dispose();
  language?.dispose();
  model?.dispose();
  client.dispose();
});
onBeforeUnmount(
  workspace.registerKeySheet(props.documentKey, () => ({
    name: "LOGIC",
    sections: logicKeySheet(),
    where: "Keys work while the code has focus.",
  })),
);
defineExpose({
  cursor: () => editor?.getSelection()?.getStartPosition() ?? editor?.getPosition(),
  displayedSource: () => model?.getValue(),
  focus: () => editor?.focus(),
  navigate,
});
</script>
<template>
  <div class="workspace-logic-surface">
    <form
      v-if="valueEditor"
      ref="valuePanel"
      class="logic-debug-value"
      :style="{ left: `${valueEditor.left}px`, top: `${valueEditor.top}px` }"
      @submit.prevent="setHoverValue"
      @keydown.esc.stop.prevent="closeValue"
    >
      <label :for="`debug-value-${documentKey}`">Variable {{ valueEditor.slot }}</label>
      <input
        ref="valueInput"
        :id="`debug-value-${documentKey}`"
        v-model.number="valueEditor.value"
        type="number"
        min="0"
        max="255"
        step="1"
        required
      />
      <button type="button" @click="closeValue">Cancel</button>
      <button type="submit" :disabled="debug?.state.busy">Set</button>
    </form>
    <div
      v-if="(differs && stoppedLine !== undefined) || showRunning"
      class="workspace-running-source"
    >
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
    <div
      ref="root"
      class="workspace-monaco"
      data-testid="workspace-logic-editor"
      @focusout.capture="leaveEditor"
    ></div>
  </div>
</template>
<style scoped>
.workspace-logic-surface {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.logic-debug-value {
  position: absolute;
  z-index: 60;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  width: 240px;
  padding: var(--space-3);
  background: var(--surface-1);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-dialog);
}
.logic-debug-value label {
  width: 100%;
}
.logic-debug-value input {
  width: 60px;
}
/* Shown only while paused here; it floats over the code so the editor never moves. */
.workspace-running-source {
  position: absolute;
  top: var(--space-2);
  right: var(--space-4);
  z-index: 5;
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
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
:deep(.workspace-breakpoint-hint) {
  background: var(--danger);
  border-radius: 50%;
  opacity: 0.45;
  transform: scale(0.55);
  cursor: pointer;
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
