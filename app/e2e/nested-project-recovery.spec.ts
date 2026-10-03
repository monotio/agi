import { readFile } from "node:fs/promises";
import { testProjectId } from "../test/identity.ts";
import { decodeJournalValue } from "../src/project/projectJournalCapture.ts";
import { isolateStorage } from "./engineProbe.ts";
import { expect, test } from "./test.ts";

for (const state of ["unsupported", "corrupt"] as const) {
  test(`${state} nested History offers recovery beside a readable project`, async ({ page }) => {
    await isolateStorage(page);
    await page.goto("/");
    const id = testProjectId(`nested-history-${state}`);
    const valid = testProjectId(`readable-${state}`);
    const before = await page.evaluate(
      async ({ id, valid, state }) => {
        const storage = await import("/src/project/gameStorage.ts");
        const codec = await import("/src/project/projectJournalCapture.ts");
        const input = {
          title: "History adventure",
          files: { "WORDS.TOK": new Uint8Array([0, 128, 255]) },
          words: [],
        };
        await storage.saveAuthoredGame(id, input);
        await storage.saveAuthoredGame(valid, { ...input, title: "Readable adventure" });
        await storage.bodyTransaction("readwrite", (store) => {
          const request = store.get(id);
          request.onsuccess = () => {
            store.put({
              ...request.result,
              editHistory: {
                format: "monotio.agi.project-history",
                version: state === "unsupported" ? 999 : 1,
                blobs: "future layout",
              },
            });
            store.put({
              projectId: `project-history/${id}/future/blob`,
              version: 999,
              content: new Uint8Array([7, 0, 255]),
            });
          };
          return request;
        });
        const raw = await storage.bodyTransaction("readonly", (store) => store.get(id));
        return codec.encodeJournalValue(raw);
      },
      { id, valid, state },
    );
    await page.goto("/");
    const card = page.getByTestId(`unsupported-project-card-${id}`);
    await expect(card.getByRole("heading")).toHaveText("History adventure");
    await expect(card).toContainText(
      state === "unsupported"
        ? "Saved by a newer version of AGI IS HERE"
        : "Saved project needs recovery",
    );
    await expect(
      page.getByRole("heading", { name: "Readable adventure", exact: true }),
    ).toBeVisible();
    const pending = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download", exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(`${id}-stored-project.json`);
    const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(exported.record).toEqual(before);
    expect(decodeJournalValue(exported.records)).toEqual([
      {
        key: `project-history/${id}/future/blob`,
        value: {
          projectId: `project-history/${id}/future/blob`,
          version: 999,
          content: new Uint8Array([7, 0, 255]),
        },
      },
    ]);
    await page.screenshot({
      path: test.info().outputPath(`${state}-recovery.png`),
      fullPage: true,
    });
    await card.getByRole("button", { name: "Remove", exact: true }).click();
    await card.getByTestId("remove-game-confirm").click();
    await expect(card).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Readable adventure", exact: true }),
    ).toBeVisible();
  });
}
