<script setup lang="ts">
import { onMounted, onBeforeUnmount, useTemplateRef, watch } from "vue";
import { monaco } from "./monacoLanguage.ts";
const props = defineProps<{ before: string; after: string }>();
const host = useTemplateRef("host");
let editor: monaco.editor.IStandaloneDiffEditor | undefined;
let original: monaco.editor.ITextModel | undefined;
let modified: monaco.editor.ITextModel | undefined;
onMounted(() => {
  original = monaco.editor.createModel(props.before, "plaintext");
  modified = monaco.editor.createModel(props.after, "plaintext");
  editor = monaco.editor.createDiffEditor(host.value!, {
    theme: "vs-dark",
    readOnly: true,
    renderSideBySide: false,
    automaticLayout: true,
    editContext: false,
    minimap: { enabled: false },
    fontSize: 12,
    scrollBeyondLastLine: false,
    wordWrap: "on",
    renderOverviewRuler: false,
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: 1,
      minimumLineCount: 2,
      revealLineCount: 5,
    },
    lineNumbers: "off",
  });
  editor.setModel({ original, modified });
  editor.onDidUpdateDiff(() => {
    const first = editor?.getLineChanges()?.[0];
    if (first)
      editor?.getModifiedEditor().revealLineInCenter(Math.max(1, first.modifiedStartLineNumber));
  });
});
watch(
  () => props.before,
  (value) => original?.setValue(value),
);
watch(
  () => props.after,
  (value) => modified?.setValue(value),
);
onBeforeUnmount(() => {
  editor?.dispose();
  original?.dispose();
  modified?.dispose();
});
</script>
<template>
  <div
    ref="host"
    class="agent-code-diff"
    data-testid="agent-code-diff"
    aria-label="Source changes"
  ></div>
</template>
<style scoped>
.agent-code-diff {
  height: 112px;
  min-width: 0;
  border: 1px solid var(--hairline);
}
</style>
