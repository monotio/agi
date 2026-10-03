/**
 * The shared Details dialog's "Earlier progress" section and the Library
 * footer's persistent link, driven against real browser storage: seeded
 * IndexedDB removal captures and released localStorage spellings, real
 * downloads asserted byte-for-byte, and the focus hand-offs around the one
 * dialog. The seeded view is read-only inspection — a seeded capture stands
 * in for the removal plumbing another task wires.
 */
import { readFileSync } from "node:fs";
import { expect, test, reviewShot } from "./test.ts";
import { blockProviders, prepareIsolatedPage, seedLocalProject } from "./logicDebugShared.ts";
import { openSavedGameDetails, savedGameCard } from "./engineProbe.ts";
import type { Page } from "@playwright/test";

/** A stored string whose whitespace and Unicode must reach the download byte-exact. */
const RAW_LOCAL = "floppy  drive\tfirst run\n«wïth» Ünïcode ✓ — 1987";

interface SeededSources {
  /** The capture's exact `legacy-progress/<source>/<id>` record key. */
  captureKey: string;
}

/**
 * Earlier storage through the app's own primitives: one removal capture with
 * a raw local string, one capture envelope of a future version, one live
 * earlier spelling with an autosave and a map, and one live spelling whose
 * IndexedDB record holds a Map — JSON-refusing data that keeps the complete
 * export partial.
 */
async function seedEarlierData(page: Page): Promise<SeededSources> {
  return page.evaluate(async (raw) => {
    const { bodyTransaction } = await import("/src/project/gameStorage.ts");
    const { newLegacyProgressRecord } = await import("/src/project/legacyProgressRecovery.ts");

    const capture = newLegacyProgressRecord(
      "disk-box",
      [{ key: "monotio_agi.autosave.disk-box", value: raw }],
      [{ key: "history/disk-box", value: { format: "x", version: 1 } }],
    );
    await bodyTransaction("readwrite", (store) => store.put(capture));
    await bodyTransaction("readwrite", (store) =>
      store.put({
        projectId: "legacy-progress/mystery/future-9",
        format: "monotio.agi.legacy-progress",
        version: 99,
        tag: "opaque",
        nested: { deep: [1, "two"] },
      }),
    );
    await bodyTransaction("readwrite", (store) =>
      store.put({
        projectId: "history/floppy-era",
        format: "monotio.agi.stored-history",
        version: 1,
      }),
    );
    await bodyTransaction("readwrite", (store) =>
      store.put({
        projectId: "history/partial-tape",
        format: "monotio.agi.stored-history",
        version: 1,
      }),
    );
    await bodyTransaction("readwrite", (store) =>
      store.put({
        projectId: "history/partial-tape/blob/deep",
        value: { nested: new Map([["kept", "in-browser"]]) },
      }),
    );

    const autosave = {
      format: "monotio.agi.autosave",
      version: 1,
      image: "AA==",
      room: 3,
      cycle: 12,
      savedAt: 1_700_000_000_000,
      game: {
        installed: false,
        identity: { project: "partial-tape", revision: "a".repeat(64) },
      },
    };
    localStorage.setItem("monotio_agi.autosave.partial-tape", JSON.stringify(autosave));
    localStorage.setItem(
      "monotio_agi.autosave.floppy-era",
      JSON.stringify({
        ...autosave,
        game: { ...autosave.game, identity: { project: "floppy-era", revision: "b".repeat(64) } },
      }),
    );
    return { captureKey: capture.projectId };
  }, RAW_LOCAL);
}

/** The exporter's exact output for the seeded capture, computed in-page. */
async function expectedCaptureExport(page: Page, captureKey: string): Promise<string> {
  return page.evaluate(async (key) => {
    const { readEarlierProgress } = await import("/src/project/earlierProgress.ts");
    const { exportEarlierProgress } = await import("/src/project/earlierProgressExport.ts");
    const read = await readEarlierProgress({ kind: "capture", recoveryId: key });
    const result = exportEarlierProgress(read);
    if (result.status !== "complete" || result.json === undefined)
      throw new Error(`expected a complete export, got ${result.status}`);
    return result.json;
  }, captureKey);
}

/** The exact local payload a refused complete export ships separately. */
async function expectedLocalExport(page: Page, source: string): Promise<string> {
  return page.evaluate(async (key) => {
    const { readEarlierProgress } = await import("/src/project/earlierProgress.ts");
    const { exportEarlierProgress } = await import("/src/project/earlierProgressExport.ts");
    const read = await readEarlierProgress({ kind: "live", legacyKey: key });
    const result = exportEarlierProgress(read);
    if (result.status !== "partial" || result.localJson === undefined)
      throw new Error(`expected a partial export with local data, got ${result.status}`);
    return result.localJson;
  }, source);
}

async function openEarlierDialog(page: Page) {
  const dialog = page.getByTestId("earlier-progress-details");
  await page.getByTestId("earlier-progress-link").click();
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  return dialog;
}

test("the footer link persists through reload and the dialog reads seeded storage @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  const { captureKey } = await seedEarlierData(page);

  // No saved cards: the link still appears, and again after a reload.
  await expect(page.getByTestId("saved-game-title")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("earlier-progress-link")).toBeVisible();
  await expect(page.getByTestId("earlier-progress-note")).toContainText(
    "Explore earlier progress saved in this browser.",
  );

  const dialog = await openEarlierDialog(page);
  // The dialog's own title is the only "Earlier progress" heading.
  await expect(dialog.getByRole("heading", { name: "Earlier progress" })).toHaveCount(1);
  const rows = dialog.getByTestId("earlier-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Saved when removed" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "From another version" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Earlier progress" })).toHaveCount(2);
  await reviewShot(page, "earlier-progress-dialog");

  // The readable capture: pinned read, exact download. Keyboard selection
  // marks the row pressed and the scroll that follows keeps its focus.
  const savedRow = rows.filter({ hasText: "Saved when removed" });
  await savedRow.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByTestId("earlier-read-title")).toHaveText("Saved when removed");
  await expect(savedRow).toHaveAttribute("aria-pressed", "true");
  await expect(rows.filter({ hasText: "From another version" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(savedRow).toBeFocused();
  await expect(dialog.getByTestId("earlier-facts")).toContainText(captureKey);
  const downloadButton = dialog.getByTestId("earlier-download");
  await expect(downloadButton).toHaveText("Download a copy");
  await expect(downloadButton).toBeInViewport();
  const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
  expect(download.suggestedFilename()).toMatch(/^earlier-progress-data-disk-box-[0-9a-f-]+\.json$/);
  const text = readFileSync(await download.path()!, "utf8");
  // Byte-exact against the exporter's own output — the raw local string's
  // whitespace and Unicode are preserved inside the JSON encoding.
  expect(text).toBe(await expectedCaptureExport(page, captureKey));
  const doc = JSON.parse(text) as { capture: { local: { key: string; value: string }[] } };
  expect(doc.capture.local).toEqual([{ key: "monotio_agi.autosave.disk-box", value: RAW_LOCAL }]);
  await expect(dialog.getByTestId("earlier-notice")).toContainText(
    "This progress stays in this browser.",
  );

  // The opaque capture stays readable as stored data and still downloads.
  await rows.filter({ hasText: "From another version" }).click();
  await expect(dialog.getByTestId("earlier-read-title")).toHaveText("From another version");
  const [opaque] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByTestId("earlier-download").click(),
  ]);
  const opaqueDoc = JSON.parse(readFileSync(await opaque.path()!, "utf8")) as {
    value: { version: number; tag: string };
  };
  expect(opaqueDoc.value.version).toBe(99);
  expect(opaqueDoc.value.tag).toBe("opaque");

  // Closing returns focus to the stable footer link.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("earlier-progress-link")).toBeFocused();
  expect(providers.count()).toBe(0);
});

test("a JSON-refusing source downloads its local strings as a labelled partial @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  await seedEarlierData(page);
  await page.reload();

  const dialog = await openEarlierDialog(page);
  const row = dialog.getByTestId("earlier-row").filter({ hasText: "partial-tape" });
  await row.click();
  await expect(dialog.getByTestId("earlier-read-title")).toHaveText("Earlier progress");
  await expect(row).toHaveAttribute("aria-pressed", "true");
  // No complete download exists for a refused export; the partial one is named.
  await expect(dialog.getByTestId("earlier-download")).toHaveCount(0);
  await expect(dialog.getByTestId("earlier-export-note")).toHaveText(
    "Part of this progress fits in a file. The rest stays in this browser.",
  );
  const partButton = dialog.getByTestId("earlier-download-local");
  await expect(partButton).toHaveText("Download part");
  await expect(partButton).toBeInViewport();

  // Exact retained keys and the exporter's diagnostic sit in a collapsed
  // disclosure: the closed body is absent from the DOM until opened.
  const stored = dialog.getByTestId("earlier-stored");
  await expect(stored).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByTestId("earlier-stored-body")).toHaveCount(0);
  await stored.click();
  await expect(stored).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByTestId("earlier-retained")).toContainText(
    "history/partial-tape/blob/deep",
  );
  await expect(dialog.getByTestId("earlier-export-detail")).toContainText(
    "A complete export was refused",
  );
  await stored.click();
  await expect(dialog.getByTestId("earlier-stored-body")).toHaveCount(0);
  await reviewShot(page, "earlier-progress-partial");

  const [download] = await Promise.all([page.waitForEvent("download"), partButton.click()]);
  expect(download.suggestedFilename()).toBe("earlier-progress-data-partial-tape-local.json");
  const text = readFileSync(await download.path()!, "utf8");
  expect(text).toBe(await expectedLocalExport(page, "partial-tape"));
  await expect(dialog.getByTestId("earlier-notice")).toContainText(
    "The rest stays in this browser.",
  );
  expect(providers.count()).toBe(0);
});

test("a saved game's Details carries the scoped section and closes to a stable control @webkit-desktop", async ({
  page,
}) => {
  await prepareIsolatedPage(page);
  const providers = blockProviders(page);
  await page.goto("/");
  await seedEarlierData(page);
  const projectId = await seedLocalProject(page, "Detour Adventure");
  await page.reload();

  const card = savedGameCard(page, "Detour Adventure");
  await expect(card).toBeVisible();
  const dialog = await openSavedGameDetails(card);
  const section = dialog.getByTestId("earlier-progress");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "Earlier progress" })).toBeVisible();
  // The game's own earlier spelling is the scoped read context.
  await expect(section.getByTestId("earlier-row").filter({ hasText: projectId })).toBeVisible();
  await reviewShot(page, "earlier-progress-details");

  // Browse widens the same section to every earlier source.
  await section.getByTestId("earlier-browse-all").click();
  await expect(
    section.getByTestId("earlier-row").filter({ hasText: "Saved when removed" }),
  ).toBeVisible();

  // Escaping returns focus to the card's ⋯ trigger.
  const trigger = card.getByRole("button", { name: "Game actions", exact: true });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  // With the opener gone — as after a removal — focus lands on the stable
  // footer link instead of the detached element.
  await openSavedGameDetails(card);
  await trigger.evaluate((el) => el.remove());
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("earlier-progress-link")).toBeFocused();
  expect(providers.count()).toBe(0);
});
