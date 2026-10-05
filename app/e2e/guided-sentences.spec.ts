import { test, expect } from "./test.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";
import type { Page } from "@playwright/test";
import type { WorkerQueryFn } from "../src/worker/workerProtocol.ts";
import {
  isolateStorage,
  openLibraryActions,
  savedGameCard,
  workspaceSaved,
  textHook,
} from "./engineProbe.ts";
import { workspaceDocument } from "./workspaceShared.ts";

async function start(page: Page) {
  await isolateStorage(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const { prepareLocalProject } = await import("/src/project/localProject.ts");
    await prepareLocalProject({ title: "Sunny clearing", kind: "starter" }).save();
  });
  await page.reload();
  await openLibraryActions(page, savedGameCard(page, "Sunny clearing"));
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("workspace-add")).toBeVisible();
}

test("visual actions keep exact controls and preview their LOGIC", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const startX = (await textHook(page)).egoX;
  await page.keyboard.press("Control+`");
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(startX + 6);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const probe = (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } })
          .__AGI_PROJECT__;
        return (await probe.query("state"))?.egoDirection;
      }),
    )
    .toBe(0);
  const position = await page.evaluate(() =>
    (window as unknown as { __AGI_PROJECT__: { query: WorkerQueryFn } }).__AGI_PROJECT__.query(
      "state",
    ),
  );
  expect(position).not.toBeNull();
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: "Place hero", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: "Start here", exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "Drag to place", exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Start here", exact: true }).click();
  const code = form.getByTestId("guided-code-preview");
  await expect(code).toBeVisible();
  await expect(code).toContainText(`position(o0, ${position!.egoX}, ${position!.egoY})`);
  await expect(form.getByLabel("X", { exact: true })).toBeHidden();
  await form.getByText("Exact numbers", { exact: true }).click();
  await form.getByLabel("X", { exact: true }).fill("90");
  await form.getByLabel("Y", { exact: true }).fill("140");
  await expect(code).toContainText("position(o0, 90, 140)");
});

test("responses check the whole sentence and show a live game message", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.getByTestId("workspace-add").click();
  await expect(
    page.getByRole("menuitem", { name: "Answer a sentence", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Answer a sentence", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByLabel("When the player types…", { exact: true }).fill("look at sun");
  await form.getByLabel("The game says…", { exact: true }).fill("The sun shines.");
  const check = form.getByTestId("guided-parser-check");
  await expect(check).toBeVisible();
  await expect(check).toContainText("look at sun");
  await expect(check).toContainText("look sun");
  await expect(form.getByRole("img", { name: "Game message preview" })).toBeVisible();
  const code = form.getByTestId("guided-code-preview");
  await expect(code).toBeVisible();
  await expect(code).toContainText('said("look", "sun")');
  await form.getByRole("button", { name: "Also answer inspect sun", exact: true }).click();
  await expect(code).toContainText('said("inspect", "sun")');
  await form.getByLabel("When the player types…", { exact: true }).fill("look at moon");
  await expect(code).not.toContainText('said("inspect", "sun")');
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeHidden();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('print("The sun shines.")');
});

test("WORDS teaches a new thing and its sentence reply in one Undo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const beforeWords = await workspaceDocument(page, "words");
  const beforeLogic = await workspaceDocument(page, "logic:1");
  await page.getByTestId("part-words").click();
  const words = page.getByTestId("workspace-words-editor").filter({ visible: true });
  await expect(words).toBeVisible();
  await words.getByLabel("A sentence a player might type").fill("look at sun");
  await words.getByRole("button", { name: "Teach “sun”…", exact: true }).click();
  const teach = words.getByRole("form", { name: "Teach sun", exact: true });
  await expect(teach).toBeVisible();
  await expect(teach.getByLabel("A new thing", { exact: true })).toBeChecked();
  await teach.getByLabel("The game says…", { exact: true }).fill("The sun shines.");
  await teach.getByRole("button", { name: "Add", exact: true }).click();
  await expect(teach).toBeHidden();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('said("look", "sun")');
  await page.getByTestId("workspace-undo").click();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "words")).toBe(beforeWords);
  expect(await workspaceDocument(page, "logic:1")).toBe(beforeLogic);
});

test("sound recipes explain and audition before adding a new sentence trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.getByTestId("workspace-add").click();
  await expect(
    page.getByRole("menuitem", { name: "Play a sound when…", exact: true }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Play a sound when…", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByLabel("When the player types…", { exact: true }).fill("ring the bell");
  const recipes = form.getByRole("group", { name: "New sound from a recipe", exact: true });
  await expect(recipes).toBeVisible();
  await expect(recipes).toContainText("Adds a new SOUND to your game");
  await recipes.getByRole("button", { name: "Play Discovery", exact: true }).click();
  const discovery = recipes.getByRole("button", { name: "Discovery", exact: true });
  await discovery.click();
  const danger = recipes.getByRole("button", { name: "Danger", exact: true });
  await expect(discovery).toBeVisible();
  await expect(danger).toBeVisible();
  await expect
    .poll(async () => {
      const selectedBorder = await discovery.evaluate(
        (button) => getComputedStyle(button).borderTopColor,
      );
      return (
        selectedBorder !==
        (await danger.evaluate((button) => getComputedStyle(button).borderTopColor))
      );
    })
    .toBe(true);
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await expect(form).toBeHidden();
  await workspaceSaved(page);
  expect(await workspaceDocument(page, "logic:1")).toContain('said("ring", "bell")');
});

test("Place hero starts with the room’s current VIEW", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.evaluate(async () => {
    const session = (
      window as unknown as {
        __AGI_PROJECT__: {
          getSession(): ProjectSession;
        };
      }
    ).__AGI_PROJECT__.getSession();
    const base = session.model.capture();
    const bindings = JSON.parse(base.read("bindings")!.content as string);
    bindings.ego_view.num = 3;
    await session.submit({
      proposal: session.model.propose(base, "Change hero VIEW", [
        { key: "bindings", content: JSON.stringify(bindings) },
        { key: "view:3", content: base.read("view:0")!.content },
      ]),
      label: "Change hero VIEW",
      author: "creator",
      origin: "view",
    });
  });
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: "Place hero", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByText("Exact numbers", { exact: true }).click();
  await expect(form.getByLabel("VIEW", { exact: true })).toHaveValue("3");
});

test("Door starts with its own coordinates and waits for a box and destination", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: "Place hero", exact: true }).click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await form.getByText("Exact numbers", { exact: true }).click();
  await form.getByLabel("X", { exact: true }).fill("150");
  await form.getByLabel("Y", { exact: true }).fill("160");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("workspace-add").click();
  await page.getByRole("menuitem", { name: "Door", exact: true }).click();
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await form.getByText("Exact numbers", { exact: true }).click();
  await expect(form.getByLabel("X", { exact: true })).toHaveValue("80");
  await expect(form.getByLabel("Y", { exact: true })).toHaveValue("140");
  await form.getByLabel("Destination ROOM", { exact: true }).fill("1");
  await form.getByLabel("Right", { exact: true }).fill("120");
  await expect(form.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(
    form.getByRole("status").filter({ hasText: "Choose another room for this door." }),
  ).toBeVisible();
  await form.getByLabel("Destination ROOM", { exact: true }).fill("2");
  await expect(form.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await form.getByLabel("Destination ROOM", { exact: true }).fill("");
  await expect(form.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
});

test("unknown play sentences open Answer and Players tried teaches beside its row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await start(page);
  const input = page.getByTestId("input-line");
  await input.focus();
  await page.keyboard.type("look at moon");
  await page.keyboard.press("Enter");
  const teachThis = page.getByRole("button", {
    name: "Teach this",
    exact: true,
    includeHidden: true,
  });
  await expect(teachThis).toBeVisible();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await teachThis.evaluate((button) => {
      button.style.visibility = "hidden";
    });
    await page.screenshot({
      path: test.info().outputPath(`teach-this-${width}-before.png`),
      scale: "css",
    });
    await teachThis.evaluate((button) => {
      button.style.visibility = "";
    });
    await page.screenshot({
      path: test.info().outputPath(`teach-this-${width}-after.png`),
      scale: "css",
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await teachThis.click();
  const form = page.getByTestId("workspace-guided-form");
  await expect(form).toBeVisible();
  await expect(form.getByLabel("When the player types…", { exact: true })).toHaveValue(
    "look at moon",
  );
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("part-words").click();
  const words = page.getByTestId("workspace-words-editor").filter({ visible: true });
  await expect(words).toBeVisible();
  await words.getByLabel("A sentence a player might type").fill("look at tree");
  const row = words.getByTestId("player-sentence").filter({ hasText: "look at moon" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Teach “moon”…", exact: true }).click();
  const anyTeach = words.getByRole("form", { name: "Teach moon", exact: true });
  await expect(anyTeach).toBeVisible();
  for (const [width, height] of [
    [1063, 815],
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    if (width === 390) {
      const part = page.getByTestId("part-words");
      if (!(await part.isVisible())) await page.getByTestId("workspace-parts").click();
      await part.click();
    }
    await expect(anyTeach).toBeVisible();
    await anyTeach.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`teach-row-${width}.png`), scale: "css" });
  }
  const teach = row.getByRole("form", { name: "Teach moon", exact: true });
  await expect(teach).toBeVisible();
  await expect(teach.getByLabel("When the player types…", { exact: true })).toHaveValue(
    "look at moon",
  );
  await expect(words.getByLabel("A sentence a player might type")).toHaveValue("look at tree");
});
