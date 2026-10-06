import { workspaceUpdated, workspaceSaved } from "./engineProbe.ts";
import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import type { Page, Locator } from "@playwright/test";
import { decodePng } from "../../scripts/png.ts";
async function starter(page: Page): Promise<void> {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Workspace proof");
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
}
test("one running workspace retains editors and opens Focus with a chord @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("room-studio")).toBeVisible();
  await expect(page.locator(".play-area")).toBeVisible();
  const before = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(before);
  await expect(page.getByTestId("studio-keep")).toHaveCount(0);
  await page.getByTestId("workspace-focus").click();
  await expect(page.locator(".play-area")).toBeHidden();
  await expect(page.getByTestId("workspace-show-game")).toBeVisible();
  const focused = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(focused);
  await reviewShot(page, "workspace-picture-focus");
  await page.getByTestId("workspace-show-game").click();
  await page.getByTestId("part-room:1:logic").click();
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
  const logicSource = await page.evaluate(
    () =>
      (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): { model: { capture(): { read(key: string): { content: string } } } };
          };
        }
      ).__AGI_PROJECT__
        .getSession()
        .model.capture()
        .read("logic:1").content,
  );
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    logicSource + "\n" + Array.from({ length: 60 }, (_, index) => `// Line ${index}\n`).join(""),
  );
  await workspaceUpdated(page);
  await page.locator(".monaco-editor textarea").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  // Monaco paints the keyboard selection on its next render frame.
  await expect(page.locator(".monaco-editor .selected-text").first()).toBeVisible();
  const retained = await page.getByTestId("workspace-logic-editor").evaluate((root) => {
    const cursor = root.querySelector<HTMLElement>(".cursor");
    const selection = root.querySelector<HTMLElement>(".selected-text");
    const scroll = root.querySelector<HTMLElement>(".scrollbar.vertical .slider");
    return {
      cursor: cursor && { top: cursor.style.top, left: cursor.style.left },
      selection: selection?.style.cssText,
      scroll: scroll && { top: scroll.style.top, height: scroll.style.height },
    };
  });
  expect(retained.cursor).toBeTruthy();
  expect(retained.selection).toBeTruthy();
  expect(Number.parseFloat(retained.scroll?.top ?? "0")).toBeGreaterThan(0);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(page.locator(".play-strip")).toBeVisible();
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page.locator(".play-strip")).toBeHidden();
  await expect
    .poll(() =>
      page.getByTestId("workspace-logic-editor").evaluate((root) => {
        const cursor = root.querySelector<HTMLElement>(".cursor");
        const selection = root.querySelector<HTMLElement>(".selected-text");
        const scroll = root.querySelector<HTMLElement>(".scrollbar.vertical .slider");
        return {
          cursor: cursor && { top: cursor.style.top, left: cursor.style.left },
          selection: selection?.style.cssText,
          scroll: scroll && { top: scroll.style.top, height: scroll.style.height },
        };
      }),
    )
    .toEqual(retained);
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("if (");
  await expect(page.getByTestId("workspace-last-good")).toBeVisible();
  await workspaceSaved(page);
  // Start the workspace chord outside Monaco's completion popup. Escape in
  // the editor dismisses that popup before the workspace's two-key sequence.
  await page.getByTestId("workspace-focus").focus();
  await expect(page.locator(".suggest-widget.visible")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("z");
  await expect(page.getByTestId("workspace-show-game")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".play-area")).toBeVisible();
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("workspace-editor")).toBeHidden();
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("workspace-last-good")).toBeVisible();
});
test("Blank adds its first room through the session @webkit-desktop", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await page
    .getByTestId("create-adventure-disclosure")
    .getByLabel("Name", { exact: true })
    .fill("Empty proof");
  await page.getByTestId("local-create-kind-blank").click();
  await page.getByRole("button", { name: "Start building", exact: true }).click();
  await expect(page.getByText("Nothing to play yet.", { exact: true })).toBeVisible();
  const emptyBox = (await page.getByTestId("empty-project-stage").boundingBox())!;
  expect(emptyBox.y).toBe(0);
  await page.getByTestId("empty-add-room").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

test("drawing, LOGIC and VIEW edit MAIN, Undo spans editors, reload keeps edits @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  const probe = () =>
    page.evaluate(() => {
      const session = (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): {
              runToken: string;
              capture(): { history: { commits: unknown[] } };
            } | null;
          };
        }
      ).__AGI_PROJECT__.getSession();
      return (
        session && { token: session.runToken, commits: session.capture().history.commits.length }
      );
    });
  const original = await probe();
  await page.getByTestId("part-room:1:picture:1").click();
  const studio = page.getByTestId("room-studio");
  await studio.locator('[data-tool="rect"]').click();
  await studio.getByTestId("studio-tool-filled").check();
  await studio.locator('.workspace-palette [data-colour="4"]').click();
  const box = (await studio.locator(".studio-pane").boundingBox())!;
  const zoom = box.height / 168;
  await page.mouse.move(box.x + 20.5 * 2 * zoom, box.y + 110.5 * zoom);
  await page.mouse.down();
  await page.mouse.move(box.x + 24.5 * 2 * zoom, box.y + 114.5 * zoom, { steps: 4 });
  await page.mouse.up();
  await workspaceUpdated(page);
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
    .toBe(4);
  await reviewShot(page, "workspace-picture");
  await page.getByTestId("workspace-focus").click();
  await studio.locator('[data-tool="brush"]').click();
  const focusBox = (await studio.locator(".studio-pane").boundingBox())!;
  await page.mouse.click(
    focusBox.x + 30.5 * 2 * (focusBox.height / 168),
    focusBox.y + 110.5 * (focusBox.height / 168),
  );
  await workspaceUpdated(page);
  await page.getByTestId("workspace-show-game").click();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[110 * 160 + 30]))
    .toBe(4);
  await page.getByTestId("part-room:1:logic").click();
  const source = await page.evaluate(
    () =>
      (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): { model: { capture(): { read(key: string): { content: string } } } };
          };
        }
      ).__AGI_PROJECT__
        .getSession()
        .model.capture()
        .read("logic:1").content,
  );
  await page.getByTestId("workspace-focus").click();
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    source.replace(
      "You stand in a sunny clearing. A path leads past a grey cottage and a big leafy tree.",
      "A red flower grows.",
    ),
  );
  await workspaceUpdated(page);
  await page.getByTestId("workspace-show-game").click();
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join("\n"))
    .toContain("A red flower grows.");
  await page.keyboard.press("Enter");
  await page.getByTestId("part-view:0").click();
  const sprite = page.getByTestId("sprite-studio");
  await expect(sprite).toBeVisible();
  await sprite.locator('[data-loop="2"][data-cel="0"]').click();
  await sprite.getByTestId("sprite-palette").locator('[data-colour="4"]').click();
  const cel = (await sprite.getByTestId("sprite-canvas").boundingBox())!;
  const hero = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __AGI_PROJECT__: {
          query(type: "objects"): Promise<
            {
              num: number;
              x: number;
              y: number;
              width: number;
              height: number;
              loop: number;
              cel: number;
            }[]
          >;
        };
      }
    ).__AGI_PROJECT__;
    return (await api.query("objects")).find((object) => object.num === 0)!;
  });
  expect(hero.loop).toBe(2);
  expect(hero.cel).toBe(0);
  const pixel =
    (hero.y - hero.height + 1 + Math.floor(hero.height * 0.45)) * 160 +
    hero.x +
    Math.floor(hero.width * 0.45);
  const previousHeroPixel = await page.evaluate(
    (index) => window.__AGI_FRAME__?.()?.visual[index],
    pixel,
  );
  expect(previousHeroPixel).not.toBe(4);
  await page.mouse.click(cel.x + cel.width * 0.45, cel.y + cel.height * 0.45);
  await workspaceUpdated(page);
  await expect
    .poll(() => page.evaluate((index) => window.__AGI_FRAME__?.()?.visual[index], pixel))
    .toBe(4);
  await expect.poll(async () => (await probe())?.commits).toBe((original?.commits ?? 0) + 4);
  expect((await probe())?.token).toBe(original?.token);
  await reviewShot(page, "workspace-view");
  await page.getByTestId("workspace-undo").click();
  await expect
    .poll(() => page.evaluate((index) => window.__AGI_FRAME__?.()?.visual[index], pixel))
    .toBe(previousHeroPixel);
  await page.getByTestId("workspace-undo").click();
  await page.getByTestId("workspace-undo").click();
  await page.getByTestId("workspace-undo").click();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
    .not.toBe(4);
  for (let i = 0; i < 4; i++) await page.getByTestId("workspace-redo").click();
  await workspaceUpdated(page);
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
    .toBe(4);
  // Choosing Play adopts the temporary launch before this progress checkpoint.
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const checkpointCycle = (await textHook(page)).cycle;
  await expect
    .poll(async () => (await textHook(page)).autosave, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(checkpointCycle);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
    .toBe(4);
  await expect
    .poll(() => page.evaluate((index) => window.__AGI_FRAME__?.()?.visual[index], pixel))
    .toBe(4);
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join("\n"))
    .toContain("A red flower grows.");
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`workspace review at ${size.width}×${size.height} @webkit-desktop`, async ({ page }) => {
    await page.setViewportSize(size);
    await starter(page);
    const shot = (name: string) =>
      reviewShot(page, `${test.info().project.name || "chromium"}-${size.width}-${name}`);
    await page.getByTestId("part-room:1:picture:1").click();
    await expect(page.getByTestId("room-studio")).toBeVisible();
    await shot("picture");
    await page.getByTestId("workspace-focus").click();
    await shot("picture-focus");
    await page.getByTestId("workspace-show-game").click();
    // Headings explain themselves: the heading is the trigger, with no ? icon.
    await expect(page.getByTestId("explain-parts-rooms")).toHaveText("ROOMS");
    await expect(page.getByTestId("parts-list").getByText("?", { exact: true })).toHaveCount(0);
    await page.getByTestId("explain-parts-rooms").focus();
    await expect(page.getByTestId("explain-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("explain-parts-rooms").click();
    await expect(page.getByTestId("explain-pop")).toBeVisible();
    await shot("parts-help");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("explain-pop")).toBeHidden();
    await page.getByTestId("part-room:1:logic").click();
    await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
    await page.locator(".monaco-editor").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("if (");
    await expect(page.getByTestId("workspace-last-good")).toBeVisible();
    await workspaceSaved(page);
    await page.keyboard.press("ControlOrMeta+j");
    await expect(page.getByTestId("workspace-problems")).toBeVisible();
    await shot("logic-error");
    await page.getByTestId("workspace-focus").click();
    await expect
      .poll(async () => (await page.locator(".monaco-editor").boundingBox())?.width ?? 0)
      .toBeGreaterThan(size.width - 10);
    await shot("logic-focus");
    await expect(page.getByTestId("workspace-problems")).toBeHidden();
    await page.getByTestId("workspace-show-game").click();
    await page.getByTestId("part-view:0").click();
    await expect(page.getByTestId("sprite-studio")).toBeVisible();
    const editorBox = (await page.getByTestId("workspace-editor").boundingBox())!;
    expect(editorBox.y + editorBox.height).toBeGreaterThanOrEqual(size.height - 1);
    await shot("view");
    await page.getByTestId("part-words").click();
    await shot("words");
    await page.getByRole("radio", { name: "Play", exact: true }).click();
    await shot("play");
    await page.getByTestId("btn-exit").click();
    await expect.poll(() => page.evaluate(() => window.__AGI_STATE__?.phase)).toBe("idle");
    await page.goto("/#create-adventure");
    await page
      .getByTestId("create-adventure-disclosure")
      .getByLabel("Name", { exact: true })
      .fill("Empty workspace");
    await page.getByTestId("local-create-kind-blank").click();
    await page.getByRole("button", { name: "Start building", exact: true }).click();
    await expect(page.getByText("Nothing to play yet.", { exact: true })).toBeVisible();
    await shot("empty");
  });
}

async function tabTo(page: Page, target: Locator): Promise<void> {
  // Safari's Option+Tab visits buttons as well as text controls.
  const tab = page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab";
  for (let i = 0; i < 100; i++) {
    if (
      await target.evaluateAll((elements) =>
        elements.some((element) => element === document.activeElement),
      )
    )
      return;
    await page.keyboard.press(tab);
  }
  throw new Error(`Keyboard cannot reach ${target}`);
}
async function keyboardOpen(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+p");
  await expect(page.getByRole("combobox", { name: "Quick open" })).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Quick open" })).toBeHidden();
}
test("keyboard authors all three parts, undoes across them and reloads @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await isolateStorage(page);
  await page.goto("/#create-adventure");
  await tabTo(
    page,
    page.getByTestId("create-adventure-disclosure").getByLabel("Name", { exact: true }),
  );
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("Keyboard workspace");
  await tabTo(page, page.getByTestId("local-create-kind-starter"));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Start building", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("create-adventure-disclosure")).toBeHidden();
  await expect(page.getByTestId("input-line")).toBeEnabled();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await keyboardOpen(page, "PICTURE 1");
  const studio = page.getByTestId("room-studio");
  await expect(studio).toBeVisible();
  await tabTo(page, studio.locator(".studio__stage"));
  await page.keyboard.press("b");
  await tabTo(page, studio.locator('.workspace-palette [tabindex="0"]'));
  for (
    let i = 0;
    i < 16 &&
    (await page.evaluate(() => document.activeElement?.getAttribute("data-colour"))) !== "4";
    i++
  )
    await page.keyboard.press("ArrowRight");
  await tabTo(page, studio.locator(".studio__stage"));
  await page.keyboard.press("b");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await workspaceUpdated(page);
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[84 * 160 + 80]))
    .toBe(4);
  await keyboardOpen(page, "LOGIC 1");
  await expect(page.getByTestId("workspace-logic-editor")).toBeVisible();
  const source = await page.evaluate(
    () =>
      (
        window as unknown as {
          __AGI_PROJECT__: {
            getSession(): { model: { capture(): { read(k: string): { content: string } } } };
          };
        }
      ).__AGI_PROJECT__
        .getSession()
        .model.capture()
        .read("logic:1").content,
  );
  await tabTo(page, page.locator(".monaco-editor textarea"));
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    source.replace(
      "You stand in a sunny clearing. A path leads past a grey cottage and a big leafy tree.",
      "Keyboard flower.",
    ),
  );
  await workspaceUpdated(page);
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join("\n"))
    .toContain("Keyboard flower.");
  await page.keyboard.press("Enter");
  await keyboardOpen(page, "VIEW 0");
  const sprite = page.getByTestId("sprite-studio");
  await expect(sprite).toBeVisible();
  await tabTo(page, sprite.locator('[data-loop][data-cel][tabindex="0"]'));
  const currentLoop = Number(
    await page.evaluate(() => document.activeElement?.getAttribute("data-loop")),
  );
  for (let i = currentLoop; i < 2; i++) await page.keyboard.press("ArrowDown");
  await tabTo(page, sprite.locator('[data-testid="sprite-palette"] [tabindex="0"]'));
  for (
    let i = 0;
    i < 16 &&
    (await page.evaluate(() => document.activeElement?.getAttribute("data-colour"))) !== "4";
    i++
  )
    await page.keyboard.press("ArrowRight");
  const hero = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __AGI_PROJECT__: {
          query(type: "objects"): Promise<
            {
              num: number;
              x: number;
              y: number;
              width: number;
              height: number;
              loop: number;
              cel: number;
            }[]
          >;
        };
      }
    ).__AGI_PROJECT__;
    return (await api.query("objects")).find((object) => object.num === 0)!;
  });
  expect(hero.loop).toBe(2);
  const pixel =
    (hero.y - hero.height + 1 + Math.floor(hero.height / 2)) * 160 +
    hero.x +
    Math.floor(hero.width / 2);
  const beforePixel = await page.evaluate(
    (index) => window.__AGI_FRAME__?.()?.visual[index],
    pixel,
  );
  expect(beforePixel).not.toBe(4);
  await tabTo(page, sprite.getByTestId("sprite-stage"));
  await page.keyboard.press("b");
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  await workspaceUpdated(page);
  await expect
    .poll(() => page.evaluate((index) => window.__AGI_FRAME__?.()?.visual[index], pixel))
    .toBe(4);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByTestId("workspace-redo")).toBeEnabled();
  }
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[84 * 160 + 80]))
    .not.toBe(4);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.getByTestId("workspace-undo")).toBeEnabled();
  }
  await workspaceUpdated(page);
  // Choosing Play adopts the temporary launch before this progress checkpoint.
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const checkpointCycle = (await textHook(page)).cycle;
  await expect
    .poll(async () => (await textHook(page)).autosave, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(checkpointCycle);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[84 * 160 + 80]))
    .toBe(4);
  await expect
    .poll(() => page.evaluate((index) => window.__AGI_FRAME__?.()?.visual[index], pixel))
    .toBe(4);
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await textHook(page)).rows.join("\n"))
    .toContain("Keyboard flower.");
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByTestId("btn-exit"));
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__AGI_STATE__?.phase)).toBe("idle");
  await tabTo(page, page.getByRole("button", { name: "Make a new game", exact: true }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByTestId("local-create-kind-starter"));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("local-create-kind-blank")).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Start building", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByText("Nothing to play yet.", { exact: true })).toBeVisible();
  await tabTo(page, page.getByTestId("empty-add-room"));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

test("adding a room waits for Update before its PICTURE opens on the visited stage @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page
    .getByTestId("parts-list")
    .getByRole("button", { name: "Add a room", exact: true })
    .click();
  await expect(page.getByTestId("workspace-guided-form")).toBeVisible();
  await page.getByLabel("Room name", { exact: true }).fill("Garden");
  await page
    .getByTestId("workspace-guided-form")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await workspaceUpdated(page);
  await expect(page.getByTestId("part-room:2:picture:2")).toBeVisible();
  await page.getByTestId("part-room:2:picture:2").click();
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("room-studio").locator(".studio-pane")).toBeVisible();
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await expect(page.getByTestId("room-studio")).not.toHaveClass(/is-live-game/);
  await expect(page.getByTestId("room-studio").locator(".play-area")).toHaveCount(0);
  await expect(page.locator(".play-area")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  await expect(page.getByTestId("workspace-visit")).toBeVisible();
  await expect(page.getByTestId("workspace-update")).toHaveText("Restart Garden");
  await workspaceUpdated(page);
});

test("Tab opens the Starter's inventory and keeps the keyboard in the game", async ({ page }) => {
  await starter(page);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const command = page.locator("#game-command");
  await command.focus();
  await page.keyboard.press("Tab");
  await expect(command).toBeFocused();
  await expect.poll(async () => (await textHook(page)).modal).toBe("inventory");
});

test("Home Continue resumes the Starter in its room", async ({ page }) => {
  await starter(page);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  const before = (await textHook(page)).egoX;
  await page.keyboard.press("Control+`");
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(before + 6);
  await page.keyboard.up("ArrowRight");
  const position = (await textHook(page)).egoX;
  await page.getByTestId("btn-exit").click();
  await expect.poll(() => page.evaluate(() => window.__AGI_STATE__?.phase)).toBe("idle");
  await page.getByRole("button", { name: "Continue Workspace proof", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const resumed = (await textHook(page)).cycle;
  expect((await textHook(page)).egoX).toBeGreaterThanOrEqual(position);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(resumed);
});

test("parts preview replaces, double click and editing pin, close uses the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect(page.getByTestId("project-tab-picture:1")).toHaveCSS("font-style", "italic");
  await page.getByTestId("part-view:0").click();
  await expect(page.getByTestId("project-tab-picture:1")).toHaveCount(0);
  await page.getByTestId("part-view:0").dblclick();
  await expect(page.getByTestId("project-tab-view:0")).toHaveCSS("font-style", "normal");
  await page.getByTestId("part-words").click();
  await expect(page.getByTestId("project-tab-view:0")).toBeVisible();
  await page.getByTestId("project-tab-words").dblclick();
  await expect(page.getByTestId("project-tab-words")).toHaveCSS("font-style", "normal");
  await page.getByTestId("part-room:1:logic").click();
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// Pinned by typing");
  await expect(page.getByTestId("project-tab-logic:1")).toHaveCSS("font-style", "normal");
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.getByTestId("project-tab-logic:1")).toHaveCount(0);
  const parts = await page
    .locator("[data-part-row]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")!));
  for (const id of parts) await page.getByTestId(id).dblclick();
  await page.getByTestId("part-inventory").click();
  const strip = page.getByTestId("project-studio-tabs");
  await expect
    .poll(() => strip.evaluate((root) => root.scrollWidth - root.clientWidth))
    .toBeGreaterThan(0);
  await expect.poll(() => strip.evaluate((root) => root.scrollLeft)).toBeGreaterThan(0);
  const stripBox = (await strip.boundingBox())!;
  const active = (await strip.getByRole("tab", { selected: true }).boundingBox())!;
  expect(active.x).toBeGreaterThanOrEqual(stripBox.x);
  expect(active.x + active.width).toBeLessThanOrEqual(stripBox.x + stripBox.width);
});

test("Undo and History restore apply while a game message waits", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  await page.getByTestId("part-room:1:logic").click();
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// Instant Undo");
  await workspaceUpdated(page);
  await page.keyboard.press("Control+`");
  await page.keyboard.type("look");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textHook(page)).rows.join("\n")).toContain("sunny clearing");
  await page.getByTestId("workspace-undo").click();
  await expect(page.locator(".monaco-editor")).not.toContainText("Instant Undo");
  await expect(page.getByTestId("workspace-redo")).toBeEnabled();
  await expect(page.getByTestId("workspace-live")).toBeVisible();
  await expect(page.getByTestId("workspace-live")).toHaveText("Now");
  await expect
    .poll(async () => (await textHook(page)).rows.join("\n"))
    .not.toContain("sunny clearing");
  await page.getByTestId("workspace-redo").click();
  await expect(page.locator(".monaco-editor")).toContainText("Instant Undo");
  await page.getByTestId("workspace-saved").click();
  const restore = page
    .getByTestId("workspace-history")
    .getByRole("button", { name: "Restore", exact: true })
    .last();
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect(page.locator(".monaco-editor")).not.toContainText("Instant Undo");
  const closeHistory = page
    .getByTestId("workspace-history")
    .getByRole("button", { name: "Close", exact: true });
  await expect(closeHistory).toBeVisible();
  await closeHistory.click();
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// Latest while waiting");
  await workspaceSaved(page);
  await page.getByTestId("workspace-update").click();
  await expect(page.getByTestId("workspace-update")).toBeEnabled();
  await expect(page.getByTestId("workspace-updated")).toBeVisible();
  await expect(page.getByTestId("workspace-live")).toBeVisible();
  await expect(page.getByTestId("workspace-live")).toHaveText("Now");
  await expect(page.locator(".monaco-editor")).toContainText("Latest while waiting");
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`polished workspace at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await starter(page);
    const shot = (name: string) =>
      reviewShot(page, `chromium-${size.width}x${size.height}-${name}`);
    const body = (await page.locator(".shell-body").boundingBox())!;
    const parts = (await page.getByTestId("parts-list").boundingBox())!;
    const area = (await page.locator(".play-area").boundingBox())!;
    expect(area.width).toBeGreaterThan(body.width - parts.width - 10);
    await shot("idle-create");
    await page.getByTestId("part-room:1:picture:1").click();
    const studio = page.getByTestId("room-studio");
    await expect(studio.getByRole("radiogroup", { name: "Lens", exact: true })).toBeVisible();
    await expect(studio.getByRole("radio", { name: "Art", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const options = (await studio.getByTestId("studio-options-bar").boundingBox())!;
    const lens = (await studio
      .getByRole("radiogroup", { name: "Lens", exact: true })
      .boundingBox())!;
    expect(lens.y).toBeGreaterThanOrEqual(options.y);
    expect(lens.y + lens.height).toBeLessThanOrEqual(options.y + options.height);
    const footer = (await studio.locator(".studio__status").boundingBox())!;
    const palette = (await studio.locator(".workspace-palette").boundingBox())!;
    expect(footer.y).toBeGreaterThanOrEqual(palette.y + palette.height);
    await expect(studio.getByTestId("studio-value-priority")).toBeVisible();
    await expect(studio.getByTestId("studio-value-priority")).toHaveText("None");
    await expect(studio.getByTestId("studio-value-priority")).toBeDisabled();
    await studio.getByTestId("explain-drawing-depth").click();
    await expect(page.getByTestId("explain-pop")).toContainText("drawing tools");
    await page.keyboard.press("Escape");
    await shot("picture");
    await page.getByTestId("part-view:0").click();
    const panel = (await page.locator(".sprite-studio__panel").boundingBox())!;
    expect(panel.width).toBeGreaterThanOrEqual(290);
    const optionsFit = await page
      .locator(".sprite-options")
      .evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(optionsFit).toBe(true);
    const edit = (await page.getByTestId("workspace-editor").boundingBox())!;
    const game = (await page.locator(".play-area").boundingBox())!;
    expect(edit.width).toBeGreaterThan(game.width);
    await shot("view");
    await page.getByTestId("part-words").click();
    await expect(
      page.getByTestId("workspace-table-editor").getByRole("columnheader", { name: "Group" }),
    ).toHaveCount(0);
    const ignored = page.locator('[data-word-group="0"]');
    await expect(ignored).toContainText("a");
    const group = page.locator('[data-word-group="100"]');
    await group.hover();
    await group.getByRole("button", { name: "Add word", exact: true }).click();
    const input = group.getByRole("textbox");
    await input.fill("inspect");
    await input.press("Enter");
    await expect(group.getByRole("button", { name: "Remove inspect", exact: true })).toBeVisible();
    await input.press("Backspace");
    await expect(group.getByRole("button", { name: "Remove inspect", exact: true })).toHaveCount(0);
    await workspaceUpdated(page);
    await shot("words");
    await page.getByTestId("part-inventory").click();
    await expect(page.getByRole("columnheader", { name: "Object", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Room", exact: true })).toBeVisible();
    await page.getByTestId("part-view:0").dblclick();
    await page.getByTestId("part-words").dblclick();
    await page.getByTestId("part-room:1:picture:1").click();
    await expect(page.getByTestId("project-tab-picture:1")).toHaveCSS("font-style", "italic");
    await shot("preview-tabs");
  });
}

test("parts show keyboard focus and align the VIEW thumbnail with other rows", async ({ page }) => {
  await starter(page);
  const part = page.getByTestId("part-view:0");
  await part.click();
  await expect(page.getByTestId("sprite-studio")).toBeVisible();
  await part.click();
  await expect(part).toBeFocused();
  await expect.soft(page.getByTestId("parts-list")).toHaveCSS("outline-style", "none");
  const thumbnailWidth = await part
    .locator(".view-thumbnail")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect.soft(thumbnailWidth).toBe(44);
  const gap = await part.evaluate((row) => {
    const thumbnail = row.querySelector(".view-thumbnail")!.getBoundingClientRect();
    const label = row.querySelector("span:not(.view-thumbnail)")!.getBoundingClientRect();
    return label.left - thumbnail.right;
  });
  expect.soft(gap).toBeLessThanOrEqual(10);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(part).toBeFocused();
  await expect(part).toHaveCSS("outline-style", "solid");
});

test("VIEW thumbnails animate only in visible parts and follow reduced motion @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const timers = new Set<number>();
    const browser = window as Window;
    const start = browser.setInterval.bind(browser);
    const clear = browser.clearInterval.bind(browser);
    Object.assign(window, { __viewTimers: timers });
    browser.setInterval = (...args: Parameters<Window["setInterval"]>) => {
      const timer = start(...args);
      if (args[1] === 180) timers.add(timer);
      return timer;
    };
    browser.clearInterval = (timer) => {
      timers.delete(timer!);
      clear(timer);
    };
  });
  const active = () =>
    page.evaluate(() => (window as unknown as { __viewTimers: Set<number> }).__viewTimers.size);
  await starter(page);
  const part = page.getByTestId("part-view:0");
  await part.scrollIntoViewIfNeeded();
  await expect.poll(active).toBe(1);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(active).toBe(0);
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect.poll(active).toBe(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(active).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(active).toBe(1);
  await page.getByTestId("parts-list").evaluate((list) => {
    list.style.height = "200px";
    list.scrollTop = 0;
  });
  await expect.poll(active).toBe(0);
  await part.scrollIntoViewIfNeeded();
  await expect.poll(active).toBe(1);
});

/** The GPU canvas as the player sees it, sampled at the same game pixel. */
async function renderedColourOf(page: Page): Promise<number[]> {
  const canvas = page.getByTestId("gpu-canvas");
  await expect(canvas).toBeVisible();
  // Decode in the runner: sending the PNG back through CDP competes with game rendering.
  const { width, height, rgba } = decodePng(await canvas.screenshot());
  const offset = (Math.floor(height * 0.8) * width + Math.floor(width / 2)) * 4;
  return [...rgba.subarray(offset, offset + 3)];
}

async function sourceColourOf(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="game-canvas"]')!;
    return [...canvas.getContext("2d")!.getImageData(160, 160, 1, 1).data].slice(0, 3);
  });
}

test("Create renders crisp while Play retains the CRT preference", async ({ page }) => {
  // Hold the GPU stage until Create runs, so it also arrives after the game starts.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/src/three/AgiStage.ts", async (route) => {
    await gate;
    await route.continue();
  });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("monotio_agi.e2e.isolated", "1");
    localStorage.setItem("monotio_agi.crt", "on");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await starter(page);
  release();
  // Compare with the game's own picture once it has painted.
  await expect.poll(() => sourceColourOf(page)).not.toEqual([0, 0, 0]);
  const sourceColour = await sourceColourOf(page);
  const renderedColour = () => renderedColourOf(page);
  await expect.poll(renderedColour).toEqual(sourceColour);
  await page.getByTestId("part-room:1:picture:1").click();
  await expect.poll(renderedColour).toEqual(sourceColour);
  await page.getByRole("radio", { name: "Play", exact: true }).click();
  await expect.poll(renderedColour).not.toEqual(sourceColour);
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.crt"))).toBe("on");
  await page.getByRole("radio", { name: "Create", exact: true }).click();
  await expect.poll(renderedColour).toEqual(sourceColour);
});
