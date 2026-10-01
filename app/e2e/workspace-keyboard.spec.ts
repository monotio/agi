import type { Page } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { testProjectId } from "../test/identity.ts";
import { cacheGame, enterCreateMode, textHook, waitForRoom } from "./engineProbe.ts";
import { expect, reviewShot, test } from "./test.ts";

test.use({ viewport: { width: 1440, height: 900 } });
async function boot(page: Page): Promise<void> {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource(
    "logic",
    0,
    logic("if(!isset(f200)){set(f200);accept.input();new.room(1);}call.v(v0);return;"),
  );
  game.putResource(
    "logic",
    1,
    logic(
      "if(isset(f5)){assignn(v30,5);load.pic(v30);draw.pic(v30);discard.pic(v30);show.pic();}return;",
    ),
  );
  game.putResource("picture", 5, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
  game.putResource(
    "logic",
    2,
    logic("if(isset(f5)){assignn(v30,6);load.pic(v30);draw.pic(v30);show.pic();}return;"),
  );
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("workspace-keyboard"),
    title: "Keyboard fixture",
    provider: "stub",
    model: "stub",
    imported: false,
    roomGeneration: true,
    authoringState: {
      authoring: {
        version: 1,
        bindings: {},
        world: {
          rooms: {
            "1": { title: "Meadow", description: "A green meadow.", exits: {} },
            "2": { title: "Missing art", description: "A room awaiting its picture.", exits: {} },
          },
          facts: {},
          quests: {},
        },
        sources: { logics: [[0, "return;"]] },
      },
    },
    files: Object.fromEntries(game.files),
    words: [],
  });
  await page.reload();
  await page.getByTestId("btn-resume-cached").click();
  await waitForRoom(page, 1);
  await enterCreateMode(page);
  await expect(page.getByTestId("parts-list")).toBeVisible();
}
async function mod(page: Page): Promise<string> {
  return (await page.evaluate(() => /mac|iphone|ipad|ios/i.test(navigator.platform)))
    ? "Meta"
    : "Control";
}

test("palette and quick open work from the keyboard @webkit-desktop", async ({ page }, info) => {
  await boot(page);
  const modifier = await mod(page);
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.press(`${modifier}+Shift+P`);
  const palette = page.getByRole("combobox", { name: "Command palette" });
  await expect(palette).toBeFocused();
  await expect(palette).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("option", { name: /Step over/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("End");
  const lastId = await palette.getAttribute("aria-activedescendant");
  await expect(page.locator(`[id="${lastId}"]`)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await reviewShot(page, `${info.project.name || "chromium"}-palette`);
  await page.keyboard.type("toggle parts");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("parts-list")).toBeHidden();
  await expect(input).toBeFocused();
  await page.keyboard.press(`${modifier}+B`);
  await expect(page.getByTestId("parts-list")).toBeVisible();

  await page.keyboard.press(`${modifier}+P`);
  const quick = page.getByRole("combobox", { name: "Quick open" });
  await expect(quick).toBeFocused();
  await expect(page.getByRole("option", { name: /Meadow.*ROOM 1.*LOGIC 1/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Missing art.*ROOM 2/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await reviewShot(page, `${info.project.name || "chromium"}-quick-open`);
  await page.keyboard.type(">toggle parts");
  await expect(page.getByRole("combobox", { name: "Command palette" })).toBeFocused();
  await expect(page.getByRole("option", { name: /Toggle parts list/ })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await page.keyboard.press(`${modifier}+P`);
  await expect(quick).toBeFocused();
  await page.keyboard.type("meadow");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  const studio = page.getByTestId("workspace-logic-editor").filter({ visible: true });
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("project-tab-logic:1")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(`${modifier}+Shift+P`);
  await expect(palette).toBeFocused();
  await page.keyboard.type("step over");
  await page.keyboard.press("Enter");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(studio).toBeVisible();
  await expect(input).toHaveValue("");
});

test("focus zones isolate game input and Help lists registered shortcuts @webkit-desktop", async ({
  page,
}) => {
  await boot(page);
  await page.getByTestId("part-room:1:logic").click();
  const modifier = await mod(page);
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.press("Shift+F6");
  await expect(page.getByTestId("workspace-editor")).toBeFocused();
  await page.keyboard.press("Shift+F6");
  const parts = page.getByTestId("parts-list");
  await expect(parts).toBeFocused();
  await expect(parts).toHaveAttribute("data-focus-zone-active", "");
  await expect(page.locator(".focus-zone-announcement")).toHaveText("Parts focused");
  await page.keyboard.type("look");
  await expect(input).toHaveValue("");
  await page.keyboard.press("F6");
  await expect(page.getByTestId("workspace-editor")).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.locator(".play-area")).toBeFocused();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("look");
  await input.fill("");
  await page.keyboard.press("F6");
  await expect(parts).toBeFocused();
  await page.keyboard.press("F6");
  await expect(page.getByTestId("workspace-editor")).toBeFocused();
  await page.keyboard.type("editor typing");
  await expect(input).toHaveValue("");
  await page.keyboard.press("Control+Backquote");
  await expect(input).toBeFocused();
  await expect(page.locator(".focus-zone-announcement")).toHaveText("Game focused");
  expect((await textHook(page)).room).toBe(1);
  await page.keyboard.press(`${modifier}+Shift+P`);
  await page.keyboard.type("keyboard shortcuts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Keyboard shortcuts" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Quick open/ })).toContainText("P");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Help", exact: true })).toBeHidden();
  await page.getByTestId("help-menu").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("btn-keyboard-shortcuts").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await parts.focus();
  await page.keyboard.press(`${modifier}+Enter`);
  await expect(page).toHaveURL(/#play\//);
  await expect(input).toBeFocused();
  await expect(parts).toBeHidden();
  await page.keyboard.type("look");
  await expect(input).toHaveValue("look");
  await page.keyboard.press(`${modifier}+Shift+P`);
  await expect(page.getByRole("combobox")).toHaveCount(0);
});
