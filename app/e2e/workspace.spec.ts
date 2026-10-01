import { test, expect, reviewShot } from "./test.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";
import type { Page, Locator } from "@playwright/test";
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
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
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
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
    .toBe(4);
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
  await reviewShot(page, "workspace-picture");
  await page.getByTestId("workspace-focus").click();
  await studio.locator('[data-tool="brush"]').click();
  const focusBox = (await studio.locator(".studio-pane").boundingBox())!;
  await page.mouse.click(
    focusBox.x + 30.5 * 2 * (focusBox.height / 168),
    focusBox.y + 110.5 * (focusBox.height / 168),
  );
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
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect
    .poll(() => page.evaluate((index) => window.__AGI_FRAME__?.()?.visual[index], pixel))
    .toBe(4);
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[112 * 160 + 22]))
    .toBe(4);
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
    await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect
    .poll(() => page.evaluate(() => window.__AGI_FRAME__?.()?.visual[84 * 160 + 80]))
    .toBe(4);
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
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

test("adding a room opens its PICTURE beside the current game @webkit-desktop", async ({
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
  await expect(page.getByTestId("part-room:2:picture:2")).toBeVisible();
  await page.getByTestId("part-room:2:picture:2").click();
  await expect(page.getByTestId("room-studio").locator(".studio-pane")).toBeVisible();
  const cycle = (await textHook(page)).cycle;
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(cycle);
  await expect(page.locator(".shell-body > .play-area")).toBeVisible();
  expect((await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("workspace-saved")).toContainText("Saved");
});
