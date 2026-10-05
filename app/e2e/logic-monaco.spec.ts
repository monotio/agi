import type { Page } from "@playwright/test";
import { expect, reviewShot, test } from "./test.ts";
import type { editor as monacoEditor } from "monaco-editor/editor/editor.api";
import type { LogicAnalysisClient } from "../src/studio/logic/analysisClient.ts";
import type * as monacoLanguage from "../src/studio/logic/monacoLanguage.ts";

/**
 * Temporary editor host for the Logic Studio Monaco adapter: a real editor and
 * model against the real analysis worker, mounted inside the running app in
 * test mode. The production host (Studio workspace) is wired separately; the
 * adapter itself owns no DOM outside this fixture.
 */
interface MonacoHost {
  mod: typeof monacoLanguage;
  monaco: typeof monacoLanguage.monaco;
  editor: monacoEditor.IStandaloneCodeEditor;
  client: LogicAnalysisClient;
  client2?: LogicAnalysisClient;
  model: monacoEditor.ITextModel;
  model2?: monacoEditor.ITextModel;
  foreign?: monacoEditor.ITextModel;
  handle: ReturnType<typeof monacoLanguage.registerLogicModel>;
  handle2?: ReturnType<typeof monacoLanguage.registerLogicModel>;
  dom: HTMLElement;
}

const ARRIVAL =
  '// arrival hall\nif (said("look", "room")) {\n  print("A low gate.");\n}\nset(door);\ngoto done;\ndone:\nreturn;\n';

async function mountEditor(page: Page): Promise<void> {
  await page.evaluate(async (arrival: string) => {
    const mod = await import("/src/studio/logic/monacoLanguage.ts");
    const { LogicAnalysisClient } = await import("/src/studio/logic/analysisClient.ts");
    const monaco = mod.monaco;
    const dom = document.createElement("div");
    dom.style.cssText =
      "position:fixed;left:0;top:0;width:960px;height:640px;z-index:2147483000;background:#0d1417";
    document.body.append(dom);
    const editor = monaco.editor.create(dom, {
      automaticLayout: true,
      "semanticHighlighting.enabled": true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      // Isolate provider results: the adapter is the only suggestion source.
      wordBasedSuggestions: "off",
    });
    const client = new LogicAnalysisClient();
    const source = `${arrival}if (said("o`;
    const model = monaco.editor.createModel(
      source,
      mod.LOGIC_LANGUAGE_ID,
      monaco.Uri.parse("inmemory://workspace-a/logic/1"),
    );
    editor.setModel(model);
    client.setProject({
      revision: 1,
      profileId: "2.936",
      words: [
        ["look", 100],
        ["room", 101],
        ["open", 102],
      ],
      bindings: { door: { num: 50 } },
      documents: { "logic:1": { version: 1, source } },
    });
    const handle = mod.registerLogicModel(model, { client, documentKey: "logic:1" });
    const state: MonacoHost = { mod, monaco, editor, client, model, handle, dom };
    (window as unknown as { __monacoHost: MonacoHost }).__monacoHost = state;
  }, ARRIVAL);
}

async function unmountEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.handle.dispose();
    h.handle2?.dispose();
    h.client.dispose();
    h.client2?.dispose();
    h.editor.dispose();
    for (const model of h.monaco.editor.getModels()) model.dispose();
    h.dom.remove();
    delete (window as unknown as { __monacoHost?: MonacoHost }).__monacoHost;
  });
}

async function replaceSource(page: Page, revision: number, source: string): Promise<void> {
  await page.evaluate(
    ({ revision, source }: { revision: number; source: string }) => {
      const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
      h.model.setValue(source);
      h.client.setProject(
        // Host contract: a fresh complete snapshot after every text change.
        {
          revision,
          profileId: "2.936",
          words: [["look", 100]],
          bindings: { door: { num: 50 } },
          documents: { "logic:1": { version: revision, source } },
        },
      );
    },
    { revision, source },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "Your games" }).waitFor();
});

test("logic Monaco adapter serves shared-worker completion, signature, hover, definition and markers", async ({
  page,
}) => {
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.reload();
  await page.getByRole("heading", { name: "Your games" }).waitFor();
  expect(requests.some((url) => url.includes("monaco-editor"))).toBe(false);

  await mountEditor(page);
  expect(requests.some((url) => url.includes("monaco-editor"))).toBe(true);

  // Completion inside said("… comes from the project dictionary.
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setPosition(h.model.getPositionAt(h.model.getValueLength()));
    h.editor.focus();
    h.editor.trigger("spec", "editor.action.triggerSuggest", {});
  });
  await expect(page.locator(".suggest-widget.visible")).toBeVisible();
  await expect(page.locator(".suggest-widget.visible")).toContainText("open");
  await reviewShot(page, "logic-monaco-completion");

  // Signature help reports the shared command label at the typed argument.
  await replaceSource(page, 2, `${ARRIVAL}if (said("look", `);
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setPosition(h.model.getPositionAt(h.model.getValueLength()));
    h.editor.trigger("spec", "editor.action.triggerParameterHints", {});
  });
  await expect(page.locator(".parameter-hints-widget.visible")).toBeVisible();
  await expect(page.locator(".parameter-hints-widget.visible")).toContainText("said(word, ...)");
  await reviewShot(page, "logic-monaco-signature");

  // Hover over a project binding name explains its generated definition.
  await replaceSource(page, 3, "set(door); return;");
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setPosition(h.model.getPositionAt(5));
    h.editor.trigger("spec", "editor.action.showHover", {});
  });
  await expect(page.locator(".monaco-hover")).toBeVisible();
  await expect(page.locator(".monaco-hover")).toContainText("#define door 50");

  // A project declaration opens in a source preview while the main caret stays put.
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setPosition(h.model.getPositionAt(5));
    h.editor.trigger("spec", "editor.action.revealDefinition", {});
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
        return h.monaco.editor.getModels().some((model) => model.uri.scheme === "agi-preview");
      }),
    )
    .toBe(true);
  const bindingCaret = await page.evaluate(
    () =>
      (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.editor.getPosition()
        ?.lineNumber ?? -1,
  );
  expect(bindingCaret).toBe(1);

  // Same-document definition: `goto done` lands on the label line.
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    const source = "goto done;\nreturn;\ndone:\nreturn;\n";
    h.model.setValue(source);
    h.client.setProject({
      revision: 4,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { version: 4, source } },
    });
    h.editor.setPosition(h.model.getPositionAt(6));
    h.editor.trigger("spec", "editor.action.revealDefinition", {});
  });
  await page.waitForFunction(
    () =>
      (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.editor.getPosition()
        ?.lineNumber === 3,
  );

  // Same-document references drive occurrence highlighting: with the caret
  // resting on the label name, both the declaration and its use light up.
  await page.waitForFunction(
    () => document.querySelectorAll('[class*="wordHighlight"]').length >= 2,
  );

  // The References command needs Monaco's standalone controller as well as
  // the language provider; occurrence coloring alone does not prove navigation.
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.trigger("spec", "editor.action.referenceSearch.trigger", {});
  });
  await expect(page.locator(".reference-zone-widget")).toBeVisible();
  await expect(page.locator(".reference-zone-widget")).toContainText("done");
  await reviewShot(page, "logic-monaco-references");
  await page.keyboard.press("Escape");

  // Diagnostics become markers at authored ranges only.
  const markers = await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    const source = "return;\nif (said(\n";
    h.model.setValue(source);
    h.client.setProject({
      revision: 5,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { version: 5, source } },
    });
    await h.handle.refreshDiagnostics();
    return h.monaco.editor.getModelMarkers({ resource: h.model.uri });
  });
  expect(markers.length).toBeGreaterThan(0);
  expect(markers[0]?.severity).toBe(8);
  expect(markers[0]?.startLineNumber).toBe(3);
  expect(requests.some((url) => url.includes("analysis.worker"))).toBe(true);
  expect(pageErrors).toEqual([]);

  await unmountEditor(page);
});

test("logic Monaco adapter multiplexes workspaces, ignores foreign models and drops stale replies", async ({
  page,
}) => {
  await page.clock.install();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await mountEditor(page);

  // Second workspace: its own client, document key and dictionary.
  await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    const { LogicAnalysisClient } = await import("/src/studio/logic/analysisClient.ts");
    const client2 = new LogicAnalysisClient();
    const source2 = 'if (said("j';
    const model2 = h.monaco.editor.createModel(
      source2,
      h.mod.LOGIC_LANGUAGE_ID,
      h.monaco.Uri.parse("inmemory://workspace-b/logic/2"),
    );
    client2.setProject({
      revision: 1,
      profileId: "2.936",
      words: [["jump", 200]],
      bindings: { lever: { num: 9 } },
      documents: { "logic:2": { version: 1, source: source2 } },
    });
    h.client2 = client2;
    h.model2 = model2;
    h.handle2 = h.mod.registerLogicModel(model2, {
      client: client2,
      documentKey: "logic:2",
    });
  });

  const suggestRows = async (word: string): Promise<string> => {
    const rows = page.locator(".suggest-widget.visible .monaco-list-rows");
    await expect(rows).toBeVisible();
    await expect(rows).toContainText(word);
    return rows.textContent().then((text) => text ?? "");
  };

  // Each workspace's suggestions come from its own project.
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setModel(h.model2!);
    h.editor.setPosition(h.model2!.getPositionAt(h.model2!.getValueLength()));
    h.editor.focus();
    h.editor.trigger("spec", "editor.action.triggerSuggest", {});
  });
  const secondSuggestions = await suggestRows("jump");
  expect(secondSuggestions).toContain("jump");
  expect(secondSuggestions).not.toContain("open");

  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setModel(h.model);
    h.editor.setPosition(h.model.getPositionAt(h.model.getValueLength()));
    h.editor.trigger("spec", "editor.action.triggerSuggest", {});
  });
  const firstSuggestions = await suggestRows("open");
  expect(firstSuggestions).toContain("open");
  expect(firstSuggestions).not.toContain("jump");

  // A same-language model nobody registered gets no project data.
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    const foreign = h.monaco.editor.createModel(
      'if (said("o',
      h.mod.LOGIC_LANGUAGE_ID,
      h.monaco.Uri.parse("inmemory://workspace-a/logic/foreign"),
    );
    h.foreign = foreign;
    h.editor.setModel(foreign);
    h.editor.setPosition(foreign.getPositionAt(foreign.getValueLength()));
    h.editor.trigger("spec", "editor.action.triggerSuggest", {});
  });
  await page.clock.runFor(400);
  // No project data may surface for an unregistered model: either the widget
  // stays closed or it shows only its empty state.
  await expect(page.locator(".suggest-widget.visible .monaco-list-row:visible")).toHaveCount(0);

  // Stale replies never mark newer text: a refresh computing diagnostics for
  // the broken revision resolves after the model has already moved on, so its
  // markers must be dropped rather than written against shifted text.
  const stale = await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setModel(h.model);
    const broken = "return;\nif (said(\n";
    const markers = () => h.monaco.editor.getModelMarkers({ resource: h.model.uri }).length;
    h.model.setValue(broken);
    h.client.setProject({
      revision: 6,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { version: 6, source: broken } },
    });
    const pending = h.handle.refreshDiagnostics();
    // Type ahead before the worker answers; the snapshot reply below is now
    // stale relative to the live model version.
    h.model.setValue("return;");
    await pending;
    const staleMarkers = markers();
    h.client.setProject({
      revision: 7,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { version: 7, source: "return;" } },
    });
    await h.handle.refreshDiagnostics();
    const settledMarkers = markers();
    // Same source and snapshot in step again: markers resume normally.
    h.model.setValue(broken);
    h.client.setProject({
      revision: 8,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { version: 8, source: broken } },
    });
    await h.handle.refreshDiagnostics();
    return { staleMarkers, settledMarkers, reappliedMarkers: markers() };
  });
  expect(stale.staleMarkers).toBe(0);
  expect(stale.settledMarkers).toBe(0);
  expect(stale.reappliedMarkers).toBeGreaterThan(0);

  // Dispose clears only this registration's markers; the second workspace
  // keeps answering.
  const afterDispose = await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setModel(h.model);
    h.handle.dispose();
    const cleared = h.monaco.editor.getModelMarkers({ resource: h.model.uri }).length;
    h.editor.setModel(h.model2!);
    h.editor.setPosition(h.model2!.getPositionAt(h.model2!.getValueLength()));
    h.editor.trigger("spec", "editor.action.triggerSuggest", {});
    return { cleared };
  });
  expect(afterDispose.cleared).toBe(0);
  expect(await suggestRows("jump")).toContain("jump");

  // Reopen registers a fresh handle on a fresh model for the same document.
  const reopened = await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.model.dispose();
    const source = "set(door); return;";
    const model = h.monaco.editor.createModel(
      source,
      h.mod.LOGIC_LANGUAGE_ID,
      h.monaco.Uri.parse("inmemory://workspace-a/logic/1"),
    );
    h.model = model;
    h.editor.setModel(model);
    h.client.setProject({
      revision: 8,
      profileId: "2.936",
      words: [],
      bindings: { door: { num: 50 } },
      documents: { "logic:1": { version: 8, source } },
    });
    h.handle = h.mod.registerLogicModel(model, { client: h.client, documentKey: "logic:1" });
    await h.handle.refreshDiagnostics();
    h.editor.setPosition(model.getPositionAt(5));
    h.editor.trigger("spec", "editor.action.showHover", {});
    return { markers: h.monaco.editor.getModelMarkers({ resource: model.uri }).length };
  });
  expect(reopened.markers).toBe(0);
  await expect(page.locator(".monaco-hover")).toBeVisible();
  await expect(page.locator(".monaco-hover")).toContainText("#define door 50");
  expect(pageErrors).toEqual([]);

  await unmountEditor(page);
});

test("logic Monaco adapter keeps a full 256-document project off live editor models", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await mountEditor(page);
  const result = await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    const documents: Record<string, { version: number; source: string }> = {};
    for (let i = 0; i <= 255; i++) documents[`logic:${i}`] = { version: 1, source: "return;" };
    const source = "set(door); return;";
    documents["logic:1"] = { version: 9, source };
    h.client.setProject({
      revision: 9,
      profileId: "2.936",
      words: [],
      bindings: { door: { num: 50 } },
      documents,
    });
    h.model.setValue(source);
    await h.handle.refreshDiagnostics();
    const markers = h.monaco.editor.getModelMarkers({ resource: h.model.uri }).length;
    h.editor.setPosition(h.model.getPositionAt(5));
    h.editor.trigger("spec", "editor.action.showHover", {});
    return { markers, models: h.monaco.editor.getModels().length };
  });
  expect(result.models).toBe(1);
  expect(result.markers).toBe(0);
  await expect(page.locator(".monaco-hover")).toBeVisible();
  await expect(page.locator(".monaco-hover")).toContainText("#define door 50");
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((text) => text.includes("LEAK"))).toEqual([]);

  await unmountEditor(page);
});

test("logic Monaco registration replacement retires listeners and markers without touching its successor", async ({
  page,
}) => {
  await mountEditor(page);
  const result = await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.handle.dispose();
    // Measure registration listeners on a model detached from editor contributions.
    h.editor.setModel(null);
    const subscribe = h.model.onWillDispose;
    let listeners = 0;
    let maximum = 0;
    Object.defineProperty(h.model, "onWillDispose", {
      value: (...args: Parameters<typeof subscribe>) => {
        const original = subscribe(...args);
        listeners++;
        maximum = Math.max(maximum, listeners);
        let disposed = false;
        return {
          dispose() {
            if (!disposed) {
              disposed = true;
              listeners--;
              original.dispose();
            }
          },
        };
      },
    });
    h.handle = h.mod.registerLogicModel(h.model, { client: h.client, documentKey: "logic:1" });
    await h.handle.refreshDiagnostics();
    const hadMarkers = h.monaco.editor.getModelMarkers({ resource: h.model.uri }).length > 0;
    const old = h.handle;
    h.handle = h.mod.registerLogicModel(h.model, { client: h.client, documentKey: "logic:1" });
    const cleared = h.monaco.editor.getModelMarkers({ resource: h.model.uri }).length;
    await h.handle.refreshDiagnostics();
    old.dispose();
    const successorMarkers = h.monaco.editor.getModelMarkers({ resource: h.model.uri }).length;
    for (let index = 0; index < 20; index++) {
      const previous = h.handle;
      h.handle = h.mod.registerLogicModel(h.model, { client: h.client, documentKey: "logic:1" });
      previous.dispose();
    }
    h.handle.dispose();
    return { hadMarkers, cleared, successorMarkers, listeners, maximum };
  });
  expect(result.hadMarkers).toBe(true);
  expect(result.cleared).toBe(0);
  expect(result.successorMarkers).toBeGreaterThan(0);
  expect(result.maximum).toBe(1);
  expect(result.listeners).toBe(0);
  await unmountEditor(page);
});

for (const [marked, suggestion, expected] of [
  ["load.v|();", "load.view", "load.view();"],
  ["if (said(|)) { return; }", "look", 'if (said("look")) { return; }'],
  [
    "#define object_id 1\nset.view(object_i|, 2);",
    "object_id",
    "#define object_id 1\nset.view(object_id, 2);",
  ],
] as const) {
  test(`logic Monaco accepts a completion at an existing delimiter: ${suggestion}`, async ({
    page,
  }) => {
    await mountEditor(page);
    const source = marked.replace("|", "");
    await replaceSource(page, 20, source);
    await page.evaluate((offset) => {
      const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
      h.editor.setPosition(h.model.getPositionAt(offset));
      h.editor.focus();
      h.editor.trigger("spec", "editor.action.triggerSuggest", {});
    }, marked.indexOf("|"));
    const widget = page.locator(".suggest-widget.visible");
    await expect(widget).toBeVisible();
    const label = widget
      .locator(".label-name")
      .filter({ hasText: new RegExp(`^${suggestion.replaceAll(".", "\\.")}$`) });
    await expect(label).toHaveCount(1);
    await label.dblclick();
    const text = () =>
      page.evaluate(() =>
        (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.model.getValue(),
      );
    await expect.poll(text).toBe(expected);
    await reviewShot(page, `logic-completion-${suggestion.replaceAll(".", "-")}`);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(text).toBe(source);
    await unmountEditor(page);
  });
}

test("LOGIC uses LSP rename, outline, folding and quick fixes", async ({ page }) => {
  await mountEditor(page);
  await replaceSource(
    page,
    2,
    '#define door 41\nif (isset(door)) {\n  set(door);\n  print("Hello");\n}\nreturn;',
  );
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setPosition({ lineNumber: 3, column: 8 });
    h.editor.trigger("spec", "editor.action.rename", {});
  });
  const rename = page.locator(".rename-box input");
  await expect(rename).toBeVisible();
  await rename.fill("gate");
  await rename.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.model.getValue(),
      ),
    )
    .toContain("set(gate)");
  const renamed = await page.evaluate(() =>
    (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.model.getValue(),
  );
  expect(renamed).toContain("#define gate 41");
  await replaceSource(page, 3, renamed);
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.trigger("spec", "editor.action.quickOutline", {});
  });
  await expect(page.locator(".quick-input-widget")).toBeVisible();
  await expect(page.locator(".quick-input-widget")).toContainText("gate");
  await page.keyboard.press("Escape");
  const before = await page.evaluate(() =>
    (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.editor.getTopForLineNumber(6),
  );
  await page.evaluate(() =>
    (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.editor.trigger(
      "spec",
      "editor.foldAll",
      {},
    ),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.editor.getTopForLineNumber(
          6,
        ),
      ),
    )
    .toBeLessThan(before);
  await replaceSource(page, 4, "set(lamp); return;");
  await page.evaluate(async () => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    await h.handle.refreshDiagnostics();
    h.editor.setPosition({ lineNumber: 1, column: 6 });
    h.editor.trigger("spec", "editor.action.quickFix", {});
  });
  await expect(page.getByText("Define lamp as 0", { exact: true })).toBeVisible();
  await reviewShot(page, "logic-quick-fix");
  await page.getByText("Define lamp as 0", { exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __monacoHost: MonacoHost }).__monacoHost.model.getValue(),
      ),
    )
    .toContain("#define lamp 0");
  await unmountEditor(page);
});

test("LOGIC colouring comes from worker semantic tokens", async ({ page }) => {
  await mountEditor(page);
  await replaceSource(page, 2, 'print("Hello");\nreturn;');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const spans = [...document.querySelectorAll(".view-line span")];
        const string = spans.find((span) => span.textContent === '"Hello"');
        const keyword = spans.find((span) => span.textContent === "return");
        return (
          !!string &&
          !!keyword &&
          getComputedStyle(string).color !== getComputedStyle(keyword).color
        );
      }),
    )
    .toBe(true);
  await reviewShot(page, "logic-semantic-colouring");
  await unmountEditor(page);
});

test("LOGIC Shift+F12 lists numbered variable uses in two logics", async ({ page }) => {
  await mountEditor(page);
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.model.setValue("draw.pic(v0); return;");
    h.client.setProject({
      revision: 2,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: {
        "logic:1": { version: 2, source: h.model.getValue() },
        "logic:2": { version: 1, source: "load.pic(v0); return;" },
      },
    });
    h.editor.setPosition({ lineNumber: 1, column: 11 });
    h.editor.focus();
  });
  await page.keyboard.press("Shift+F12");
  const peek = page.locator(".reference-zone-widget");
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("draw.pic");
  const closed = peek.getByRole("treeitem").filter({ hasText: "logic.2.lgc" }).first();
  await expect(closed).toBeVisible();
  await closed.click();
  await expect(peek).toContainText("load.pic");
  await reviewShot(page, "logic-numbered-references");
  await unmountEditor(page);
});

test("LOGIC peeks project declarations and closed-file references", async ({ page }) => {
  await mountEditor(page);
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.model.setValue("set(door); return;");
    h.client.setProject({
      revision: 2,
      profileId: "2.936",
      words: [],
      bindings: { door: { num: 50 } },
      documents: {
        "logic:1": { version: 2, source: h.model.getValue() },
        "logic:2": { version: 1, source: "reset(door); return;" },
      },
    });
    h.editor.setPosition({ lineNumber: 1, column: 6 });
    h.editor.trigger("spec", "editor.action.revealDefinition", {});
  });
  const peek = page.locator(".peekview-widget");
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("bindings.json");
  await expect(peek.locator(".view-lines")).toContainText('"door"');
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
    h.editor.setPosition({ lineNumber: 1, column: 6 });
    h.editor.trigger("spec", "editor.action.referenceSearch.trigger", {});
  });
  await expect(peek).toBeVisible();
  const closed = peek.getByRole("treeitem").filter({ hasText: "logic.2.lgc" }).first();
  await expect(closed).toBeVisible();
  await closed.click();
  await peek.getByRole("treeitem").filter({ hasText: "reset(door)" }).click();
  await expect(peek.locator(".view-lines")).toContainText("reset");
  expect(
    await page.evaluate(() => {
      const h = (window as unknown as { __monacoHost: MonacoHost }).__monacoHost;
      const previews = h.monaco.editor
        .getEditors()
        .filter((editor) => editor.getModel()?.uri.scheme === "agi-preview");
      return (
        previews.length > 0 && previews.every((editor) => editor.getRawOptions().readOnly === true)
      );
    }),
  ).toBe(true);
  await reviewShot(page, "logic-project-references");
  await unmountEditor(page);
});
