import type { ProjectSession } from "../src/project/projectSession.ts";
import { fileURLToPath } from "node:url";
import { prepareIsolatedPage } from "./logicDebugShared.ts";
import {
  openStoredWorkspace,
  openWorkspaceLogic,
  replaceWorkspaceDocument,
} from "./workspaceShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("Logic Studio analysis loads on demand and resolves source through a real worker", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await page.getByRole("heading", { name: "Your games" }).waitFor();
  expect(requests.some((url) => url.includes("/studio/logic/"))).toBe(false);
  const result = await page.evaluate(async () => {
    const { LogicAnalysisClient } = await import("/src/studio/logic/analysisClient.ts");
    const client = new LogicAnalysisClient();
    try {
      const source = '// 🎮\nif (said("op';
      const context = {
        revision: 1,
        profileId: "2.936" as const,
        words: [["open", 100] as const],
        bindings: { door: { num: 50 } },
      };
      client.setProject({ ...context, documents: { "logic:1": { version: 1, source } } });
      const completions = await client.request("logic:1", "textDocument/completion", {
        position: { line: 1, character: 12 },
      });
      const signature = await client.request("logic:1", "textDocument/signatureHelp", {
        position: { line: 1, character: 12 },
      });
      const incomplete = await client.request("logic:1", "textDocument/diagnostic");
      const repaired = "set(door); return;";
      client.setProject({
        ...context,
        revision: 2,
        documents: { "logic:1": { version: 2, source: repaired } },
      });
      const definition = await client.request("logic:1", "textDocument/definition", {
        position: { line: 0, character: 4 },
      });
      const valid = await client.request("logic:1", "textDocument/diagnostic");
      return { completions, signature, incomplete, definition, valid };
    } finally {
      client.dispose();
    }
  });
  expect(requests.some((url) => url.includes("analysis.worker.ts"))).toBe(true);
  expect(result.completions).toContainEqual({
    label: "open",
    detail: "Word group 100",
    textEdit: {
      range: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } },
      newText: '"open"',
    },
  });
  expect(result.signature?.signatures[0]?.label).toBe("said(word, ...)");
  expect(result.incomplete.items[0]?.range.start.line).toBe(1);
  expect((Array.isArray(result.definition) ? result.definition[0] : result.definition)?.uri).toBe(
    "agi-project:///bindings.json",
  );
  expect(result.valid.items).toEqual([]);
});

test("saved native WORDS.TOK supplies LOGIC diagnostics", async ({ page }) => {
  await prepareIsolatedPage(page);
  await page.goto("/");
  await page.evaluate(
    async (workspaceModule) => {
      const { prepareLocalProject } = await import("/src/project/localProject.ts");
      const { saveAuthoredGame } = await import("/src/project/gameStorage.ts");
      const { readProjectWorkspace, writeProjectWorkspace } = await import(workspaceModule);
      const prepared = prepareLocalProject({ title: "Native vocabulary", kind: "starter" });
      const data = prepared.data();
      const documents = { ...readProjectWorkspace(data.workspace!) };
      documents["words"] = data.files["WORDS.TOK"]!;
      data.workspace = writeProjectWorkspace(documents);
      await saveAuthoredGame(prepared.projectId, data);
    },
    "/@fs" + fileURLToPath(new URL("../../src/authoring/projectWorkspace.ts", import.meta.url)),
  );
  await page.reload();
  await openStoredWorkspace(page, "Native vocabulary");
  await openWorkspaceLogic(page);
  const result = await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const model = monaco.editor.getModels().find((model) => model.uri.scheme === "agi-workspace")!;
    const { __AGI_PROJECT__ } = window as unknown as {
      __AGI_PROJECT__: { getSession(): ProjectSession };
    };
    const words = __AGI_PROJECT__.getSession().model.capture().read("words")!.content;
    return { native: words instanceof Uint8Array, source: model.getValue() };
  });
  expect(result.native).toBe(true);
  expect(result.source).toContain('said("look")');
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    result.source + '\nif (said("notintok")) { print("Test"); }\n',
    false,
  );
  const markers = () =>
    page.evaluate(async () => {
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      return monaco.editor
        .getModelMarkers({})
        .map((marker) => marker.message)
        .join("\n");
    });
  await expect.poll(markers).toContain("notintok");
  expect(await markers()).not.toContain("look");
  await reviewShot(page, "native-words-logic");
});
