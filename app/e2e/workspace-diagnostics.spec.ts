import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, waitForRoom } from "./engineProbe.ts";
import { openWorkspaceLogic, focusWorkspaceLogic } from "./workspaceShared.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

test("project errors mark operands and both error links select their exact range @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  const surface = await openWorkspaceLogic(page);
  await focusWorkspaceLogic(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("// missing sound\nsound(s5, f180);\nreturn;");
  await page.keyboard.press("Escape");
  await expect(surface.locator(".squiggly-error")).toBeVisible();
  await surface.locator(".view-lines span").filter({ hasText: /^s5$/ }).hover();
  await expect(surface.locator(".monaco-hover").filter({ visible: true })).toContainText(
    "SOUND 5 is absent.",
  );
  await reviewShot(page, "workspace-sound-diagnostic");
  await page.getByTestId("workspace-update").click();
  await expect(page.locator(".workspace-build-error")).toContainText("LOGIC 1 has errors.");
  await page.getByRole("button", { name: "Go to error", exact: true }).click();
  const selection = async () =>
    page.evaluate(async () => {
      const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
      const editor = monaco.editor.getEditors().find((entry) => entry.hasTextFocus());
      const selected = editor?.getSelection();
      return selected ? editor?.getModel()?.getValueInRange(selected) : null;
    });
  await expect.poll(selection).toBe("s5");
  await page.getByTestId("workspace-status-problems").click();
  const problems = page.getByTestId("workspace-problems");
  await expect(problems).toContainText("SOUND 5 is absent.");
  await reviewShot(page, "workspace-source-problems");
  await problems.getByRole("button", { name: /SOUND 5 is absent\./ }).click();
  await expect.poll(selection).toBe("s5");
});

test("a refused Launch opens its inventory row @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await openWorkspaceLogic(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const world = JSON.parse(String(session.workingSnapshot().read("world")!.content));
    world.launches = {
      "1": {
        selected: "bad",
        entries: [
          { id: "good", name: "Good" },
          { id: "bad", name: "Bad", items: { "253": 1 } },
        ],
      },
    };
    await session.stage([{ key: "world", content: JSON.stringify(world) }]);
  });
  await expect(page.getByTestId("workspace-status-problems")).toBeVisible();
  await page.getByTestId("workspace-update").click();
  await page.getByRole("button", { name: "Go to error", exact: true }).click();
  const launch = page.getByTestId("launch-editor");
  await expect(launch.getByRole("tab", { name: "Bad" })).toHaveAttribute("aria-selected", "true");
  await expect(launch.getByTestId("launch-item-select")).toBeFocused();
});

test("Problems opens a refused inventory entry @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await openWorkspaceLogic(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    session.drafts().stage([
      {
        key: "inventory",
        content: '[{"name":"lamp","startingRoom":1},{"name":"coin","startingRoom":999}]',
      },
    ]);
    await session.drafts().flush();
  });
  await page.getByTestId("workspace-status-problems").click();
  await page
    .getByTestId("workspace-problems")
    .getByRole("button", { name: /startingRoom must be/ })
    .click();
  await expect(
    page
      .getByTestId("workspace-table-editor")
      .locator("tbody tr")
      .nth(1)
      .locator('input[type="number"]'),
  ).toBeFocused();
});

test("Problems selects a missing resource binding in Game state @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await waitForRoom(page, 1);
  await openWorkspaceLogic(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
    ).__AGI_PROJECT__.getSession();
    const bindings = JSON.parse(String(session.workingSnapshot().read("bindings")!.content));
    bindings.missing_sound = { kind: "sound", num: 253 };
    session.drafts().stage([{ key: "bindings", content: JSON.stringify(bindings, null, 2) }]);
    await session.drafts().flush();
  });
  await page.getByTestId("workspace-status-problems").click();
  await page
    .getByTestId("workspace-problems")
    .getByRole("button", { name: /SOUND 253 is absent/ })
    .click();
  const field = page.getByRole("textbox", { name: "Game state", exact: true });
  await expect(field).toBeFocused();
  await expect
    .poll(() =>
      field.evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        return input.value.slice(input.selectionStart, input.selectionEnd);
      }),
    )
    .toBe("253");
  await reviewShot(page, "workspace-binding-problem");
});

for (const [key, label, content] of [
  ["words", "Words", '[["look",1],null]'],
  ["inventory", "Objects", '[{"name":"lamp","startingRoom":1},null]'],
] as const) {
  test(`Problems opens malformed ${key} rows for repair @webkit-desktop`, async ({ page }) => {
    await isolateStorage(page);
    await page.goto("/#create-adventure");
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await waitForRoom(page, 1);
    await openWorkspaceLogic(page);
    await page.evaluate(
      async ({ key, content }) => {
        const session = (
          window as unknown as { __AGI_PROJECT__: { getSession(): ProjectSession } }
        ).__AGI_PROJECT__.getSession();
        session.drafts().stage([{ key, content }]);
        await session.drafts().flush();
      },
      { key, content },
    );
    await page.getByTestId("workspace-status-problems").click();
    await page
      .getByTestId("workspace-problems")
      .getByRole("button", { name: new RegExp(`^${label}:`) })
      .click();
    const field = page.getByRole("textbox", { name: label, exact: true });
    await expect(field).toBeFocused();
    await expect
      .poll(() =>
        field.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return input.value.slice(input.selectionStart, input.selectionEnd);
        }),
      )
      .toBe("null");
  });
}
