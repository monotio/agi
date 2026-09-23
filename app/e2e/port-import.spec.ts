import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./test.ts";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import { fixtureSkip } from "../../test/fixtures.ts";
import { gameRevision } from "../src/gameMetadata.ts";
import { readGameZip } from "../src/gameZip.ts";
import { isolateStorage, openGameOptions, textHook } from "./engineProbe.ts";

/**
 * A port edition imported the way a player does it — their own ZIP, spelled
 * however the disk image spelled it — keeps its interpreter executable
 * through import, boot, Export game and re-import. The playable-file filter
 * once dropped the Amiga `GR` and IIgs `SQ2.SYS16` executables on import,
 * booting on "catalog" evidence; the same bytes under another spelling also
 * hashed to a different revision. An untouched original exports as the
 * bytes it was imported as, so the revision holds end to end.
 * port-boot.spec.ts covers the gallery path.
 */
const PORTS: readonly { alias: string; executable: string }[] = [
  { alias: "goldrush-amiga", executable: "GR" },
  { alias: "sq2-iigs", executable: "SQ2.SYS16" },
];

async function storedRevision(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const path = "/src/gameStorage.ts";
    const store = await import(path);
    return store.listCachedGames()[0]?.library?.revision;
  });
}

async function importAndBoot(page: Page, zip: string, profile: string): Promise<void> {
  await page.getByTestId("game-zip-input").setInputFiles(zip);
  await expect(page.locator("[data-testid^='saved-game-card-']")).toHaveCount(1);
  await page.getByTestId("btn-resume-cached").click();
  await expect.poll(async () => (await textHook(page)).profile, { timeout: 30_000 }).toBe(profile);
  expect((await textHook(page)).profileKind).toBe("binary");
}

for (const port of PORTS) {
  const known = getKnownGameByAlias(port.alias);
  if (!known) throw new Error(`catalog is missing the ${port.alias} entry`);
  const zip = join(import.meta.dirname, `../../games/${port.alias}.zip`);
  const missing = fixtureSkip(port.alias, [port.executable], { checkVolumes: "shipped" });
  test(`${port.alias}: an imported ZIP keeps its executable through export and re-import`, async ({
    page,
    browser,
  }) => {
    test.skip(Boolean(missing), missing || "");
    await isolateStorage(page);
    await page.goto("/?replaySeed=1");
    await importAndBoot(page, zip, known.profile);
    const original = await readGameZip(new Uint8Array(await readFile(zip)));
    const revision = await gameRevision(original.files);
    expect(await storedRevision(page)).toBe(revision);

    const pending = page.waitForEvent("download");
    await openGameOptions(page, "game-menu");
    await page.getByTestId("btn-export-game").click();
    const exported = (await (await pending).path())!;
    const game = await readGameZip(new Uint8Array(await readFile(exported)));
    expect(Object.keys(game.files)).toContain(port.executable);
    expect(await gameRevision(game.files)).toBe(revision);

    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await isolateStorage(other);
      await other.goto("/?replaySeed=1");
      await importAndBoot(other, exported, known.profile);
      expect(await storedRevision(other)).toBe(revision);
    } finally {
      await fresh.close();
    }
  });
}
