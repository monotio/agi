import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, reviewShot, keepDetectedProfile, seeStudioTours } from "./test.ts";
import { blockProviders, prepareIsolatedPage } from "./logicDebugShared.ts";
import {
  openLibraryActions,
  openSavedGameDetails,
  savedGameCard,
  textHook,
} from "./engineProbe.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildZip } from "../src/archive/zip.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import type { GameIdentity } from "../../src/gameIdentity.ts";

/** Original test games with identical vocabulary and different native LOGIC. */
function nativeFiles(message: string): Record<string, Uint8Array> {
  const container = createContainer();
  container.putFile("WORDS.TOK", new Uint8Array(52));
  // Empty OBJECT: zero table offset and drawable limit, XOR "Avis Durgan".
  container.putFile("OBJECT", new Uint8Array([0x41, 0x76, 0x69]));
  container.putResource(
    "logic",
    0,
    assembleLogic("if (equaln(v0, 0)) { new.room(1); } call(1); return;", {
      dictionary: new Map(),
    }).payload,
  );
  container.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) { assignn(v60, 1); load.pic(v60); draw.pic(v60); show.pic(); accept.input(); } display(5, 2, "${message}"); return;`,
      { dictionary: new Map() },
    ).payload,
  );
  container.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  return Object.fromEntries(container.files);
}

function archiveFiles(
  files: Record<string, Uint8Array>,
  title: string,
  parent?: GameIdentity,
): { name: string; data: Uint8Array }[] {
  return [
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    {
      name: "GAME.JSON",
      data: new TextEncoder().encode(
        JSON.stringify({
          format: "monotio.agi",
          version: 1,
          title,
          profile: "2.936",
          ...(parent ? { metadata: { parent } } : {}),
        }),
      ),
    },
  ];
}

async function importZip(
  page: Page,
  files: Record<string, Uint8Array>,
  title: string,
  parent?: GameIdentity,
): Promise<string> {
  await page.getByTestId("game-zip-input").setInputFiles({
    name: `${title}.zip`,
    mimeType: "application/zip",
    buffer: Buffer.from(buildZip(archiveFiles(files, title, parent))),
  });
  const card = savedGameCard(page, title);
  await expect(card).toBeVisible();
  return (await card.getAttribute("data-project-id"))!;
}

/** Read the body's actual binding and its checkpoint, independently of card copy. */
async function storedProgress(page: Page, id: string) {
  return page.evaluate(
    async (project) => {
      const { requireProjectId } = await import("/@fs/" + project.identityModule);
      const { bindSavedProgressTarget } = await import("/src/project/progressBinding.ts");
      const { autosaveKey } = await import("/src/saves/gameProgress.ts");
      const target = await bindSavedProgressTarget(requireProjectId(project.id));
      if (target === null) throw new Error("The imported body has no live progress binding.");
      return { target, raw: localStorage.getItem(autosaveKey(target.locator)) };
    },
    { id, identityModule: new URL("../../src/gameIdentity.ts", import.meta.url).pathname },
  );
}

const ORIGINAL = nativeFiles("ORIGINAL ADVENTURE");
const ALTERED = nativeFiles("ALTERED ADVENTURE");
const ORIGINAL_REVISION = await gameRevision(ORIGINAL);
const ALTERED_REVISION = await gameRevision(ALTERED);

test("folder and ZIP games with the same vocabulary keep separate content and progress @webkit-desktop", async ({
  page,
}) => {
  expect(ORIGINAL["WORDS.TOK"]).toEqual(ALTERED["WORDS.TOK"]);
  expect(ORIGINAL_REVISION).not.toBe(ALTERED_REVISION);
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const folder = test.info().outputPath("original-folder");
  await mkdir(folder, { recursive: true });
  for (const { name, data } of archiveFiles(ORIGINAL, "Origin Adventure"))
    await writeFile(join(folder, name), data);
  await page.getByTestId("game-folder-input").setInputFiles(folder);
  const originalCard = savedGameCard(page, "Origin Adventure");
  await expect(originalCard).toBeVisible();
  const originalId = (await originalCard.getAttribute("data-project-id"))!;
  const alteredId = await importZip(page, ALTERED, "Altered Adventure");
  expect(alteredId).not.toBe(originalId);
  const beforeA = await storedProgress(page, originalId);
  const beforeB = await storedProgress(page, alteredId);
  expect(beforeA.target.identity.revision).toBe(ORIGINAL_REVISION);
  expect(beforeB.target.identity.revision).toBe(ALTERED_REVISION);
  expect(beforeA.target.locator).not.toBe(beforeB.target.locator);
  expect(beforeA.raw).toBeNull();
  expect(beforeB.raw).toBeNull();

  await originalCard.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("ORIGINAL ADVENTURE");
  await page.getByTestId("btn-exit").click();
  await expect(originalCard).toBeVisible();
  const savedA = await storedProgress(page, originalId);
  expect(savedA.raw).not.toBeNull();
  expect((await storedProgress(page, alteredId)).raw).toBeNull();
  await savedGameCard(page, "Altered Adventure")
    .getByRole("button", { name: "Play", exact: true })
    .click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("ALTERED ADVENTURE");
  await page.getByTestId("btn-exit").click();
  await expect(savedGameCard(page, "Altered Adventure")).toBeVisible();
  const savedB = await storedProgress(page, alteredId);
  expect(savedB.raw).not.toBeNull();
  expect(JSON.parse(savedB.raw!).game.identity).toEqual(savedB.target.identity);
  expect((await storedProgress(page, originalId)).raw).toBe(savedA.raw);
  await reviewShot(page, "identity-separate-imports");
  expect(providers.count()).toBe(0);
});

async function importDeclaredRemix(page: Page): Promise<GameIdentity> {
  const id = await importZip(page, ORIGINAL, "Origin Adventure");
  const parent = (await storedProgress(page, id)).target.identity;
  await importZip(page, ALTERED, "Altered Remix", parent);
  return parent;
}

test("a played remix exposes its origin in Details @webkit-desktop", async ({ page }) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  await importDeclaredRemix(page);
  const card = savedGameCard(page, "Altered Remix");
  await expect(card).toContainText("Remix of Origin Adventure");
  await card.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("ALTERED ADVENTURE");
  await page.getByTestId("btn-exit").click();
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  const dialog = await openSavedGameDetails(card);
  await expect(dialog).toContainText("Origin Adventure");
  await reviewShot(page, "identity-remix-after-play");
  expect(providers.count()).toBe(0);
});

test("a later source revision cannot rename a remix's historical origin @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const parent = await importDeclaredRemix(page);
  await page.evaluate(
    async ({ parent, files, revision }) => {
      const { requireProjectId } = await import("/@fs/" + parent.identityModule);
      const { loadAuthoredGame, saveAuthoredGame } = await import("/src/project/gameStorage.ts");
      const id = requireProjectId(parent.project);
      const data = await loadAuthoredGame(id);
      if (data === null || data.library === undefined)
        throw new Error("The source body disappeared.");
      const changed = await saveAuthoredGame(id, {
        ...data,
        title: "Later Origin Adventure",
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
        ),
        library: { ...data.library, revision },
      });
      if (!changed) throw new Error("The changed source body was not stored.");
    },
    {
      parent: {
        ...parent,
        identityModule: new URL("../../src/gameIdentity.ts", import.meta.url).pathname,
      },
      files: Object.fromEntries(Object.entries(ALTERED).map(([name, bytes]) => [name, [...bytes]])),
      revision: ALTERED_REVISION,
    },
  );
  await page.reload();
  const dialog = await openSavedGameDetails(savedGameCard(page, "Altered Remix"));
  await expect(dialog).toContainText(parent.project);
  await expect(dialog).not.toContainText("Later Origin Adventure");
  await reviewShot(page, "identity-remix-details");
  expect(providers.count()).toBe(0);
});

test("copies with identical content retain their immediate parent through real downloads and reimport @webkit-desktop", async ({
  page,
  browser,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const originalId = await importZip(page, ORIGINAL, "Origin Adventure");
  const original = (await storedProgress(page, originalId)).target;

  await openLibraryActions(page, savedGameCard(page, "Origin Adventure"));
  await page.getByTestId("copy-library-game").click();
  const firstCard = savedGameCard(page, "Origin Adventure Remix");
  await expect(firstCard).toBeVisible();
  const firstId = (await firstCard.getAttribute("data-project-id"))!;
  const first = (await storedProgress(page, firstId)).target;
  expect(first.identity.revision).toBe(original.identity.revision);
  expect(first.identity.project).not.toBe(original.identity.project);
  expect(first.locator).not.toBe(original.locator);
  await expect((await openSavedGameDetails(firstCard)).locator("dd").first()).toHaveText(
    "Origin Adventure",
  );
  await page.keyboard.press("Escape");

  await openLibraryActions(page, firstCard);
  await page.getByTestId("copy-library-game").click();
  const title = "Origin Adventure Remix Remix";
  const secondCard = savedGameCard(page, title);
  await expect(secondCard).toBeVisible();
  const secondId = (await secondCard.getAttribute("data-project-id"))!;
  const second = (await storedProgress(page, secondId)).target;
  expect(second.identity.revision).toBe(ORIGINAL_REVISION);
  expect(second.identity.project).not.toBe(first.identity.project);
  expect(second.locator).not.toBe(first.locator);
  await expect((await openSavedGameDetails(secondCard)).locator("dd").first()).toHaveText(
    "Origin Adventure Remix",
  );
  await page.keyboard.press("Escape");

  for (const kind of ["game", "project"] as const) {
    await openLibraryActions(page, secondCard);
    const pending = page.waitForEvent("download");
    await page
      .getByTestId(kind === "game" ? "export-library-game" : "download-library-game")
      .click();
    const download = await pending;
    const downloadedPath = test.info().outputPath(`identity-copy-${kind}.zip`);
    await download.saveAs(downloadedPath);
    const archive = new Uint8Array(await readFile(downloadedPath));
    const opened = await readGameZip(archive);
    expect(await gameRevision(opened.files)).toBe(ORIGINAL_REVISION);
    expect(opened.metadata?.parent).toEqual(first.identity);
    if (kind === "game") expect(opened.project).toBeUndefined();
    else expect(opened.project).toBeDefined();

    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await keepDetectedProfile(other);
      await seeStudioTours(other);
      await prepareIsolatedPage(other);
      const otherProviders = blockProviders(other);
      await other.goto("/");
      await other.getByTestId("game-zip-input").setInputFiles({
        name: download.suggestedFilename(),
        mimeType: "application/zip",
        buffer: Buffer.from(archive),
      });
      const importedCard = savedGameCard(other, title);
      await expect(importedCard).toBeVisible();
      const importedId = (await importedCard.getAttribute("data-project-id"))!;
      expect((await storedProgress(other, importedId)).target.identity.revision).toBe(
        ORIGINAL_REVISION,
      );
      // The parent is absent in this browser. Preserve its declared identity;
      // identical content in the child is not proof of a parent title.
      const details = await openSavedGameDetails(importedCard);
      await expect(details).toContainText(first.identity.project);
      await reviewShot(other, `identity-${kind}-reimport-ancestry`);
      expect(otherProviders.count()).toBe(0);
    } finally {
      await fresh.close();
    }
  }

  // Same-content copies also have independent progress, beyond byte identity.
  await firstCard.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "))
    .toContain("ORIGINAL ADVENTURE");
  await page.getByTestId("btn-exit").click();
  await expect(firstCard).toBeVisible();
  expect((await storedProgress(page, firstId)).raw).not.toBeNull();
  expect((await storedProgress(page, originalId)).raw).toBeNull();
  expect((await storedProgress(page, secondId)).raw).toBeNull();
  expect(providers.count()).toBe(0);
});
