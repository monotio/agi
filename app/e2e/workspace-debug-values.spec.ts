import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook, waitForRoom } from "./engineProbe.ts";
import {
  findWorkspaceLogic,
  replaceWorkspaceDocument,
  workspaceDocument,
} from "./workspaceShared.ts";

for (const size of [
  { width: 1440, height: 900 },
  { width: 1063, height: 815 },
]) {
  test(`paused hover edits and inline values at ${size.width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await waitForRoom(page, 1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !!(
              window as unknown as { __AGI_PROJECT__: { getSession(): unknown } }
            ).__AGI_PROJECT__.getSession(),
        ),
      )
      .toBe(true);
    const original = await workspaceDocument(page, "logic:1");
    expect(original).toContain("if (isset(new_room)) {");
    await page.evaluate(async () => {
      const host = window as unknown as {
        __AGI_PROJECT__: {
          getSession(): {
            model: { capture(): { read(key: string): { content: string } } };
            stage(changes: { key: string; content: string }[]): Promise<unknown>;
          };
        };
      };
      const session = host.__AGI_PROJECT__.getSession();
      const bindings = JSON.parse(session.model.capture().read("bindings").content);
      bindings.scary_sound_off = { kind: "flag", num: 50 };
      await session.stage([{ key: "bindings", content: JSON.stringify(bindings) }]);
    });
    const source = original
      .replace(
        "if (isset(new_room)) {",
        "if (isset(new_room)) {\n  assignn(v41, 0);\n  assignn(v40, 3);\n  if (!isset(scary_sound_off)) { assignv(v41, v40); }",
      )
      .replace("player.control();", "assignn(v49, 0);\n  player.control();");
    await replaceWorkspaceDocument(page, "logic:1", source);
    await findWorkspaceLogic(page, "if (!isset(scary_sound_off))");
    await page.keyboard.press("F9");
    const editor = page.getByTestId("workspace-logic-editor");
    await expect(editor.locator(".workspace-breakpoint")).toHaveCount(1);
    await page.getByTestId("workspace-update").click();
    await expect(page.getByTestId("workspace-debug-status")).toContainText("Paused");
    await expect(editor.locator(".workspace-stopped-line").first()).toBeVisible();
    const flagLine = editor.locator(".view-line").filter({ hasText: "if (!isset(scary_sound_off" });
    await flagLine.getByText("scary_sound_off", { exact: true }).hover();
    const hover = editor.locator(".monaco-hover").filter({ visible: true });
    await expect(hover).toContainText("= off");
    await expect(hover.getByRole("link", { name: "Rename…", exact: true })).toHaveCount(1);
    await expect(hover.getByRole("link", { name: "Rename", exact: true })).toHaveCount(0);
    await expect(hover.getByRole("link", { name: "Open", exact: true })).toBeVisible();
    await expect(flagLine.getByText("off", { exact: true })).toBeVisible();
    const previousLine = editor.locator(".view-line").filter({ hasText: "assignn(v40" });
    await expect(
      previousLine.locator('[class*="dyn-rule-"]').filter({ hasText: /^\s*\d+\s*$/ }),
    ).toHaveText("3");
    const authoringState = () =>
      page.evaluate(() => {
        const host = window as unknown as {
          __AGI_PROJECT__: {
            getSession(): {
              model: { capture(): { documentId: string } };
              history: { capture(): unknown };
            };
          };
        };
        const session = host.__AGI_PROJECT__.getSession();
        return {
          documentId: session.model.capture().documentId,
          history: JSON.stringify(session.history.capture()),
        };
      });
    const beforeAuthoring = await authoringState();
    await reviewShot(page, `debug-values-${size.width}-off`);
    await hover.getByRole("link", { name: "= off", exact: true }).click();
    await expect(hover.getByRole("link", { name: "= on", exact: true })).toBeVisible();
    await expect(flagLine.getByText("on", { exact: true })).toBeVisible();
    await reviewShot(page, `debug-values-${size.width}-on`);
    await page.keyboard.press("Escape");
    await previousLine.getByText("v40", { exact: true }).hover();
    await expect(hover.getByRole("link", { name: "= 3", exact: true })).toBeVisible();
    await hover.getByRole("link", { name: "= 3", exact: true }).focus();
    await page.keyboard.press("Enter");
    const field = page.getByRole("spinbutton", { name: "Variable 40", exact: true });
    await expect(field).toBeFocused();
    await reviewShot(page, `debug-values-${size.width}-field`);
    await field.fill("256");
    await field.press("Enter");
    await expect(field).toBeVisible();
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow)).toBe(
      true,
    );
    await field.press("Escape");
    await expect(field).toBeHidden();
    await previousLine.getByText("v40", { exact: true }).hover();
    await hover.getByRole("link", { name: "= 3", exact: true }).click();
    await expect(field).toBeFocused();
    await field.fill("9");
    await field.press("Enter");
    await expect(field).toBeHidden();
    await expect(
      previousLine.locator('[class*="dyn-rule-"]').filter({ hasText: /^\s*\d+\s*$/ }),
    ).toHaveText("9");
    await expect(hover.getByRole("link", { name: "= 9", exact: true })).toBeVisible();
    await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(source);
    expect(await authoringState()).toEqual(beforeAuthoring);
    await reviewShot(page, `debug-values-${size.width}-variable`);
    await page.keyboard.press("Escape");
    await editor.locator(".view-lines").getByText("v49", { exact: true }).hover();
    await expect(hover.getByRole("link", { name: "= 0", exact: true })).toBeVisible();
    await hover.getByRole("link", { name: "= 0", exact: true }).click();
    const bottomField = page.getByRole("spinbutton", { name: "Variable 49", exact: true });
    await expect(bottomField).toBeFocused();
    const panelBox = (await bottomField.locator("..").boundingBox())!;
    const editorBox = (await editor.boundingBox())!;
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(editorBox.y + editorBox.height);
    await reviewShot(page, `debug-values-${size.width}-bottom-field`);
    await bottomField.press("Escape");
    await expect(bottomField).toBeHidden();
    await page
      .locator(".workspace-context")
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(page.getByTestId("workspace-debug-status")).toHaveCount(0);
    await expect(editor.locator('[class*="dyn-rule-"]')).toHaveCount(0);
    await expect(hover).toHaveCount(0);
    await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(0);
    const values = await page.evaluate(async () => {
      const host = window as unknown as {
        __AGI_PROJECT__: { query(type: string): Promise<{ vars: number[]; flags: number[] }> };
      };
      return host.__AGI_PROJECT__.query("state");
    });
    expect(values.flags[50]).toBe(1);
    expect(values.vars[40]).toBe(9);
    expect(values.vars[41]).toBe(0);
    await flagLine.getByText("scary_sound_off", { exact: true }).hover();
    await expect(hover).toBeVisible();
    await expect(hover).not.toContainText("= on");
    await page.keyboard.press("Escape");
    await page.getByTestId("workspace-update").click();
    await expect(page.getByTestId("workspace-debug-status")).toContainText("Paused");
    await expect(
      editor
        .locator('[class*="dyn-rule-"]')
        .filter({ hasText: /^\s*3\s*$/ })
        .first(),
    ).toBeVisible();
    await page.locator(".workspace-context").getByTestId("debug-stop").click();
    await expect(page.getByTestId("workspace-debug-status")).toHaveCount(0);
    await expect(editor.locator('[class*="dyn-rule-"]')).toHaveCount(0);
  });
}

test("paused hints refresh an in-flight running answer @webkit-desktop", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const { monaco, LOGIC_LANGUAGE_ID, registerLogicModel } =
      await import("/src/studio/logic/monacoLanguage.ts");
    const { LogicAnalysisClient } = await import("/src/studio/logic/analysisClient.ts");
    const dom = document.createElement("div");
    dom.style.cssText = "position:fixed;inset:0;z-index:10000";
    document.body.append(dom);
    const source = "if (isset(f50)) { return; }";
    const model = monaco.editor.createModel(
      source,
      LOGIC_LANGUAGE_ID,
      monaco.Uri.parse("inmemory://debug-inlay/1"),
    );
    const client = new LogicAnalysisClient();
    client.setProject({
      revision: 1,
      profileId: "2.936",
      words: [],
      bindings: {},
      documents: { "logic:1": { source, version: 1 } },
    });
    const state = { waiting: false, paused: false, release: () => {} };
    const request = client.request.bind(client);
    let first = true;
    client.request = async (...args) => {
      const result = await request(...args);
      if (args[1] === "textDocument/inlayHint" && first) {
        first = false;
        state.waiting = true;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      return result;
    };
    const vars = Array<number>(256).fill(0);
    const flags = Array<number>(256).fill(0);
    const handle = registerLogicModel(model, {
      client,
      documentKey: "logic:1",
      debugState: () =>
        state.paused ? { vars, flags, lines: [0], epoch: 1, stopId: 1 } : undefined,
    });
    const editor = monaco.editor.create(dom, { model, minimap: { enabled: false } });
    (window as unknown as { debugInlayRace: unknown }).debugInlayRace = {
      state,
      handle,
      editor,
      client,
      model,
      dom,
    };
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { debugInlayRace: { state: { waiting: boolean } } }).debugInlayRace
            .state.waiting,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const h = (
      window as unknown as {
        debugInlayRace: {
          state: { paused: boolean; release(): void };
          handle: { refreshDebug(): void };
        };
      }
    ).debugInlayRace;
    h.state.paused = true;
    h.handle.refreshDebug();
    h.state.release();
  });
  await expect(page.locator(".view-line").getByText("off", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const h = (
      window as unknown as {
        debugInlayRace: {
          handle: { dispose(): void };
          editor: { dispose(): void };
          client: { dispose(): void };
          model: { dispose(): void };
          dom: HTMLElement;
        };
      }
    ).debugInlayRace;
    h.handle.dispose();
    h.editor.dispose();
    h.client.dispose();
    h.model.dispose();
    h.dom.remove();
  });
});
