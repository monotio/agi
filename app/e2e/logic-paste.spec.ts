import type { Page } from "@playwright/test";
import type { ProjectSession } from "../src/project/projectSession.ts";
import { test, expect } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";

const BLOCK = 'if (isset(f20)) {\n  print("a");\n  print("b");\n}\n';

async function setSource(page: Page, text: string, lineNumber?: number, column?: number) {
  await page.evaluate(
    async ({ text, lineNumber, column }) => {
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      const editor = monaco.editor
        .getEditors()
        .find((editor) => editor.getDomNode()?.offsetParent)!;
      const model = editor.getModel()!;
      model.setValue(text);
      editor.setPosition({
        lineNumber: lineNumber ?? model.getLineCount(),
        column: column ?? model.getLineMaxColumn(model.getLineCount()),
      });
      editor.focus();
    },
    { text, lineNumber, column },
  );
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(text);
}

test.beforeEach(async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
});

for (const path of ["clipboard", "Monaco"] as const) {
  test(`${path} paste preserves block indentation at the room end and inside a block @webkit-desktop`, async ({
    page,
  }) => {
    const room = await workspaceDocument(page, "logic:1");
    for (const nested of [false, true]) {
      const prefix = `${room.trimEnd()}\n${nested ? "if (isset(f21)) {\n  " : ""}`;
      const suffix = nested ? "\n}\n" : "";
      await setSource(page, prefix + suffix, prefix.split("\n").length, nested ? 3 : 1);
      await page.evaluate(
        async ({ path, text }) => {
          const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
          const editor = monaco.editor.getEditors().find((editor) => editor.hasTextFocus())!;
          if (path === "Monaco") editor.trigger("spec", "paste", { text });
          else {
            const clipboardData = new DataTransfer();
            clipboardData.setData("text/plain", text);
            editor
              .getDomNode()!
              .querySelector("textarea.inputarea")!
              .dispatchEvent(
                new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
              );
          }
        },
        { path, text: BLOCK },
      );
      const rebased = BLOCK.split("\n")
        .map((line, index) => (index > 0 && line ? `  ${line}` : line))
        .join("\n");
      await expect
        .poll(async () => {
          const draft = await workspaceDocument(page, "logic:1");
          return (
            nested
              ? [prefix + BLOCK + suffix, prefix + rebased + suffix]
              : [prefix + BLOCK + suffix]
          ).includes(draft);
        })
        .toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath(`logic-${path}-paste.png`) });
  });
}

test("programmatic replacements preserve supplied indentation and Undo @webkit-desktop", async ({
  page,
}) => {
  // Deliberately irregular spacing makes any automatic reindent observable.
  const supplied = 'if (isset(f20)) {\n      print("a");\n print("b");\n   }\n';
  await setSource(page, supplied);
  const replacement = supplied.replace('"b"', '"replacement"');
  await page.evaluate(async (text) => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.hasTextFocus())!;
    editor.pushUndoStop();
    editor.executeEdits("spec", [{ range: editor.getModel()!.getFullModelRange(), text }]);
    editor.pushUndoStop();
  }, replacement);
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(replacement);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    monaco.editor
      .getEditors()
      .find((editor) => editor.hasTextFocus())!
      .trigger("spec", "undo", {});
  });
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(supplied);
  await page.evaluate(async (content) => {
    const probe = window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } };
    const outcome = await probe.__AGI_PROJECT__.getSession().stage([{ key: "logic:1", content }]);
    if (!["draft", "committed", "unchanged"].includes(outcome.status))
      throw new Error(`Replacement refused: ${outcome.status}`);
  }, replacement);
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(replacement);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getEditors()
          .find((editor) => editor.getDomNode()?.offsetParent)!
          .getValue();
      }),
    )
    .toBe(replacement);
});

test("agent admission and project Undo preserve replacement indentation @webkit-desktop", async ({
  page,
}) => {
  const original = await workspaceDocument(page, "logic:1");
  const replacement = `${original.trimEnd()}\n${BLOCK.replace('  print("b")', '      print("b")')}`;
  await page.evaluate(async (content) => {
    const probe = window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } };
    const session = probe.__AGI_PROJECT__.getSession();
    const result = await session.submit({
      proposal: session.model.propose(session.model.capture(), "Replace LOGIC", [
        { key: "logic:1", content },
      ]),
      label: "Replace LOGIC",
      origin: "agent",
      author: "agent",
    });
    if (result.status !== "committed") throw new Error(`Agent edit refused: ${result.status}`);
  }, replacement);
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(replacement);
  await page.getByTestId("workspace-undo").click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(original);
  await page.getByTestId("workspace-redo").click();
  await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(replacement);
  // A subsequent user edit reads from the synchronized Monaco model.
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.setPosition({ lineNumber: editor.getModel()!.getLineCount(), column: 1 });
    editor.focus();
    editor.trigger("spec", "paste", { text: "// after agent edit\n" });
  });
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toBe(`${replacement}// after agent edit\n`);
});

test("a source quick fix preserves surrounding indentation @webkit-desktop", async ({ page }) => {
  const supplied = 'if (isset(f20)) {\n      sound(255, scary_sound_off);\n print("b");\n   }\n';
  await setSource(page, supplied, 2, 20);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        return monaco.editor
          .getModelMarkers({})
          .some((marker) => marker.message.includes("scary_sound_off"));
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    monaco.editor
      .getEditors()
      .find((editor) => editor.hasTextFocus())!
      .trigger("spec", "editor.action.quickFix", {});
  });
  await page.getByText("Define as a constant in this file…", { exact: true }).click();
  await expect
    .poll(() => workspaceDocument(page, "logic:1"))
    .toBe(`#define scary_sound_off 17\n${supplied}`);
});
