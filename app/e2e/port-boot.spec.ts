import { expect, test } from "@playwright/test";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import { fixtureSkip } from "../../test/fixtures.ts";
import { isolateStorage, openGameOptions, textHook } from "./engineProbe.ts";

/**
 * Browser-path proof that an Amiga or Apple IIgs edition boots under the
 * profile its own interpreter executable names — test/ports.test.ts covers
 * detection in Node, this covers the file set the app actually fetches. The
 * playable-file filter (isPlayableFileName in app/src/gameMetadata.ts) once
 * dropped the hunk/SYS16 executables; the edition still resolved to the same
 * catalogued profile, but with "catalog" evidence instead of "binary", so
 * the kind is the assertion that catches that regression. The gallery card is
 * selected by data-alias only: a port shares its WORDS.TOK hash with the PC
 * edition, so data-hash is ambiguous.
 */
const PORTS: readonly { alias: string; executable: string; chip: string }[] = [
  { alias: "sq1-amiga", executable: "Sierra", chip: "Amiga Paula" },
  { alias: "kq2-amiga", executable: "KQ2", chip: "Amiga Paula" },
  { alias: "sq2-amiga", executable: "SQ2", chip: "Amiga Paula" },
  { alias: "pq1-amiga", executable: "PQ", chip: "Amiga Paula" },
  { alias: "goldrush-amiga", executable: "GR", chip: "Amiga Paula" },
  { alias: "mh2-amiga", executable: "MH2", chip: "Amiga Paula" },
  { alias: "sq2-iigs", executable: "SQ2.SYS16", chip: "Apple IIgs Ensoniq" },
];

for (const port of PORTS) {
  const known = getKnownGameByAlias(port.alias);
  if (!known) throw new Error(`catalog is missing the ${port.alias} entry`);
  // The ports ship no AGIDATA.OVL; their own interpreter executable is the
  // required file. mh2-amiga's dirs reference a VOL.15 the release never
  // shipped, so volume readiness is "shipped" here as in test/ports.test.ts.
  const missing = fixtureSkip(port.alias, [port.executable], { checkVolumes: "shipped" });
  test(`${port.alias}: gallery boot runs ${known.profile} on the executable's evidence`, async ({
    page,
  }) => {
    test.skip(Boolean(missing), missing || "");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await isolateStorage(page);
    await page.goto("/?replaySeed=1");
    await page.locator(`[data-alias="${port.alias}"]`).press("Enter");

    // The catalogued (WORDS.TOK, OBJECT) pair yields the same profile id
    // without the executable, so the detection kind — not the id — proves
    // the binary itself reached the worker.
    await expect
      .poll(async () => (await textHook(page)).profile, { timeout: 30_000 })
      .toBe(known.profile);
    expect((await textHook(page)).profileKind).toBe("binary");

    await page.evaluate(() => window.__AGI_REPLAY__!.advance(1));
    await expect.poll(async () => (await textHook(page)).frame).toBeGreaterThan(0);

    // Settings > Advanced names the platform's own chip, never a PC chip.
    await openGameOptions(page, "settings-menu");
    await page.getByTestId("settings-advanced").click();
    await expect(page.getByTestId("toggle-sound-mode").locator("small")).toHaveText(port.chip);

    expect(errors).toEqual([]);
  });
}
