import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { textHook } from "./engineProbe.ts";

test("1.1 progress opens automatically once @webkit-desktop", async ({ page, context }) => {
  const fixture = JSON.parse(
    await readFile(new URL("../test/fixtures/progress-v1.1.json", import.meta.url), "utf8"),
  ) as {
    local: Record<string, string>;
    records: { projectId: string; files?: Record<string, number[]> }[];
  };
  await page.route("**/fixtures/", (route) => route.fulfill({ json: [] }));
  // An inert page seeds schema 1 before the app opens its upgraded database.
  await page.goto("/favicon.svg");
  await page.evaluate(async (fixture) => {
    for (const [key, value] of Object.entries(fixture.local)) localStorage.setItem(key, value);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("monotio-agi-projects", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("projects", { keyPath: "projectId" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      for (const record of fixture.records)
        tx.objectStore("projects").put({
          ...record,
          ...(record.files
            ? {
                files: Object.fromEntries(
                  Object.entries(record.files).map(([name, bytes]) => [
                    name,
                    new Uint8Array(bytes),
                  ]),
                ),
              }
            : {}),
        });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, fixture);
  const oldTab = await context.newPage();
  await oldTab.goto("/favicon.svg");
  await page.goto("/#play/migration-probe");
  const locator = "project:migration-probe:11111111-1111-4111-8111-111111111111";
  await expect
    .poll(() =>
      page.evaluate((locator) => {
        const slots = JSON.parse(
          localStorage.getItem(`monotio_agi.saves.${encodeURIComponent(locator)}`) ?? "{}",
        );
        const map = JSON.parse(localStorage.getItem(`monotio_agi.map.${locator}`) ?? "{}");
        return { slots: Object.keys(slots.slots ?? {}), notes: map.notes ?? {} };
      }, locator),
    )
    .toEqual({ slots: ["1"], notes: { "1": "A 1.1 map note" } });
  await expect.poll(async () => (await textHook(page)).room).toBe(1);
  await expect(page.getByTestId("btn-exit")).toBeVisible();
  await page.getByTestId("btn-exit").click();
  const history = await page.evaluate(async (locator) => {
    const path = "/src/history/historyStorage.ts";
    const { loadGameHistory } = await import(/* @vite-ignore */ path);
    const history = await loadGameHistory(locator);
    return {
      segments: history.segments.map((segment: { id: string }) => segment.id),
      images: history.segments.map((segment: { boot: { image?: string } }) => segment.boot.image),
    };
  }, locator);
  expect(history.segments).toContain("s-probe.1");
  // A restored boot records its continuation image; a fresh cold boot has none.
  expect(history.images.some((image: unknown) => typeof image === "string")).toBe(true);
  expect(
    await page.evaluate(
      (local) =>
        Object.entries(local)
          .filter(([key]) => /monotio_agi\.(?:autosave|saves|map)\./.test(key))
          .every(([key, value]) => localStorage.getItem(key) === value),
      fixture.local,
    ),
  ).toBe(true);

  const before = await page.evaluate(
    (locator) => ({
      checkpoint: localStorage.getItem(`monotio_agi.autosave.${locator}`),
      map: localStorage.getItem(`monotio_agi.map.${locator}`),
    }),
    locator,
  );
  await oldTab.evaluate(() => {
    const key = "monotio_agi.autosave.migration-probe";
    const record = JSON.parse(localStorage.getItem(key)!);
    record.savedAt = 999;
    localStorage.setItem(key, JSON.stringify(record));
    const mapKey = "monotio_agi.map.migration-probe";
    localStorage.setItem(
      mapKey,
      localStorage.getItem(mapKey)!.replace("A 1.1 map note", "Old tab"),
    );
  });
  // Reopening Home exercises the completion receipt without starting a new run.
  await page.reload();
  await expect(page.getByTestId("btn-resume-cached")).toBeVisible();
  expect(
    await page.evaluate(
      (locator) => ({
        checkpoint: localStorage.getItem(`monotio_agi.autosave.${locator}`),
        map: localStorage.getItem(`monotio_agi.map.${locator}`),
      }),
      locator,
    ),
  ).toEqual(before);
  await oldTab.close();
});
