import { createApp, h, nextTick, shallowRef } from "vue";
import * as monaco from "monaco-editor/editor/editor.api";
import { provideEngine, type EngineApi } from "../../src/engine/engineContext.ts";
import { createWorkspaceEditor, provideWorkspaceEditor } from "../../src/shell/workspaceEditor.ts";
import type { ProjectSnapshot } from "../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

export async function mount(input: {
  documents: Record<string, string>;
  key: string;
  profileId: ProfileId;
}) {
  let provider: monaco.languages.DocumentSemanticTokensProvider | undefined;
  const register = monaco.languages.registerDocumentSemanticTokensProvider;
  monaco.languages.registerDocumentSemanticTokensProvider = (language, value) => {
    provider = value;
    return register(language, value);
  };
  const { default: LogicEditor } = await import("../../src/studio/workspace/LogicEditor.vue");
  monaco.languages.registerDocumentSemanticTokensProvider = register;
  let semanticChanges = 0;
  const semanticSubscription = provider?.onDidChange?.(() => {
    semanticChanges++;
  });
  let revision = 1;
  const documents = { ...input.documents };
  function capture(): ProjectSnapshot {
    const copy = { ...documents };
    return {
      revision,
      documentId: String(revision),
      keys: Object.keys(copy),
      lastAdmissibleBuild: undefined,
      read: (key) =>
        copy[key] === undefined ? undefined : { key, version: revision, content: copy[key] },
      version: () => revision,
      documents: () => copy,
    };
  }
  const snapshot = shallowRef(capture());
  const source = shallowRef(documents[input.key]!);
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;inset:20px;z-index:999;background:var(--surface-0)";
  document.body.append(container);
  const app = createApp({
    setup() {
      const engine = {} as EngineApi;
      provideEngine(engine);
      provideWorkspaceEditor(createWorkspaceEditor(engine));
      return () =>
        h(LogicEditor, {
          documentKey: input.key,
          source: source.value,
          snapshot: snapshot.value,
          profileId: input.profileId,
          active: true,
          onEdit: (text: string) => {
            source.value = text;
          },
        });
    },
  });
  app.mount(container);
  await nextTick();
  const model = monaco.editor.getModels().find((entry) => entry.uri.scheme === "agi-workspace")!;
  const editor = monaco.editor.getEditors().find((entry) => entry.getModel() === model)!;
  const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
  return {
    tick: nextTick,
    model,
    editor,
    monaco,
    semanticChanges: () => semanticChanges,
    tokens: () => provider!.provideDocumentSemanticTokens(model, null, cancellation),
    async save() {
      documents[input.key] = model.getValue();
      revision++;
      snapshot.value = capture();
      await nextTick();
    },
    dispose() {
      semanticSubscription?.dispose();
      app.unmount();
      container.remove();
    },
  };
}
