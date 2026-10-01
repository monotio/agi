import { expect, test } from "@playwright/test";
import { buildSyntheticGame } from "../../src/games/syntheticGame.ts";
import { KNOWN_GAME_HASH } from "../../test/fixtures.ts";
import { BrowserReplay } from "./speedrunReplay.ts";

test("replay selects the named fixture after discovery when a copy shares its vocabulary", async ({
  page,
}) => {
  const game = buildSyntheticGame();
  const copiedFolder = "fixture-copy-synthetic";
  const originalVolumeLength = game.files["VOL.0"]!.length;
  const copiedVolume = new Uint8Array(originalVolumeLength + 1);
  copiedVolume.set(game.files["VOL.0"]!);
  copiedVolume[originalVolumeLength] = 0x42;
  await page.addInitScript(() => {
    const bootVolumes: number[] = [];
    Object.defineProperty(window, "__fixtureBootVolumes", { value: bootVolumes });
    const originalPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: unknown[]): void {
      const message = args[0] as { type?: string; files?: Record<string, Uint8Array> };
      if (message?.type === "boot") bootVolumes.push(message.files?.["VOL.0"]?.length ?? -1);
      Reflect.apply(originalPost, this, args);
    };
  });
  await page.route("**/fixtures/", async (route) => {
    // Discovery lands after the helper has started resolving its boot control.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      json: [
        {
          folder: copiedFolder,
          alias: copiedFolder,
          hash: KNOWN_GAME_HASH.SYNTHETIC,
          title: "Synthetic copy",
        },
        {
          folder: "synthetic",
          alias: "synthetic",
          hash: KNOWN_GAME_HASH.SYNTHETIC,
          title: "Synthetic original",
        },
      ],
    });
  });
  await page.route(`**/fixtures/${copiedFolder}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!name) await route.fulfill({ json: Object.keys(game.files) });
    else {
      const bytes = name === "VOL.0" ? copiedVolume : game.files[name];
      if (!bytes) throw new Error(`Unexpected fixture request: ${name}`);
      await route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream" });
    }
  });
  const replay = new BrowserReplay(page, false);
  await replay.boot(KNOWN_GAME_HASH.SYNTHETIC, 1);
  const bootVolumes = await page.evaluate(
    () => Reflect.get(window, "__fixtureBootVolumes") as number[],
  );
  expect(
    bootVolumes,
    "the physical game worker boots the named original fixture's exact volume",
  ).toEqual([originalVolumeLength]);
  expect((await replay.read()).tick).toBe(0);
});
