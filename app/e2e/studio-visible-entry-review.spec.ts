import { openLibraryActions, savedGameCard, storedAutosave } from "./engineProbe.ts";
import { blockProviders, createProjectViaUi, prepareIsolatedPage } from "./logicDebugShared.ts";
import { expect, reviewShot, test } from "./test.ts";

test("a manually created game has a Edit action in its game menu @webkit-desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const title = "Visible creation route";
  await createProjectViaUi(page, title);
  const card = savedGameCard(page, title);
  await openLibraryActions(page, card);
  const edit = page.getByTestId("edit-library-game");
  await expect(edit).toBeVisible();
  await expect(edit).toBeEnabled();
  await expect(card.getByTestId("btn-resume-cached")).toBeVisible();
  await reviewShot(page, "studio-visible-entry");
  await edit.click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(providers.count()).toBe(0);
});

test("leaving during cold creation saves the project without Play progress when editors finish loading @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  let releaseEditor!: () => void;
  const editor = new Promise<void>((resolve) => {
    releaseEditor = resolve;
  });
  let editorRequested = false;
  await page.route("**/src/studio/workspace/CreateWorkspace.vue", async (route) => {
    editorRequested = true;
    await editor;
    await route.continue();
  });
  await page.goto("/#create-adventure");
  const title = "Early departure";
  await page.getByTestId("local-create-title").fill(title);
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  const exit = page.getByTestId("btn-exit");
  await expect(exit).toBeVisible();
  await expect.poll(() => editorRequested).toBe(true);
  await exit.click();
  const loaded = page.waitForResponse("**/src/studio/workspace/CreateWorkspace.vue");
  releaseEditor();
  await loaded;
  const card = savedGameCard(page, title);
  await expect(card).toBeVisible();
  const id = await page.evaluate(async (title) => {
    const { listStoredProjects } = await import("/src/project/gameStorage.ts");
    return (await listStoredProjects()).find((project) => project.title === title)!.projectId;
  }, title);
  expect(await storedAutosave(page, id)).toBeNull();
  await openLibraryActions(page, card);
  await page.getByTestId("edit-library-game").click();
  await expect(page.getByTestId("parts-list")).toBeVisible();
});
