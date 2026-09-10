import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/zip.ts";
import {
  configureAi,
  isolateStorage,
  openSavedGameDetails,
  openLibraryActions,
  savedGameCard,
  storedAutosave,
  textHook,
  waitForCycles,
} from "./engineProbe.ts";
import { providerReply } from "../../test/provider-stream.ts";
import { TUTORIAL_LOGIC_SOURCES } from "../../games/adventure-department/game.ts";

function tinyGame(message = "A library adventure."): {
  files: { name: string; data: Uint8Array }[];
  zip: Buffer;
} {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic(`assignn(v0, 1); display(5, 4, "${message}"); accept.input(); return;`, {
      dictionary: new Map(),
    }).payload,
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  const files = [...game.files].map(([name, data]) => ({ name, data }));
  return { files, zip: Buffer.from(buildZip(files)) };
}

/** A one-room game that draws a picture, which is what an autosave snapshot needs. */
function roomGame(): Buffer {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("assignn(v10,1);if(equaln(v0,0)){new.room(1);}call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      "if(isset(f5)){assignn(v60,1);load.pic(v60);draw.pic(v60);show.pic();accept.input();}return;",
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putFile("WORDS.TOK", new Uint8Array(52));
  return Buffer.from(buildZip([...game.files].map(([name, data]) => ({ name, data }))));
}

test("ZIP import is checked and staged before Play, with a stable duplicate", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const { zip } = tinyGame();
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "library.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  const card = savedGameCard(page, "library");
  await expect(card.getByTestId("btn-resume-cached")).toBeEnabled();
  await expect(card.getByTestId("library-thumbnail")).toHaveAttribute("src", /^data:image\/png/);
  await expect(page.getByTestId("input-line")).toBeHidden();
  const firstGameId = await card.getAttribute("data-game-id");
  expect(firstGameId).toBeTruthy();
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "renamed.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  await expect(page.getByTestId("game-import-ready")).toContainText("added to your library");
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(1);
  await expect(card).toHaveAttribute("data-game-id", firstGameId!);
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
});

test("a selected folder is checked, deduplicated with its ZIP, and can be copied independently", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const { files, zip } = tinyGame("Folder adventure.");
  const root = await mkdtemp(join(tmpdir(), "agi-library-"));
  const folder = join(root, "Folder Adventure");
  try {
    await mkdir(folder);
    await Promise.all(files.map(({ name, data }) => writeFile(join(folder, name), data)));
    await page.getByTestId("game-folder-input").setInputFiles(folder);
    const original = savedGameCard(page, "Folder Adventure");
    await expect(original.getByTestId("btn-resume-cached")).toBeEnabled();
    await page.getByTestId("game-zip-input").setInputFiles({
      name: "same-resources.zip",
      mimeType: "application/zip",
      buffer: zip,
    });
    await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(1);
    await openSavedGameDetails(original);
    await openLibraryActions(page, original);
    await page.getByTestId("copy-library-game").click();
    await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(2);
    await expect(savedGameCard(page, "Folder Adventure Remix")).toBeVisible();
    await expect(original).not.toContainText("Folder Adventure Remix");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("bad input fails before Play without mutating the library", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "broken.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("broken"),
  });
  await expect(page.getByTestId("game-zip-error")).toContainText("valid game ZIP");
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
});

test("index recovery preserves a game saved while another entry is being reconciled", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const retained = await page.evaluate(
    async (entries) => {
      const storage = await import("/src/gameStorage.ts");
      const files = Object.fromEntries(
        entries.map(({ name, bytes }) => [name, new Uint8Array(bytes)]),
      );
      const data = {
        title: "Before recovery",
        provider: "stub",
        model: "local-playback",
        files,
        words: [],
      };
      if (!(await storage.saveAuthoredGame("before-recovery", data)))
        throw new Error("Initial save failed");
      const completion = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete")!;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
        configurable: true,
        get: completion.get!,
        set(handler) {
          const hold = first;
          first = false;
          completion.set!.call(this, function (this: IDBTransaction, event: Event) {
            if (hold) {
              enter();
              void gate.then(() => handler.call(this, event));
            } else handler.call(this, event);
          });
        },
      });
      try {
        const recovery = storage.reconcileGameIndex();
        await entered;
        if (
          !(await storage.saveAuthoredGame("during-recovery", {
            ...data,
            title: "New arrival",
          }))
        )
          throw new Error("Concurrent save failed");
        release();
        await recovery;
        return storage
          .listCachedGames()
          .map(({ gameId }) => gameId)
          .sort();
      } finally {
        release();
        Object.defineProperty(IDBTransaction.prototype, "oncomplete", completion);
      }
    },
    tinyGame().files.map(({ name, data }) => ({ name, bytes: [...data] })),
  );
  expect(retained).toEqual(["before-recovery", "during-recovery"]);
});

test("a vanished saved game fails locally without contacting a provider", async ({ page }) => {
  let providerCalls = 0;
  await page.route("**/api/**", (route) => {
    providerCalls++;
    return route.abort();
  });
  await isolateStorage(page);
  await page.goto("/");
  const { zip } = tinyGame();
  await page.getByTestId("game-zip-input").setInputFiles({
    name: "vanishing.zip",
    mimeType: "application/zip",
    buffer: zip,
  });
  const card = savedGameCard(page, "vanishing");
  await expect(card.getByTestId("btn-resume-cached")).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith("monotio_agi.authored."));
    if (key) localStorage.removeItem(key);
  });
  await card.getByTestId("btn-resume-cached").click();
  await expect(page.getByTestId("error-panel")).toContainText("no longer available");
  expect(providerCalls).toBe(0);
});

test("the offline tutorial has a generated thumbnail and fits a phone", async ({ page }) => {
  let providerCalls = 0;
  await page.route("**/api/**", (route) => {
    providerCalls++;
    return route.abort();
  });
  await isolateStorage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const card = page.getByTestId("catalog-adventure-department");
  await expect(card).toBeVisible();
  await expect(card.getByRole("img")).toHaveAttribute("src", /^data:image\/png/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("game-library-phone.png"), fullPage: true });
  await page.getByTestId("catalog-play-adventure-department").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect.poll(async () => (await textHook(page)).cycle).toBeGreaterThan(5);
  await expect.poll(async () => (await textHook(page)).rows.join(" ")).toContain("HELP");
  await expect(page.getByTestId("resume-caption")).toHaveCount(0);
  expect(providerCalls).toBe(0);
});

test("the first catalog edit forks a remix and preserves the original", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  const card = page.getByTestId("catalog-adventure-department");
  await expect(card.getByRole("button", { name: "Play now" })).toBeEnabled();
  await card.getByRole("button", { name: "Play now" }).click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const before = await page.evaluate(async () => {
    const storage = await import("/src/gameStorage.ts");
    const metadata = await import("/src/gameMetadata.ts");
    const original = storage.listCachedGames().find((game) => game.library?.source === "catalog")!;
    const data = await storage.loadAuthoredGame(original.gameId);
    return {
      gameId: original.library!.gameId,
      revision: original.library!.revision,
      actualRevision: await metadata.gameRevision(data!.files),
    };
  });
  const patched = TUTORIAL_LOGIC_SOURCES[1]!.replace(
    "ADVENTURE DEPARTMENT: PICTURE GALLERY",
    "ADVENTURE DEPARTMENT: REMIX GALLERY",
  );
  let requests = 0;
  await page.route("**/api/openai/v1/responses", async (route) => {
    requests++;
    await route.fulfill(
      providerReply("openai", {
        id: `catalog-remix-${requests}`,
        output:
          requests === 1
            ? [
                {
                  type: "function_call",
                  id: "patch",
                  call_id: "patch",
                  name: "write_logic_source",
                  arguments: JSON.stringify({ room: 1, source: patched }),
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "The gallery is remixed." }],
                },
              ],
      }),
    );
  });
  await page.getByTestId("power-up").click();
  await configureAi(page, { provider: "openai", key: "test-placeholder" });
  await page.getByTestId("agent-bubble-input").fill("Rename the picture gallery");
  await page.getByTestId("agent-bubble-send").click();
  await expect(page.getByTestId("agent-bubble")).toBeHidden();
  await expect.poll(() => requests).toBe(2);
  const after = await page.evaluate(async (originalGameId) => {
    const storage = await import("/src/gameStorage.ts");
    const metadata = await import("/src/gameMetadata.ts");
    const games = storage.listCachedGames();
    const original = games.find((game) => game.gameId === originalGameId)!;
    const remix = games.find((game) => game.library?.source === "remix")!;
    const originalData = await storage.loadAuthoredGame(original.gameId);
    return {
      count: games.length,
      originalRevision: original.library!.revision,
      originalActualRevision: await metadata.gameRevision(originalData!.files),
      remixGameId: remix.gameId,
      remixSource: remix.library!.source,
      parent: remix.library!.parent,
      currentGameId: localStorage.getItem("monotio_agi.lastGame"),
    };
  }, before.gameId);
  expect(after.count).toBe(2);
  expect(after.originalRevision).toBe(before.revision);
  expect(after.originalActualRevision).toBe(before.actualRevision);
  expect(after.remixSource).toBe("remix");
  expect(after.parent).toEqual({ gameId: before.gameId, revision: before.revision });
  expect(after.currentGameId).toBe(after.remixGameId);
});

test("removing a game forgets its progress, so the same bytes come back fresh", async ({
  page,
}) => {
  await isolateStorage(page);
  await page.goto("/");
  const upload = { name: "forgettable.zip", mimeType: "application/zip", buffer: roomGame() };
  await page.getByTestId("game-zip-input").setInputFiles(upload);
  const card = savedGameCard(page, "forgettable");
  const gameId = (await card.getAttribute("data-game-id"))!;
  expect(gameId).toMatch(/^imported-[a-f0-9]{64}$/);
  await card.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await waitForCycles(page, 4);
  // Leaving flushes a checkpoint; the card must offer it before the game is removed.
  await page.getByTestId("btn-eject").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect.poll(() => storedAutosave(page, gameId)).not.toBeNull();
  await expect(card.getByTestId("btn-resume-cached")).toHaveText("Resume");

  await openLibraryActions(page, card);
  await page.getByTestId("remove-library-game").click();
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
  await expect(page.getByTestId("autosave-panel")).toHaveCount(0);
  await expect(page.getByText("IN PROGRESS", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("btn-resume-autosave")).toHaveCount(0);
  expect(
    await page.evaluate(
      (s) =>
        Object.keys(localStorage).filter(
          (key) =>
            (key.startsWith("monotio_agi.autosave.") || key.startsWith("monotio_agi.saves.")) &&
            key.includes(s),
        ),
      gameId,
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("monotio_agi.lastGame"))).toBeNull();

  await page.getByTestId("game-zip-input").setInputFiles(upload);
  const readded = savedGameCard(page, "forgettable");
  await expect(readded).toHaveAttribute("data-game-id", gameId);
  await expect(readded.getByTestId("btn-resume-cached")).toHaveText("Play");
  await expect(readded.getByText("IN PROGRESS", { exact: true })).toHaveCount(0);
});
