import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { fatDisk } from "../../test/disk-images.ts";
import { isolateStorage, savedGameCard, textHook } from "./engineProbe.ts";
import { expect, test } from "./test.ts";
import type { Page } from "@playwright/test";

function gameDisks(): Uint8Array[] {
  const game = createContainer();
  const logic = (source: string) => assembleLogic(source, { dictionary: new Map() }).payload;
  game.putResource("logic", 0, logic("if (v0 == 0) { new.room(1); } call(1); return;"));
  game.putResource(
    "logic",
    1,
    logic('display(5, 2, "A disk adventure."); accept.input(); return;'),
  );
  game.putFile("WORDS.TOK", new Uint8Array(52));
  game.files.get("PICDIR")!.set([0x20, 0, 0], 0);
  return [
    fatDisk(game.files),
    fatDisk(new Map([["VOL.2", new Uint8Array([0x12, 0x34, 2, 1, 0, 255])]])),
  ];
}
async function drop(page: Page, disks: Uint8Array[]): Promise<void> {
  await page.evaluate(
    (images) => {
      const transfer = new DataTransfer();
      images.forEach((bytes, index) =>
        transfer.items.add(new File([new Uint8Array(bytes)], `adventure${index + 1}.img`)),
      );
      document
        .querySelector("#your-games")!
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
    },
    disks.map((bytes) => [...bytes]),
  );
}
for (const size of [
  { width: 1063, height: 815 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`disk drop and Add game at ${size.width}`, async ({ page }) => {
    await isolateStorage(page);
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Add game", exact: true })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`library-${size.width}.png`),
      fullPage: true,
    });
    const disks = gameDisks();
    await drop(page, [disks[0]!]);
    const error = page.getByTestId("game-zip-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(
      "VOL.2 is on another disk. Add all the game's disks together.",
    );
    await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`missing-${size.width}.png`),
      fullPage: true,
    });
    await drop(page, disks);
    const card = savedGameCard(page, "adventure1");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("game-import-ready")).toBeVisible();
    await expect(page.getByTestId("game-import-ready")).toContainText(
      "adventure1 added to your library",
    );
    await page.getByRole("button", { name: "Add game", exact: true }).click();
    await expect(page.getByTestId("open-game-disks")).toBeVisible();
    await page.getByTestId("open-game-disks").click();
    await page.getByTestId("game-disk-input").setInputFiles(
      disks.map((bytes, index) => ({
        name: `adventure${index + 1}.img`,
        mimeType: "application/octet-stream",
        buffer: Buffer.from(bytes),
      })),
    );
    await expect(page.getByTestId("game-import-ready")).toBeVisible();
    await expect(page.getByTestId("game-import-ready")).toContainText(
      "adventure1 added to your library",
    );
    await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(1);
    await page.screenshot({
      path: test.info().outputPath(`added-${size.width}.png`),
      fullPage: true,
    });
    await card.getByTestId("btn-resume-cached").click();
    await expect
      .poll(async () => (await textHook(page)).rows.join(" "))
      .toContain("A disk adventure.");
  });
}

test("disk selection rejects two images with the same filename", async ({ page }) => {
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-disk-input").setInputFiles(
    gameDisks().map((bytes) => ({
      name: "disk.img",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(bytes),
    })),
  );
  const error = page.getByTestId("game-zip-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("Two files have the same filename");
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
});

test("ignored disk files exhaust one shared import budget @webkit-desktop", async ({ page }) => {
  const emptyFiles = new Map(
    Array.from({ length: 100 }, (_, index) => [`J${index}.TXT`, new Uint8Array()]),
  );
  const image = fatDisk(emptyFiles);
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("game-disk-input").setInputFiles(
    Array.from({ length: 11 }, (_, index) => ({
      name: `junk${index}.img`,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(image),
    })),
  );
  const error = page.getByTestId("game-zip-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("The disks have too many files. Add one game at a time.");
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(0);
  // A refused import leaves Home usable and accepts a valid game afterward.
  await drop(page, gameDisks());
  await expect(savedGameCard(page, "adventure1")).toBeVisible();
});
