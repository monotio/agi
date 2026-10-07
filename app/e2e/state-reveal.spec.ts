import { devices, type Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { configureAi, isolateStorage, waitForRoom, workspaceUpdated } from "./engineProbe.ts";
import { replaceWorkspaceDocument } from "./workspaceShared.ts";

async function showParts(page: Page, width: number): Promise<void> {
  if (width === 390 && !(await page.getByTestId("parts-list").isVisible()))
    await page.getByTestId("workspace-parts").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
}

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test(`Parts reveals Game state and its LOGIC uses at ${width} @webkit-desktop`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await isolateStorage(page);
    await page.goto("/");
    await configureAi(page, { provider: "stub" });
    await page.getByTestId("create-adventure-toggle").click();
    await page.getByTestId("local-create-kind-starter").click();
    await page.getByTestId("local-create-submit").click();
    await waitForRoom(page, 1);
    await workspaceUpdated(page);
    const source = `${"// Source line\n".repeat(40)}set(chime_done);\nif (isset(chime_done)) { reset(chime_done); }\nassignn(current_room, 1);\nreturn;`;
    await showParts(page, width);
    await replaceWorkspaceDocument(page, "logic:1", source);
    await showParts(page, width);
    const parts = page.getByTestId("parts-list");
    await parts.getByRole("button", { name: "chime_done Flag 204", exact: true }).click();
    const state = page.getByTestId("workspace-state");
    await expect(page.getByTestId("project-tab-state")).toHaveAttribute("aria-selected", "true");
    await expect(state).toBeVisible();
    const entry = state.getByTestId("state-flag-204");
    await expect(entry).toHaveAttribute("aria-current", "true");
    await expect(entry).toBeFocused();
    await expect(entry).toBeInViewport();
    await expect(entry.locator(".workspace-state__value")).toHaveText(/[01]/);
    await expect(state.getByRole("status")).toContainText("chime_done");
    const uses = state.getByTestId("state-uses-flag-204");
    await expect(uses).toContainText("Changed");
    await expect(uses).toContainText("Read");
    await expect(
      uses.getByRole("button", { name: /Changed · first_room · LOGIC 1 · line 41/ }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`state-reveal-${width}.png`),
      animations: "disabled",
      scale: "css",
    });
    await uses.getByRole("button", { name: /Read · first_room · LOGIC 1 · line 42/ }).click();
    await expect(page.getByTestId("project-tab-logic:1")).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
          return monaco.editor
            .getEditors()
            .find((editor) =>
              editor.getDomNode()?.closest('[data-testid="workspace-logic-editor"]'),
            )
            ?.getPosition()?.lineNumber;
        }),
      )
      .toBe(42);
    await expect(page.getByTestId("workspace-logic-editor").locator(".view-lines")).toContainText(
      "isset(chime_done)",
    );

    await showParts(page, width);
    const builtin = parts.getByTestId("game-state-builtin");
    await builtin.locator("summary").click();
    const clock = builtin.getByRole("button", { name: "clock_days Variable 14", exact: true });
    await clock.focus();
    await clock.press("Enter");
    const clockEntry = state.getByTestId("state-variable-14");
    await expect(clockEntry).toBeFocused();
    await expect(clockEntry).toHaveAttribute("aria-current", "true");
    await expect(clockEntry).toBeInViewport();
    await expect(state.getByTestId("state-builtin")).toHaveAttribute("open", "");
    await expect.poll(() => state.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({
      path: test.info().outputPath(`state-builtin-${width}.png`),
      animations: "disabled",
      scale: "css",
    });

    // Revealing again focuses the existing tab; Find references uses the same entry.
    await showParts(page, width);
    await parts.getByLabel("Actions for chime_done", { exact: true }).click();
    await page.getByRole("menuitem", { name: "Find references", exact: true }).click();
    await expect(entry).toBeFocused();
    await expect(page.getByTestId("project-tab-state")).toHaveCount(1);
  });
}

async function start(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  await waitForRoom(page, 1);
  await workspaceUpdated(page);
}

test("Built-in keyboard reveal opens its uses and empty result @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1063, height: 815 });
  await start(page);
  const builtin = page.getByTestId("game-state-builtin");
  await builtin.locator("summary").click();
  const days = builtin.getByRole("button", { name: "clock_days Variable 14", exact: true });
  await days.focus();
  await days.press("Enter");
  await expect(page.getByTestId("state-variable-14")).toBeFocused();
  await expect(page.getByTestId("state-uses-variable-14")).toContainText("Not used yet.");
  const parts = page.getByTestId("parts-list");
  await parts.getByLabel("Actions for new_room", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Find references", exact: true }).click();
  const uses = page.getByTestId("state-uses-flag-5");
  await expect(uses.getByRole("button", { name: /Read · first_room · LOGIC 1/ })).toBeVisible();
  await uses.getByRole("button", { name: /Read · first_room · LOGIC 1/ }).click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
});

test("Parts resource and room references share the editor list @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await replaceWorkspaceDocument(
    page,
    "logic:1",
    "load.sound(chime_sound);\nload.sound(1);\nif (isset(f80)) { new.room(1); }\nreturn;",
  );
  const parts = page.getByTestId("parts-list");
  const sound = parts.getByTestId("part-sound:1").locator("..");
  await sound.getByLabel("Actions for chime_sound", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Find references", exact: true }).click();
  const references = page.getByTestId("workspace-references");
  await expect(references).toBeVisible();
  await expect(references).toBeFocused();
  await expect(references.getByRole("button")).toHaveCount(2);
  await expect(
    references.getByRole("button", { name: /Used · first_room · LOGIC 1 · line 2/ }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("resource-references-1440.png"),
    animations: "disabled",
    scale: "css",
  });
  await references.getByRole("button", { name: /line 2/ }).click();
  await expect(page.getByTestId("project-tab-logic:1")).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        const editor = monaco.editor
          .getEditors()
          .find((editor) => editor.getDomNode()?.offsetParent)!;
        return editor.getPosition()?.lineNumber;
      }),
    )
    .toBe(2);
  // The same resource from the editor includes literal uses, too.
  await page.evaluate(async () => {
    const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
    const editor = monaco.editor.getEditors().find((editor) => editor.getDomNode()?.offsetParent)!;
    editor.setPosition({ lineNumber: 1, column: 13 });
    editor.focus();
  });
  await page.keyboard.press("Shift+F12");
  await expect(references).toBeFocused();
  await expect(references.getByRole("button")).toHaveCount(2);
  const room = parts.getByTestId("part-room:1").locator("..");
  await room.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Find references", exact: true }).click();
  await expect(
    references.getByRole("button", { name: /Used · first_room · LOGIC 1 · line 3/ }),
  ).toBeVisible();
  // Empty results occupy the same tab rather than silently doing nothing.
  const unused = parts.getByTestId("part-picture:1").locator("..");
  await unused.getByRole("button", { name: /^Actions for / }).click();
  await page.getByRole("menuitem", { name: "Find references", exact: true }).click();
  await expect(references).toContainText("Not used yet.");
  await expect(page.getByTestId("project-tab-uses")).toHaveCount(1);
});

test.describe("touch phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: devices["iPhone 13"].userAgent,
  });
  test("state rows reveal and their uses open LOGIC @webkit-desktop", async ({ page }) => {
    await start(page);
    await showParts(page, 390);
    const parts = page.getByTestId("parts-list");
    await parts.getByRole("button", { name: "chime_done Flag 204", exact: true }).tap();
    const entry = page.getByTestId("state-flag-204");
    await expect(page.getByTestId("project-tab-state")).toHaveAttribute("aria-selected", "true");
    await expect(entry).toHaveAttribute("aria-current", "true");
    await expect(entry).toBeFocused();
    await expect(entry).toBeInViewport();
    const uses = page.getByTestId("state-uses-flag-204");
    await expect(
      uses.getByRole("button", { name: /Changed · first_room · LOGIC 1/ }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("state-reveal-iphone.png"),
      animations: "disabled",
      scale: "css",
    });
    await uses.getByRole("button", { name: /Changed · first_room · LOGIC 1/ }).tap();
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    await showParts(page, 390);
    const builtin = parts.getByTestId("game-state-builtin");
    await builtin.locator("summary").tap();
    await builtin.getByRole("button", { name: "clock_days Variable 14", exact: true }).tap();
    await expect(page.getByTestId("state-variable-14")).toBeFocused();
    await expect(page.getByTestId("state-uses-variable-14")).toContainText("Not used yet.");
  });
});

test("Game state refreshes a value while its tab stays open @webkit-desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const builtin = page.getByTestId("game-state-builtin");
  await builtin.locator("summary").click();
  await builtin.getByRole("button", { name: "clock_seconds Variable 11", exact: true }).click();
  const entry = page.getByTestId("state-variable-11");
  await expect(entry).toBeFocused();
  const value = entry.locator(".workspace-state__value");
  await expect(value).toHaveText(/^\d+$/);
  const initial = Number(await value.textContent());
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const probe = window as unknown as {
          __AGI_PROJECT__: { query(method: string): Promise<{ vars: number[] }> };
        };
        return (await probe.__AGI_PROJECT__.query("state")).vars[11];
      }),
    )
    .not.toBe(initial);
  await expect.poll(() => value.textContent()).not.toBe(String(initial));
  await expect(page.getByTestId("project-tab-state")).toHaveAttribute("aria-selected", "true");
});
