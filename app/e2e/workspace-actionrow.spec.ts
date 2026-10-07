import { test, expect } from "./test.ts";
import { start, open } from "./pictureWorkspaceShared.ts";
import {
  focusWorkspaceLogic,
  findWorkspaceLogic,
  addWorkspaceAction,
  workspaceDocument,
} from "./workspaceShared.ts";

const helpers = ["Place hero", "Answer a sentence", "Door", "Sound when…"];
test.describe.configure({ mode: "parallel" });

for (const [width, height] of [
  [1063, 815],
  [1440, 900],
  [390, 844],
] as const) {
  test.describe(`Editor action row ${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: width === 390 });

    for (const kind of ["logic", "picture"] as const) {
      test(`${kind} groups room helpers in Add @webkit-desktop`, async ({ page }) => {
        await start(page);
        await open(page, kind === "logic" ? "part-room:1:logic" : "part-room:1:picture:1");
        await expect(
          kind === "logic"
            ? page.getByTestId("workspace-logic-editor").locator(".monaco-editor")
            : page.getByTestId("room-studio"),
        ).toBeVisible();
        const row = page.getByTestId("workspace-context");
        await expect(row).toBeVisible();
        await expect.soft(row.getByTestId("part-number")).toHaveCount(0);
        for (const name of helpers)
          await expect.soft(row.getByRole("button", { name, exact: true })).toHaveCount(0);
        const add = row.getByRole("button", { name: "Add", exact: true });
        await expect(add).toBeVisible();
        await expect(add.locator("svg")).toBeVisible();
        await add.focus();
        await add.press("ArrowDown");
        const menu = page.getByRole("menu", { name: "Add", exact: true });
        await expect(menu.getByRole("menuitem")).toHaveText(helpers);
        await expect(menu.getByRole("menuitem").first()).toBeFocused();
        await page.keyboard.press("End");
        await expect(menu.getByRole("menuitem").last()).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(menu).toBeHidden();
        await expect(add).toBeFocused();
        const more = row.getByRole("button", { name: "More actions", exact: true });
        await more.click();
        const overflow = page.getByTestId("context-more-actions-menu");
        await expect(
          overflow.getByRole("menuitem", { name: "Change number…", exact: true }),
        ).toBeVisible();
        for (const name of helpers)
          await expect(overflow.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
        if (kind === "logic")
          await expect(
            overflow.getByRole("menuitem", { name: "Format document", exact: true }),
          ).toBeVisible();
        await page.keyboard.press("Escape");
        if (kind === "picture") {
          // Editor tools use the priority overflow when the available row is narrow.
          for (const name of ["Trace an image", "Generate"]) {
            const tool = row.getByRole("button", { name, exact: true });
            if (width === 1440) await expect(tool).toBeVisible();
            else if (!(await tool.isVisible())) {
              await more.click();
              await expect(overflow.getByRole("menuitem", { name, exact: true })).toBeVisible();
              await page.keyboard.press("Escape");
            }
          }
        }
        const bounds = (await row.boundingBox())!;
        for (const button of await row.locator("button:visible").all()) {
          const box = (await button.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(bounds.x);
          expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        }
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${width}.png`),
          animations: "disabled",
        });
        await addWorkspaceAction(page, "Place hero", { VIEW: "0", X: "42", Y: "140" }, "logic:1");
        expect(await workspaceDocument(page, "logic:1")).toContain("position(o0, 42, 140)");
        await addWorkspaceAction(
          page,
          "Answer a sentence",
          {
            "When the player types…": "look at sun",
            "The game says…": "The sun shines.",
          },
          "logic:1",
        );
        expect(await workspaceDocument(page, "logic:1")).toContain('print("The sun shines.")');
        await addWorkspaceAction(
          page,
          "Door",
          { "Destination ROOM": "8", X: "10", Y: "140", Right: "30", Bottom: "160" },
          "logic:1",
        );
        expect(await workspaceDocument(page, "logic:1")).toContain("new.room(8)");
        await addWorkspaceAction(
          page,
          "Sound when…",
          { "When the player types…": "ring the bell", SOUND: "1" },
          "logic:1",
        );
        expect(await workspaceDocument(page, "logic:1")).toContain('said("ring", "bell")');
        // Pausing preserves the controls and location chip while Add remains reachable.
        if (width === 390) await page.getByRole("button", { name: "Edit", exact: true }).click();
        if (kind === "picture") await open(page, "part-room:1:logic");
        await findWorkspaceLogic(page, "accept.input();");
        await page.keyboard.press("F9");
        await expect(page.locator(".workspace-breakpoint")).toHaveCount(1);
        await page.keyboard.press("F5");
        await expect(row.getByTestId("debug-stop")).toBeVisible();
        if (kind === "picture") {
          await open(page, "part-room:1:picture:1");
          await expect(page.getByTestId("room-studio")).toBeVisible();
        }
        await expect(row.getByRole("group", { name: "Debug controls" })).toBeVisible();
        await expect(row.getByTestId("workspace-debug-status")).toContainText("Paused at");
        await expect(add).toBeVisible();
        await expect(more).toBeVisible();
        const pausedBounds = (await row.boundingBox())!;
        for (const button of await row.locator("button:visible").all()) {
          const box = (await button.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(pausedBounds.x);
          expect(box.x + box.width).toBeLessThanOrEqual(pausedBounds.x + pausedBounds.width);
        }
        await page.screenshot({
          path: test.info().outputPath(`${kind}-paused-${width}.png`),
          animations: "disabled",
        });
      });
    }

    test("overflowing tab names stay clear and reachable @webkit-desktop", async ({ page }) => {
      await start(page);
      for (const id of [
        "part-room:1:logic",
        "part-room:1:picture:1",
        "part-room:8:logic",
        "part-room:8:picture:8",
        "part-view:0",
        "part-view:8",
        "part-view:9",
        "part-picture:9",
        "part-logic:0",
        "part-notes",
        "part-messages",
        "part-inventory",
        "part-words",
      ])
        await open(page, id);
      const strip = page.getByTestId("project-studio-tabs");
      await expect.poll(() => strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await expect.soft(strip).toHaveCSS("scrollbar-width", "none");
      const first = strip.getByRole("tab").first();
      const last = strip.getByRole("tab").last();
      await last.focus();
      await last.press("Home");
      await expect(first).toBeFocused();
      await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBe(0);
      await first.press("End");
      await expect(last).toBeFocused();
      await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      const geometry = await last.locator(".project-tabs__text").evaluate((el) => {
        const strip = el.closest<HTMLElement>(".project-tabs")!;
        const name = el.getBoundingClientRect();
        const bounds = strip.getBoundingClientRect();
        return {
          top: name.top,
          bottom: name.bottom,
          left: name.left,
          right: name.right,
          stripTop: bounds.top + strip.clientTop,
          stripBottom: bounds.top + strip.clientTop + strip.clientHeight,
          stripLeft: bounds.left,
          stripRight: bounds.right,
        };
      });
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.stripTop);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.stripBottom);
      expect(geometry.left).toBeGreaterThanOrEqual(geometry.stripLeft);
      expect(geometry.right).toBeLessThanOrEqual(geometry.stripRight);
      if (width === 390) await last.tap();
      else await last.press("Enter");
      await expect(last).toHaveAttribute("aria-selected", "true");
      await page.screenshot({
        path: test.info().outputPath(`tabs-${width}.png`),
        animations: "disabled",
      });
    });

    test("More actions formats LOGIC in one Undo @webkit-desktop", async ({ page }) => {
      await start(page);
      await open(page, "part-room:1:logic");
      const messy = "if(f1){v2=3;}else{return;}";
      await expect(
        page.getByTestId("workspace-logic-editor").locator(".monaco-editor"),
      ).toBeVisible();
      await page.evaluate(async (text) => {
        const { monaco } = await import("/src/studio/logic/monacoLanguage.ts");
        const editor = monaco.editor
          .getEditors()
          .find((editor) => editor.getDomNode()?.offsetParent)!;
        editor.getModel()!.setValue(text);
        editor.focus();
      }, messy);
      await page.getByTestId("context-more-actions").click();
      const format = page.getByRole("menuitem", { name: "Format document", exact: true });
      await expect(format).toBeVisible();
      await format.click();
      await expect
        .poll(() => workspaceDocument(page, "logic:1"))
        .toBe("if (f1) {\n  v2 = 3;\n} else {\n  return;\n}\n");
      await focusWorkspaceLogic(page);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => workspaceDocument(page, "logic:1")).toBe(messy);
    });
  });
}
