import { test, expect } from "./test.ts";
import { createHash } from "node:crypto";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { gameRevision } from "../src/project/gameMetadata.ts";
import { installedProgressLocator } from "../src/project/progressTarget.ts";
import type { Page } from "@playwright/test";
import { isolateStorage, textHook, waitForAutosaveAfter, waitForCycles } from "./engineProbe.ts";

/**
 * Progress runtime binding (B1), observed in a real browser: two installed
 * games share one WORDS.TOK fingerprint — family recognition, never
 * instance equality. Each card's boot binds the folder's own physical
 * progress target, so checkpoints land under `installed:<folder digest>:<revision>`
 * locators instead of the shared hash spelling, the resume pointer names
 * the exact instance that wrote it, and a reload resumes that instance's
 * own checkpoint picture.
 */

const WORDS = new Uint8Array(52);
const OBJECT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const WORDS_SHA = createHash("sha256").update(WORDS).digest("hex");
const OBJECT_SHA = createHash("sha256").update(OBJECT).digest("hex");

function installedGame(message: string): Record<string, Uint8Array> {
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
      `if(isset(f5)){assignn(v60,1);load.pic(v60);draw.pic(v60);show.pic();}display(5, 4, "${message}");accept.input();return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 1, new Uint8Array([0xf0, 1, 0xf8, 0, 0, 0xff]));
  game.putFile("WORDS.TOK", WORDS);
  game.putFile("OBJECT", OBJECT);
  return Object.fromEntries(game.files);
}

const ALPHA_FILES = installedGame("ALPHA CHAMBER");
const OMEGA_FILES = installedGame("OMEGA CHAMBER");

interface ServedInstance {
  folder: string;
  title: string;
  files: Record<string, Uint8Array>;
  revision: string;
}

async function instances(): Promise<{ alpha: ServedInstance; omega: ServedInstance }> {
  const alpha: ServedInstance = {
    folder: "alpha-saga",
    title: "Alpha Saga",
    files: ALPHA_FILES,
    revision: await gameRevision(ALPHA_FILES),
  };
  const omega: ServedInstance = {
    folder: "omega-saga",
    title: "Omega Saga",
    files: OMEGA_FILES,
    revision: await gameRevision(OMEGA_FILES),
  };
  return { alpha, omega };
}

function descriptor(instance: ServedInstance) {
  return {
    folder: instance.folder,
    hash: WORDS_SHA,
    alias: instance.folder,
    title: instance.title,
    wordsSha256: WORDS_SHA,
    objectSha256: OBJECT_SHA,
    revision: instance.revision,
  };
}

async function serveFixtures(page: Page, served: ServedInstance[]): Promise<void> {
  await page.route("**/fixtures/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixtures/") return route.fulfill({ json: served.map(descriptor) });
    const match = /^\/fixtures\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
    const instance = match ? served.find((g) => g.folder === match[1]) : undefined;
    if (!instance) return route.fulfill({ status: 404 });
    const file = match![2];
    if (file === undefined) return route.fulfill({ json: Object.keys(instance.files) });
    const bytes = instance.files[file];
    if (!bytes) return route.fulfill({ status: 404 });
    return route.fulfill({ body: Buffer.from(bytes), contentType: "application/octet-stream" });
  });
}

/** A raw localStorage read across all the keys this proof inspects. */
function stored(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

test("two same-dictionary installed folders checkpoint and resume on their own physical targets @webkit-desktop", async ({
  page,
}) => {
  const { alpha, omega } = await instances();
  await serveFixtures(page, [alpha, omega]);
  await isolateStorage(page);
  await page.goto("/");

  const alphaLocator = installedProgressLocator("alpha-saga", alpha.revision)!;
  const omegaLocator = installedProgressLocator("omega-saga", omega.revision)!;
  const alphaCard = page.getByTestId("local-game-card-alpha-saga");
  const omegaCard = page.getByTestId("local-game-card-omega-saga");
  await expect(alphaCard).toBeVisible();
  await expect(omegaCard).toBeVisible();

  // The first card's boot binds its own folder target before the worker
  // runs: the boot acknowledgement writes the physical resume pointer and
  // never the released lastGame spelling.
  await alphaCard.getByTestId("boot-alpha-saga").click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 30_000 })
    .toContain("ALPHA CHAMBER");
  await expect(page).toHaveURL(/#play\/alpha-saga$/);
  await expect.poll(() => stored(page, "monotio_agi.resumeTarget")).toBe(alphaLocator);
  expect(await stored(page, "monotio_agi.lastGame")).toBeNull();

  // Leaving flushes this instance's checkpoint under its own physical
  // locator — the shared WORDS.TOK spelling holds nothing.
  await waitForCycles(page, 4);
  await page.getByTestId("btn-exit").click();
  await expect(page.getByTestId("saved-game-gallery")).toBeVisible();
  await expect.poll(() => stored(page, `monotio_agi.autosave.${alphaLocator}`)).not.toBeNull();
  expect(await stored(page, `monotio_agi.autosave.${WORDS_SHA}`)).toBeNull();
  expect(await stored(page, "monotio_agi.autosave.alpha-saga")).toBeNull();

  // The sibling card boots its own bundle; its checkpoint lands under the
  // sibling's own locator and the pointer moves to it alone.
  await omegaCard.getByTestId("boot-omega-saga").click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 30_000 })
    .toContain("OMEGA CHAMBER");
  await expect(page).toHaveURL(/#play\/omega-saga$/);
  await expect.poll(() => stored(page, "monotio_agi.resumeTarget")).toBe(omegaLocator);
  const cycle = (await textHook(page)).cycle;
  await waitForAutosaveAfter(page, cycle);
  await expect.poll(() => stored(page, `monotio_agi.autosave.${omegaLocator}`)).not.toBeNull();
  expect(await stored(page, `monotio_agi.autosave.${alphaLocator}`)).not.toBeNull();
  expect(await stored(page, "monotio_agi.lastGame")).toBeNull();

  // A reload of the running game's route resumes through the physical
  // pointer: omega's own checkpoint restores (the caption is the actual
  // restore, not a fresh boot), and the sibling's record is untouched.
  await page.reload();
  await expect(page.getByTestId("resume-caption")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 30_000 })
    .toContain("OMEGA CHAMBER");
  expect(await stored(page, "monotio_agi.resumeTarget")).toBe(omegaLocator);
  expect(await stored(page, `monotio_agi.autosave.${alphaLocator}`)).not.toBeNull();

  // The other card's boot retargets the pointer to alpha's address, and a
  // reload resumes alpha's own checkpoint picture — two folders sharing a
  // vocabulary hash keep independent progress throughout.
  await page.goto("about:blank");
  await page.goto("/");
  await expect(alphaCard).toBeVisible();
  await alphaCard.getByTestId("boot-alpha-saga").click();
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 30_000 })
    .toContain("ALPHA CHAMBER");
  await expect.poll(() => stored(page, "monotio_agi.resumeTarget")).toBe(alphaLocator);
  await waitForAutosaveAfter(page, (await textHook(page)).cycle);
  await page.reload();
  await expect(page.getByTestId("resume-caption")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await textHook(page)).rows.join(" "), { timeout: 30_000 })
    .toContain("ALPHA CHAMBER");
  expect(await stored(page, "monotio_agi.resumeTarget")).toBe(alphaLocator);
  expect(await stored(page, "monotio_agi.lastGame")).toBeNull();
});
