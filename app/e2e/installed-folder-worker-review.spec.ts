import { expect, test } from "./test.ts";
import { buildSyntheticGame } from "../../src/games/syntheticGame.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { isolateStorage, textHook } from "./engineProbe.ts";

/** Case-sensitive installations are simulated by the fixture transport on every host. */
test("an exact folder choice boots its own complete files @webkit-desktop", async ({ page }) => {
  const game = buildSyntheticGame();
  const original = game.files;
  const extra = new Uint8Array(original["VOL.0"]!.length + 1);
  extra.set(original["VOL.0"]!);
  extra[extra.length - 1] = 0x42;
  const other: Record<string, Uint8Array> = { ...original, "VOL.0": extra };
  const lowerRevision = await gameRevision(original);
  const upperRevision = await gameRevision(other);
  expect(upperRevision).not.toBe(lowerRevision);
  const served = [
    { folder: "Chamber", files: other, revision: upperRevision },
    { folder: "chamber", files: original, revision: lowerRevision },
  ];
  await page.addInitScript(() => {
    const captured: Record<string, number[]>[] = [];
    Object.defineProperty(window, "__installedBootFiles", { value: captured });
    const originalPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
      const message = args[0] as { type?: string; files?: Record<string, Uint8Array> };
      if (message?.type === "boot" && message.files)
        captured.push(
          Object.fromEntries(
            Object.entries(message.files).map(([name, bytes]) => [name, [...bytes]]),
          ),
        );
      Reflect.apply(originalPost, this, args);
    };
  });
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/")
      return route.fulfill({
        json: served.map(({ folder, revision }) => ({
          folder,
          alias: folder,
          hash: "a".repeat(64),
          title: folder,
          revision,
        })),
      });
    const match = /^\/fixtures\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
    const instance = match ? served.find(({ folder }) => folder === match[1]) : undefined;
    if (!instance) return route.fulfill({ status: 404 });
    const name = match![2];
    if (name === undefined) return route.fulfill({ json: Object.keys(instance.files) });
    const bytes = instance.files[name];
    return route.fulfill(
      bytes
        ? { body: Buffer.from(bytes), contentType: "application/octet-stream" }
        : { status: 404 },
    );
  });
  await isolateStorage(page);
  await page.goto("/");
  await page.getByTestId("boot-chamber").click();
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  const captured = await page.evaluate(
    () => Reflect.get(window, "__installedBootFiles") as Record<string, number[]>[],
  );
  expect(
    captured,
    "the physical game worker receives the selected folder's exact file set",
  ).toEqual([
    Object.fromEntries(Object.entries(original).map(([name, bytes]) => [name, [...bytes]])),
  ]);
});
