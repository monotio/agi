import { openLibraryActions, savedGameCard } from "./engineProbe.ts";
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

test("leaving during creation keeps the opening checkpoint when editors finish loading @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  let releaseEditor!: () => void;
  const editor = new Promise<void>((resolve) => {
    releaseEditor = resolve;
  });
  await page.route("**/src/project/projectSession.ts", async (route) => {
    await editor;
    await route.continue();
  });
  await page.addInitScript(() => {
    const request = navigator.locks.request.bind(navigator.locks);
    const gate = new Promise<void>((resolve) => {
      Object.assign(window, { releaseCheckpoint: resolve });
    });
    Object.defineProperty(navigator, "locks", {
      value: {
        request(name: string, callback: LockGrantedCallback<unknown>) {
          return request(name, async (lock) => {
            if (name.startsWith("monotio_agi.checkpoint.")) {
              Object.assign(window, { checkpointWaiting: true });
              await gate;
            }
            return callback(lock);
          });
        },
      },
    });
  });
  await page.goto("/#create-adventure");
  const title = "Early departure";
  await page.getByTestId("local-create-title").fill(title);
  await page.getByTestId("local-create-kind-starter").click();
  await page.getByTestId("local-create-submit").click();
  const exit = page.getByTestId("btn-exit");
  await expect(exit).toBeVisible();
  await exit.click();
  await page.waitForFunction(() => Reflect.get(window, "checkpointWaiting") === true);
  releaseEditor();
  await page.waitForFunction(() => {
    const probe = Reflect.get(window, "__AGI_PROJECT__");
    return probe?.getSession() != null;
  });
  await page.evaluate(() => Reflect.get(window, "releaseCheckpoint")());
  await expect(savedGameCard(page, title)).toBeVisible();
});
