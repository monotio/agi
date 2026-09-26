import { expect, test } from "@playwright/test";
import { testProjectId } from "../test/identity.ts";
import {
  cacheGame,
  openLibraryActions,
  isolateStorage,
  openSavedGameDetails,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";

import { buildTutorial } from "../../games/adventure-department/game.ts";

test.beforeEach(async ({ page }) => {
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
});

interface SaveObservation {
  image: string;
  preview?: string;
  room: number;
  cycle: number;
  frame: { visual: number[]; text: number[]; picRow: number } | null;
}

test("a first visit leads with tutorial and creation while keeping import available", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("catalog-play-adventure-department")).toBeVisible();
  await expect(page.getByTestId("hero-primary")).toHaveText("Play the tutorial");
  await expect(page.getByTestId("create-adventure-toggle")).toBeVisible();
  // One shelf holds the tutorial and the ways to create; nothing is saved yet.
  await expect(page.getByRole("heading", { name: "Your games", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Your games", exact: true })).toHaveCount(0);
  const gallery = page.getByTestId("saved-game-gallery");
  await expect(gallery.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
  await expect(gallery.getByTestId("catalog-adventure-department")).toBeVisible();
  const create = page.getByTestId("create-adventure-disclosure");
  await expect(create).not.toHaveAttribute("open");
  await gallery.getByTestId("shelf-template-custom").click();
  await expect(create).toHaveAttribute("open");
  await expect(page.getByTestId("template-custom")).toHaveAttribute("aria-pressed", "true");
  expect(
    await create.evaluate((element) => {
      const importer = document.getElementById("open-game")!;
      return Boolean(element.compareDocumentPosition(importer) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  await page.getByRole("button", { name: "Add game", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /ZIP/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /folder/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("boot-agent")).toBeHidden();
  await page.getByTestId("agent-panel").getByText("Developer activity", { exact: true }).click();
  await expect(page.getByTestId("boot-agent")).toBeVisible();
  await page.getByTestId("agent-panel").getByText("Developer activity", { exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: test.info().outputPath(`first-visit-${width}.png`),
      fullPage: true,
    });
  }
});

test("Create is a focused panel that its hash reopens and Close, Escape or Back dismiss", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const create = page.getByTestId("create-adventure-disclosure");
  const toggle = page.getByTestId("create-adventure-toggle");
  await expect(create).not.toHaveAttribute("open");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(create).toHaveAttribute("open");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "Create an adventure" })).toBeFocused();
  await expect(page).toHaveURL(/#create-adventure$/);
  await page.reload();
  await expect(create).toHaveAttribute("open");
  await page.getByTestId("create-adventure-close").click();
  await expect(create).not.toHaveAttribute("open");
  expect(new URL(page.url()).hash).toBe("");
  await page.reload();
  await expect(create).not.toHaveAttribute("open");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(create).toHaveAttribute("open");
  await page.keyboard.press("Escape");
  await expect(create).not.toHaveAttribute("open");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(create).toHaveAttribute("open");
  await page.goBack();
  await expect(create).not.toHaveAttribute("open");
});

test("Resume shows the same saved scene and position, including after reopening the app", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.addInitScript(() => {
    const target = window as Window & { menuSaveObservation?: SaveObservation };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        let frame: SaveObservation["frame"] = null;
        this.addEventListener("message", ({ data }: MessageEvent) => {
          if (data.type === "frame") {
            frame = { visual: [...data.visual], text: [...data.text], picRow: data.picRow };
          }
          if (data.type === "autosave") {
            target.menuSaveObservation = {
              image: data.image,
              preview: data.preview,
              room: data.room,
              cycle: data.cycle,
              frame,
            };
          }
        });
      }
    };
  });
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("input-line").fill("east");
  await page.getByTestId("input-line").press("Enter");
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  const spawnX = (await textHook(page)).egoX;
  await page.getByTestId("input-line").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();

  const saved = await page.evaluate(async () => {
    const projectId = localStorage.getItem("monotio_agi.lastGame")!;
    const record = JSON.parse(localStorage.getItem(`monotio_agi.autosave.${projectId}`)!);
    const observed = (window as Window & { menuSaveObservation?: SaveObservation })
      .menuSaveObservation;
    if (!observed) throw new Error("No save observation was installed");
    if (!record.preview) throw new Error("The saved progress has no screenshot");
    if (!observed.frame) throw new Error("No frame accompanied the save observation");
    const { compositeFrame } = await import("/src/composite.ts");
    const rgba = new Uint8ClampedArray(320 * 200 * 4);
    compositeFrame(
      {
        visual: new Uint8Array(observed.frame.visual),
        text: new Uint8Array(observed.frame.text),
        picRow: observed.frame.picRow,
      },
      rgba,
    );
    const image = new Image();
    image.src = record.preview;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let differences = 0;
    for (let index = 0; index < rgba.length; index++) {
      if (index % 4 !== 3 && rgba[index] !== actual[index]) differences++;
    }
    return {
      projectId,
      preview: record.preview,
      room: record.room,
      matchingSave:
        record.image === observed.image &&
        record.cycle === observed.cycle &&
        record.preview === observed.preview,
      width: canvas.width,
      height: canvas.height,
      differences,
    };
  });
  expect(saved.room).toBe(2);
  expect(saved.matchingSave).toBe(true);
  expect([saved.width, saved.height]).toEqual([320, 200]);
  expect(saved.differences, "preview must match the composed frame of its own save").toBe(0);
  // The tutorial's stored copy is the tutorial's own card.
  expect(saved.projectId).toBe("catalog-adventure-department-1.0.0");
  const card = page.getByTestId("catalog-adventure-department");
  await expect(card).toHaveAttribute("data-project-id", saved.projectId);
  expect(
    (await card.boundingBox())!.width,
    "a single game keeps a readable card size",
  ).toBeLessThanOrEqual(512);
  await expect(card.getByTestId("library-thumbnail")).toHaveAttribute("src", saved.preview);
  await expect(card.getByTestId("library-thumbnail")).toHaveAttribute(
    "data-preview-kind",
    "progress",
  );
  await expect(card).toContainText("Room 2");
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(page.getByTestId("autosave-panel")).toHaveCount(0);
  await expect(page.getByTestId("saved-world-select")).toHaveCount(0);
  await expect(page.locator(".saved-game-strip")).toHaveCount(0);
  await card.screenshot({ path: test.info().outputPath("saved-progress.png") });

  // The reload happened from the menu, so the app stays on the menu and offers Resume.
  await page.reload();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.getByTestId("resume-caption")).toBeVisible();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
  expect((await textHook(page)).egoX).toBeGreaterThan(spawnX + 12);
  await page.getByTestId("btn-exit").click();
  await expect(card.getByTestId("library-thumbnail")).toHaveAttribute(
    "data-preview-kind",
    "progress",
  );
  await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(2);
});

test("one roomy library reflows across desktop, tablet and phone with accessible section navigation", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.evaluate(async () => {
    const { GAME_CATALOG } = await import("/src/gameCatalog.ts");
    const { previewGame } = await import("/src/gamePreview.ts");
    const { addLibraryGame, copyLibraryGame } = await import("/src/gameLibrary.ts");
    const { renameAuthoredGame } = await import("/src/gameStorage.ts");
    const entry = GAME_CATALOG[0]!;
    const game = await entry.load();
    const opening = await previewGame(game);
    const projectId = await addLibraryGame(game, game.title!, "catalog", opening, {
      id: entry.id,
      version: entry.version,
    });
    for (const title of [
      "The Clockmaker and the Exceptionally Long Afternoon",
      "A Small Adventure",
    ]) {
      const copy = await copyLibraryGame(projectId);
      await renameAuthoredGame(copy, title);
    }
  });
  await page.reload();
  const gallery = page.getByTestId("saved-game-gallery");
  const cards = gallery.locator("[data-project-id]");
  const create = page.getByTestId("create-adventure-disclosure");
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("saved-world-select")).toHaveCount(0);
  await expect(page.locator(".saved-game-strip")).toHaveCount(0);
  await expect(create).not.toHaveAttribute("open");
  await expect(page.getByTestId("template-custom")).toBeHidden();
  const typography = (element: Element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
  };
  expect(await cards.nth(1).getByTestId("btn-resume-cached").evaluate(typography)).toEqual(
    await page.getByTestId("connect-create-ai").evaluate(typography),
  );

  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await gallery.scrollIntoViewIfNeeded();
    const bounds = await gallery.boundingBox();
    const panel = await page.locator("#your-games").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        contentWidth:
          element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      };
    });
    expect(panel.width).toBeGreaterThan(Math.min(960, width - 60));
    expect(Math.abs(bounds!.width - panel.contentWidth)).toBeLessThan(2);
    expect(Math.abs(bounds!.x - (width - bounds!.x - bounds!.width))).toBeLessThan(4);
    // About five across on a desktop, two on a phone.
    const boxes = await gallery.locator(":scope > *").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width };
      }),
    );
    const columns = { 1440: 5, 1024: 5, 768: 3, 390: 2 }[width];
    expect(new Set(boxes.map((box) => Math.round(box.x))).size, `${width}px columns`).toBe(columns);
    expect(boxes.every((box) => box.width >= 150)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath(`library-${width}.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  const toggle = page.getByTestId("create-adventure-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(create).toHaveAttribute("open");
  await expect(page.getByTestId("template-custom")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).not.toHaveAttribute("open");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(create).toHaveAttribute("open");
  await page.screenshot({ path: test.info().outputPath("creation-expanded.png"), fullPage: true });
});

test("a checkpoint cannot resume against changed game resources and remains recoverable", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  const originalProjectId = await page.evaluate(() =>
    localStorage.getItem("monotio_agi.lastGame")!,
  );
  const copy = await page.evaluate(async () => {
    const path = "/src/gameLibrary.ts";
    const { copyLibraryGame } = await import(path);
    return copyLibraryGame(localStorage.getItem("monotio_agi.lastGame")!);
  });
  // The reload happened from the menu, so the app stays on the menu; resume the original.
  await page.reload();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  // The original is the tutorial's stored copy, shown on the tutorial's card.
  const tutorial = page.getByTestId("catalog-adventure-department");
  await expect(tutorial).toHaveAttribute("data-project-id", originalProjectId);
  await tutorial.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await page
    .getByTestId(`saved-game-card-${copy}`)
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  const checkpoint = await page.evaluate(async () => {
    const path = "/src/gameStorage.ts";
    const storage = await import(path);
    const projectId = localStorage.getItem("monotio_agi.lastGame")!;
    const key = `monotio_agi.autosave.${projectId}`;
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("No checkpoint was stored before returning to the menu");
    const cached = await storage.loadAuthoredGame(projectId);
    const original = Object.fromEntries(
      Object.entries(cached.files as Record<string, Uint8Array>).map(([name, bytes]) => [
        name,
        [...bytes],
      ]),
    );
    const changed = {
      ...cached.files,
      "AGIDATA.OVL": new TextEncoder().encode("release-check 2.936"),
    };
    if (!(await storage.updateAuthoredGameFiles(projectId, changed)))
      throw new Error("Fixture update failed");
    return { projectId, key, raw, original };
  });
  await page.reload();
  // The reload happened from the menu, so the app stays on the menu; the card's Resume runs the checkpoint validation.
  await page
    .getByTestId(`saved-game-card-${checkpoint.projectId}`)
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect(page.getByTestId("error-panel")).toContainText("different revision");
  expect(
    await page.evaluate(({ key, raw }) => localStorage.getItem(key) === raw, checkpoint),
    "Rejected resume preserves the checkpoint bytes",
  ).toBe(true);
  await page.evaluate(async ({ projectId, original }) => {
    const path = "/src/gameStorage.ts";
    const storage = await import(path);
    await storage.updateAuthoredGameFiles(
      projectId,
      Object.fromEntries(
        Object.entries(original).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
      ),
    );
  }, checkpoint);
  await page.reload();
  await page
    .getByTestId(`saved-game-card-${checkpoint.projectId}`)
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

test("the tutorial is one card that carries its progress, ahead of equal-height copies", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
  // One card per game: the tutorial's stored copy is the tutorial card, with its progress.
  const original = savedGameCard(page, "Adventure Department");
  await expect(original).toHaveAttribute("data-testid", "catalog-adventure-department");
  await expect(
    page.getByTestId("saved-game-title").filter({ hasText: /^Adventure Department$/ }),
  ).toHaveCount(1);
  await expect(original.getByTestId("library-thumbnail")).toHaveAttribute(
    "data-preview-kind",
    "progress",
  );
  await expect(original).toContainText(/Room 1 · played/);
  await expect(original.getByTestId("catalog-play-adventure-department")).toHaveText("Resume");
  await openLibraryActions(page, original);
  await page.getByTestId("copy-library-game").click();
  const remix = savedGameCard(page, "Adventure Department Remix");
  await expect(remix).toBeVisible();
  await expect(remix).toHaveAttribute("data-testid", /^saved-game-card-/);
  // Cards in a row share one height, and reading details never changes it.
  const height = (await original.boundingBox())!.height;
  expect((await remix.boundingBox())!.height).toBe(height);
  const details = await openSavedGameDetails(original);
  await expect(details).toContainText("Learn pictures, sprites and priority");
  await page.keyboard.press("Escape");
  expect((await original.boundingBox())!.height).toBe(height);
  expect((await remix.boundingBox())!.height).toBe(height);
  const shelf = page.getByTestId("saved-game-gallery").locator(":scope > *");
  await expect(shelf.first()).toHaveAttribute("data-testid", "catalog-adventure-department");
  await expect(shelf.first()).toContainText("Tutorial");
  await expect(shelf.last().getByTestId("shelf-template-custom")).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: test.info().outputPath(`returning-library-${width}.png`),
      fullPage: true,
    });
  }
  // The reload happened from the menu, so the app stays on the menu with the same shelf.
  await page.reload();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect(shelf.first()).toHaveAttribute("data-testid", "catalog-adventure-department");
});

test("local folders and saved projects share one gallery and local progress resumes on its card", async ({
  page,
}) => {
  await isolateStorage(page);
  const game = buildTutorial();
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/") return route.fulfill({ json: ["sample"] });
    if (path === "/fixtures/sample/") return route.fulfill({ json: Object.keys(game.files) });
    const bytes = game.files[path.split("/").at(-1)!];
    return bytes ? route.fulfill({ body: Buffer.from(bytes) }) : route.fulfill({ status: 404 });
  });
  await page.goto("/");
  await cacheGame(page, {
    projectId: testProjectId("my-project"),
    title: "My project",
    provider: "stub",
    model: "offline-stub",
    imported: true,
    files: game.files,
    words: game.words,
  });
  await page.reload();
  const gallery = page.getByTestId("saved-game-gallery");
  await expect(gallery.getByTestId("saved-game-card-my-project")).toBeVisible();
  const local = gallery.getByTestId("local-game-card-sample");
  await expect(local).toContainText("SAMPLE");
  await expect(page.getByTestId("installed-game-select")).toHaveCount(0);
  await expect(page.locator(".installed-picker")).toHaveCount(0);
  await local.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await page.getByTestId("btn-exit").click();
  await expect(local.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(local.getByTestId("library-thumbnail")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(page.getByTestId("autosave-panel")).toHaveCount(0);
  await local.getByRole("button", { name: "Resume", exact: true }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});
