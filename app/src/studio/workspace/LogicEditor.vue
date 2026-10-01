<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch } from "vue";
import type { ProfileId } from "../../../../src/runtime/profile.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import type { ProjectSnapshot } from "../../../../src/authoring/projectModel.ts";
import { LogicAnalysisClient } from "../logic/analysisClient.ts";
import { monaco, LOGIC_LANGUAGE_ID, registerLogicModel } from "../logic/monacoLanguage.ts";
const props = defineProps<{
  documentKey: string;
  source: string;
  snapshot: ProjectSnapshot;
  profileId: ProfileId;
  active: boolean;
}>();
const emit = defineEmits<{ edit: [source: string] }>();
const root = useTemplateRef("root");
const client = new LogicAnalysisClient();
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let language: ReturnType<typeof registerLogicModel> | undefined;
let observer: ResizeObserver | undefined;
let syncing = false;
let layoutFrame = 0;
function layout(): void {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => editor?.layout());
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
  let words: [string, number][] = [];
  let bindings: Record<string, { num: number }> = {};
  try {
    const text = props.snapshot.read("words")?.content;
    if (typeof text === "string") words = JSON.parse(text) as [string, number][];
    const names = props.snapshot.read("bindings")?.content;
    if (typeof names === "string") bindings = readBindingsDocument(names);
  } catch {
    client.invalidateContext("Fix the WORDS or names document to restore code intelligence.");
    return;
  }
  client.setProject({
    revision: props.snapshot.revision,
    profileId: props.profileId,
    words,
    bindings,
    documents,
  });
  void language?.refreshDiagnostics();
}
onMounted(() => {
  model = monaco.editor.createModel(
    props.source,
    LOGIC_LANGUAGE_ID,
    monaco.Uri.parse(`agi-workspace://${crypto.randomUUID()}/${props.documentKey}`),
  );
  language = registerLogicModel(model, { client, documentKey: props.documentKey });
  editor = monaco.editor.create(root.value!, {
    model,
    theme: "vs-dark",
    automaticLayout: false,
    editContext: false,
    autoIndent: "none",
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    tabSize: 2,
    padding: { top: 16, bottom: 16 },
  });
  model.onDidChangeContent(() => {
    if (!syncing && model) {
      emit("edit", model.getValue());
      analysis();
    }
  });
  observer = new ResizeObserver(layout);
  observer.observe(root.value!);
  analysis();
});
watch(
  () => props.source,
  (source) => {
    if (!model || model.getValue() === source) return;
    const state = editor?.saveViewState();
    syncing = true;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: source }], () => null);
    syncing = false;
    if (state) editor?.restoreViewState(state);
    analysis();
  },
);
watch(() => props.snapshot, analysis);
watch(
  () => props.active,
  (active) => {
    if (active) layout();
  },
);
onBeforeUnmount(() => {
  cancelAnimationFrame(layoutFrame);
  observer?.disconnect();
  language?.dispose();
  editor?.dispose();
  model?.dispose();
  client.dispose();
});
defineExpose({ cursor: () => editor?.getPosition(), focus: () => editor?.focus() });
</script>
<template>
  <div ref="root" class="workspace-monaco" data-testid="workspace-logic-editor"></div>
</template>
<style scoped>
.workspace-monaco {
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--surface-0);
}
</style>
